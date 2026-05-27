const fs = require('fs/promises');
const RestoreJob = require('../../models/restaurant/RestoreJob');
const MigrationLog = require('../../models/restaurant/MigrationLog');
const RestoreSnapshot = require('../../models/restaurant/RestoreSnapshot');
const RestoreAudit = require('../../models/restaurant/RestoreAudit');
const BackupRecord = require('../../models/restaurant/BackupRecord');
const { emitToRestaurant } = require('../socketService');
const { loadBackupPayload } = require('./backupFormat');
const { runMigrationRestore, buildPreviewSummary } = require('./migrationEngine');
const { assertRestoreOtpVerified } = require('./restoreOtpService');
const backupService = require('../backupService');

async function writeAudit(req, action, details = {}) {
  await RestoreAudit.create({
    restaurantId: req.user?.restaurantId || req.user?.id,
    action,
    actorId: req.user?.employeeId || req.user?.id,
    actorModel:
      req.user?.scope === 'branch_user' ? 'BranchAuth' : req.user?.scope === 'employee' ? 'Employee' : 'Restaurant',
    resourceType: 'restore_job',
    resourceId: details.restoreJobId,
    details,
    ipAddress: req.ip || '',
    userAgent: req.get?.('User-Agent') || '',
  });
}

function emitProgress(restaurantId, jobId, progress) {
  emitToRestaurant(restaurantId, 'backup:restore_progress', { jobId: String(jobId), ...progress });
}

async function loadPayloadForJob(job, bufferFromUpload) {
  if (bufferFromUpload) return loadBackupPayload(bufferFromUpload);
  if (job.backupRecordId) {
    const record = await BackupRecord.findById(job.backupRecordId).select('+storagePath');
    if (!record?.storagePath) throw new Error('Backup file not found');
    return loadBackupPayload(await fs.readFile(record.storagePath));
  }
  throw new Error('No backup source for restore job');
}

async function processRestoreJob(jobId, req, { buffer, otpId } = {}) {
  const job = await RestoreJob.findById(jobId);
  if (!job) throw new Error('Restore job not found');
  if (job.status === 'cancelled') throw new Error('Restore job was cancelled');

  const needsOtp = ['replace', 'migration', 'full'].includes(job.mode);
  if (needsOtp) {
    await assertRestoreOtpVerified(req, {
      purpose: job.mode === 'migration' ? 'migration' : 'restore',
      otpId: otpId || req.body?.otpId,
    });
  }

  const startedAt = Date.now();
  job.status = 'running';
  job.startedAt = new Date();
  await job.save();

  const migrationLog = await MigrationLog.create({
    restaurantId: job.restaurantId,
    restoreJobId: job._id,
    backupRecordId: job.backupRecordId,
    sourceRestaurantId: job.sourceRestaurantId,
    targetRestaurantId: job.targetRestaurantId,
    targetBranchId: job.targetBranchId,
    mode: job.mode,
    status: 'running',
    requestedBy: job.requestedBy,
    requestedByModel: job.requestedByModel,
    ipAddress: job.ipAddress,
    userAgent: job.userAgent,
  });

  job.migrationLogId = migrationLog._id;
  await job.save();

  try {
    let snapshotRecord = null;
    if (job.mode !== 'migration') {
      emitProgress(job.restaurantId, job._id, { percent: 2, currentLabel: 'Creating safety snapshot...', currentStep: 'snapshot' });
      snapshotRecord = await backupService.createBackup(req, {
        restaurantId: job.targetRestaurantId,
        branchId: job.targetBranchId,
        type: 'snapshot',
        label: 'Pre-restore snapshot',
      });
      const snap = await RestoreSnapshot.create({
        restaurantId: job.targetRestaurantId,
        branchId: job.targetBranchId,
        backupRecordId: snapshotRecord._id,
        restoreJobId: job._id,
        label: 'Emergency snapshot before restore',
      });
      job.snapshotId = snap._id;
      await job.save();
    }

    const payload = await loadPayloadForJob(job, buffer);
    migrationLog.checksum = payload.checksum;
    migrationLog.backupVersion = payload.manifest?.backupVersion;
    migrationLog.schemaVersion = payload.manifest?.schemaVersion;
    migrationLog.sourceRestaurantId = payload.metadata?.restaurantId || payload.manifest?.restaurantId;
    await migrationLog.save();

    const result = await runMigrationRestore(req, payload, {
      targetRestaurantId: job.targetRestaurantId,
      targetBranchId: job.targetBranchId,
      mode: job.mode === 'partial' ? 'partial' : job.mode,
      sections: job.sections,
      partialGroups: job.sections,
      conflictStrategy: job.conflictStrategy,
      branchName: req.body?.branchName,
      actorId: job.requestedBy,
      actorModel: job.requestedByModel,
      onProgress: (p) => {
        job.progress = p;
        job.save().catch(() => {});
        emitProgress(job.restaurantId, job._id, p);
      },
    });

    job.status = 'completed';
    job.completedAt = new Date();
    job.restoredCounts = result.restoredCounts;
    job.conflicts = result.conflicts;
    job.warnings = result.warnings;
    job.progress = { percent: 100, currentStep: 'complete', currentLabel: 'Restore complete', stepsCompleted: 1, stepsTotal: 1 };
    await job.save();

    migrationLog.status = 'completed';
    migrationLog.restoredCounts = result.restoredCounts;
    migrationLog.modifiedCollections = result.modifiedCollections;
    migrationLog.idMapSummary = result.idMapSummary;
    migrationLog.durationMs = Date.now() - startedAt;
    migrationLog.warnings = result.warnings;
    await migrationLog.save();

    await writeAudit(req, 'restore_complete', {
      restoreJobId: job._id,
      mode: job.mode,
      restoredCounts: result.restoredCounts,
    });

    emitToRestaurant(job.restaurantId, 'backup:restore_complete', {
      jobId: String(job._id),
      restoredCounts: result.restoredCounts,
      visibleCounts: result.visibleCounts,
    });

    return { job, migrationLog, result, snapshotId: snapshotRecord?._id };
  } catch (err) {
    job.status = 'failed';
    job.failureReason = err.message;
    job.completedAt = new Date();
    await job.save();

    migrationLog.status = 'failed';
    migrationLog.failureReason = err.message;
    migrationLog.durationMs = Date.now() - startedAt;
    await migrationLog.save();

    await writeAudit(req, 'restore_failed', { restoreJobId: job._id, message: err.message });
    emitToRestaurant(job.restaurantId, 'backup:restore_failed', { jobId: String(job._id), message: err.message });
    throw err;
  }
}

module.exports = {
  processRestoreJob,
  buildPreviewSummary,
  writeAudit,
};
