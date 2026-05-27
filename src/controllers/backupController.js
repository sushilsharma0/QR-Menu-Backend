const asyncHandler = require('express-async-handler');
const fs = require('fs/promises');
const path = require('path');
const BackupRecord = require('../models/restaurant/BackupRecord');
const BackupSchedule = require('../models/restaurant/BackupSchedule');
const RestoreLog = require('../models/restaurant/RestoreLog');
const RestoreJob = require('../models/restaurant/RestoreJob');
const MigrationLog = require('../models/restaurant/MigrationLog');
const RestoreSnapshot = require('../models/restaurant/RestoreSnapshot');
const RestoreAudit = require('../models/restaurant/RestoreAudit');
const AuditLog = require('../models/platform/AuditLog');
const resolveRestaurantId = require('../middleware/restaurant/resolveRestaurantId');
const { success, error } = require('../utils/apiResponse');
const backupService = require('../services/backupService');
const { requestRestoreOtp, verifyRestoreOtp } = require('../services/backup/restoreOtpService');
const { enqueueRestoreJob, cancelRestoreJob } = require('../queues/restoreQueue');
const { writeAudit, buildPreviewSummary } = require('../services/backup/restoreJobProcessor');
const { PARTIAL_RESTORE_GROUPS, CONFLICT_STRATEGIES } = require('../constants/backupConstants');

function actorId(req) {
  return req.user?.employeeId || req.user?.id;
}

function actorModel(req) {
  return req.user?.scope === 'branch_user' ? 'BranchAuth' : req.user?.scope === 'employee' ? 'Employee' : 'Restaurant';
}

function ensureBackupAdmin(req, res) {
  const allowed =
    req.user?.role === 'restaurant' ||
    req.user?.role === 'super_admin' ||
    req.user?.role === 'admin' ||
    (req.user?.scope === 'branch_user' && req.user?.role === 'branch_admin');
  if (!allowed) {
    error(res, 'Only restaurant owners, branch admins, and platform admins can access backups', 403);
    return false;
  }
  return true;
}

function parseSections(body) {
  if (Array.isArray(body.sections)) return body.sections;
  if (typeof body.sections === 'string') {
    try {
      return JSON.parse(body.sections);
    } catch {
      return body.sections.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
}

function parsePartialGroups(body) {
  if (Array.isArray(body.partialGroups)) return body.partialGroups;
  if (typeof body.partialGroups === 'string') {
    try {
      return JSON.parse(body.partialGroups);
    } catch {
      return body.partialGroups.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return parseSections(body);
}

const createBackup = asyncHandler(async (req, res) => {
  if (!ensureBackupAdmin(req, res)) return;
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const type = req.body.type || 'full';
  if (!['full', 'partial', 'incremental', 'snapshot'].includes(type)) {
    return error(res, 'Invalid backup type', 400);
  }
  const record = await backupService.createBackup(req, {
    restaurantId: rid,
    branchId: req.body.branchId || req.branchId || null,
    type,
    sections: parseSections(req.body),
    label: req.body.label || '',
    storageProvider: req.body.storageProvider || 'local',
    since: req.body.since,
  });
  const token = backupService.signedDownloadToken(record);
  const safeRecord = record.toObject();
  delete safeRecord.storagePath;
  return success(
    res,
    {
      backup: safeRecord,
      downloadUrl: `/api/restaurant/backup/download/${record._id}?token=${token}`,
    },
    'Backup created',
    201,
  );
});

const getBackupHistory = asyncHandler(async (req, res) => {
  if (!ensureBackupAdmin(req, res)) return;
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const backups = await BackupRecord.find({ restaurantId: rid, status: { $ne: 'deleted' } })
    .sort({ createdAt: -1 })
    .limit(100);
  const schedules = await BackupSchedule.find({ restaurantId: rid }).sort({ nextRunAt: 1 });
  const restores = await RestoreLog.find({ restaurantId: rid }).sort({ createdAt: -1 }).limit(25);
  const jobs = await RestoreJob.find({ restaurantId: rid }).sort({ createdAt: -1 }).limit(25);
  const migrations = await MigrationLog.find({ restaurantId: rid }).sort({ createdAt: -1 }).limit(25);
  const snapshots = await RestoreSnapshot.find({ restaurantId: rid, status: 'active' }).sort({ createdAt: -1 }).limit(10);
  const audits = await RestoreAudit.find({ restaurantId: rid }).sort({ createdAt: -1 }).limit(50);
  return success(
    res,
    { backups, schedules, restores, jobs, migrations, snapshots, audits, partialGroups: PARTIAL_RESTORE_GROUPS, conflictStrategies: CONFLICT_STRATEGIES },
    'Backup dashboard data retrieved',
  );
});

const downloadBackup = asyncHandler(async (req, res) => {
  if (!ensureBackupAdmin(req, res)) return;
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const record = await BackupRecord.findOne({ _id: req.params.id, restaurantId: rid, status: 'completed' }).select('+storagePath');
  if (!record) return error(res, 'Backup not found', 404);
  if (req.query.token && !backupService.verifyDownloadToken(record, req.query.token)) {
    return error(res, 'Invalid or expired download token', 403);
  }
  const root = backupService.backupRoot();
  const resolved = path.resolve(record.storagePath);
  if (!resolved.startsWith(root)) return error(res, 'Invalid backup storage path', 500);
  await writeAudit(req, 'backup_download', { resourceId: record._id, backupId: String(record._id) });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${record.downloadName || `backup-${record._id}.qrbackup`}"`,
  );
  return res.send(await fs.readFile(resolved));
});

const downloadBackupWithToken = asyncHandler(async (req, res, next) => {
  if (!req.query.token) return next();
  const record = await BackupRecord.findOne({ _id: req.params.id, status: 'completed' }).select('+storagePath');
  if (!record) return error(res, 'Backup not found', 404);
  if (!backupService.verifyDownloadToken(record, req.query.token)) {
    return error(res, 'Invalid or expired download token', 403);
  }
  const root = backupService.backupRoot();
  const resolved = path.resolve(record.storagePath);
  if (!resolved.startsWith(root)) return error(res, 'Invalid backup storage path', 500);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${record.downloadName || `backup-${record._id}.qrbackup`}"`);
  return res.send(await fs.readFile(resolved));
});

const deleteBackup = asyncHandler(async (req, res) => {
  if (!ensureBackupAdmin(req, res)) return;
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const record = await BackupRecord.findOne({ _id: req.params.id, restaurantId: rid }).select('+storagePath');
  if (!record) return error(res, 'Backup not found', 404);
  record.status = 'deleted';
  await record.save();
  if (record.storagePath) await fs.unlink(record.storagePath).catch(() => {});
  await writeAudit(req, 'backup_delete', { resourceId: record._id });
  return success(res, null, 'Backup deleted');
});

async function loadBufferFromRequest(req, rid) {
  if (req.body.backupId) {
    const record = await BackupRecord.findOne({ _id: req.body.backupId, restaurantId: rid, status: 'completed' }).select('+storagePath');
    if (!record) throw new Error('Backup not found');
    return { buffer: await fs.readFile(record.storagePath), backupRecordId: record._id };
  }
  if (req.file?.buffer) return { buffer: req.file.buffer, backupRecordId: null };
  throw new Error('backupId or backup file is required');
}

const validateBackup = asyncHandler(async (req, res) => {
  if (!ensureBackupAdmin(req, res)) return;
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  try {
    const { buffer } = await loadBufferFromRequest(req, rid);
    const result = await backupService.validateBackupBuffer(buffer, { expectedRestaurantId: rid });
    await writeAudit(req, 'backup_validate', { valid: true, crossTenant: result.payload.crossTenant });
    return success(res, result, 'Backup validated successfully');
  } catch (err) {
    await writeAudit(req, 'backup_validate', { valid: false, message: err.message });
    return error(res, err.message, 400);
  }
});

const previewBackup = asyncHandler(async (req, res) => {
  if (!ensureBackupAdmin(req, res)) return;
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  try {
    const { buffer, backupRecordId } = await loadBufferFromRequest(req, rid);
    const { preview, payload } = await backupService.validateBackupBuffer(buffer, { expectedRestaurantId: rid });
    if (req.body.savePreviewLog !== false) {
      await RestoreLog.create({
        restaurantId: rid,
        branchId: req.branchId || null,
        backupRecordId,
        requestedBy: actorId(req),
        requestedByModel: actorModel(req),
        mode: req.body.mode || 'merge',
        status: 'previewed',
        sourceRestaurantId: payload.metadata?.restaurantId,
        targetRestaurantId: rid,
        preview,
        checksum: payload.checksum,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      });
    }
    await writeAudit(req, 'backup_preview', { backupRecordId });
    return success(res, preview, 'Backup preview generated');
  } catch (err) {
    return error(res, err.message, 400);
  }
});

const requestOtp = asyncHandler(async (req, res) => {
  if (!ensureBackupAdmin(req, res)) return;
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const purpose = req.body.purpose || 'restore';
  const result = await requestRestoreOtp(req, { purpose });
  await writeAudit(req, 'restore_otp_request', { purpose, otpId: result.otpId });
  return success(res, { otpId: result.otpId, expiresAt: result.expiresAt, emailSent: result.emailSent }, 'Verification code sent');
});

const confirmOtp = asyncHandler(async (req, res) => {
  if (!ensureBackupAdmin(req, res)) return;
  if (!req.body.otp) return error(res, 'OTP is required', 400);
  try {
    const result = await verifyRestoreOtp(req, { otp: req.body.otp, purpose: req.body.purpose || 'restore' });
    await writeAudit(req, 'restore_otp_verified', { otpId: result.otpId });
    return success(res, result, 'Verification successful');
  } catch (err) {
    return error(res, err.message, 400);
  }
});

const startRestore = asyncHandler(async (req, res) => {
  if (!ensureBackupAdmin(req, res)) return;
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);

  const mode = req.body.mode || 'merge';
  const allowedModes = ['full', 'partial', 'merge', 'replace', 'migration', 'create_new_branch'];
  if (!allowedModes.includes(mode)) return error(res, 'Invalid restore mode', 400);

  const conflictStrategy = req.body.conflictStrategy || 'rename';
  if (!CONFLICT_STRATEGIES.includes(conflictStrategy)) return error(res, 'Invalid conflict strategy', 400);

  let buffer = null;
  let backupRecordId = null;
  try {
    const loaded = await loadBufferFromRequest(req, rid);
    buffer = loaded.buffer;
    backupRecordId = loaded.backupRecordId;
  } catch (err) {
    return error(res, err.message, 400);
  }

  let payload;
  try {
    const validated = await backupService.validateBackupBuffer(buffer);
    payload = validated.payload;
  } catch (err) {
    return error(res, err.message, 400);
  }

  const targetRestaurantId = mode === 'migration' && req.body.targetRestaurantId
    ? String(req.body.targetRestaurantId)
    : String(rid);

  const job = await RestoreJob.create({
    restaurantId: rid,
    branchId: req.branchId || null,
    backupRecordId,
    requestedBy: actorId(req),
    requestedByModel: actorModel(req),
    mode,
    status: 'queued',
    sections: mode === 'partial' ? parsePartialGroups(req.body) : parseSections(req.body),
    conflictStrategy,
    sourceRestaurantId: payload.metadata?.restaurantId,
    targetRestaurantId,
    targetBranchId: req.body.targetBranchId || req.branchId || null,
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
    deviceInfo: { userAgent: req.get('User-Agent') },
  });

  await writeAudit(req, 'restore_start', { restoreJobId: job._id, mode });

  const queueResult = await enqueueRestoreJob(job._id, req, {
    buffer,
    otpId: req.body.otpId,
  });

  return success(
    res,
    { job, queued: queueResult.queued, inProcess: queueResult.inProcess },
    'Restore job queued',
    202,
  );
});

const getRestoreJob = asyncHandler(async (req, res) => {
  if (!ensureBackupAdmin(req, res)) return;
  const rid = resolveRestaurantId(req);
  const job = await RestoreJob.findOne({ _id: req.params.jobId, restaurantId: rid });
  if (!job) return error(res, 'Restore job not found', 404);
  return success(res, job, 'Restore job status');
});

const cancelRestore = asyncHandler(async (req, res) => {
  if (!ensureBackupAdmin(req, res)) return;
  const rid = resolveRestaurantId(req);
  const job = await RestoreJob.findOne({ _id: req.params.jobId, restaurantId: rid });
  if (!job) return error(res, 'Restore job not found', 404);
  const cancelled = await cancelRestoreJob(job._id);
  await writeAudit(req, 'restore_cancel', { restoreJobId: job._id });
  return success(res, cancelled, 'Restore job cancelled');
});

const restoreBackup = asyncHandler(async (req, res) => {
  if (req.body.async === true || req.body.async === 'true') {
    return startRestore(req, res);
  }
  if (!ensureBackupAdmin(req, res)) return;
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  try {
    const { buffer, backupRecordId } = await loadBufferFromRequest(req, rid);
    const { payload } = await backupService.validateBackupBuffer(buffer);
    if (req.body.previewOnly === true || req.body.previewOnly === 'true') {
      const preview = buildPreviewSummary(payload);
      return success(res, preview, 'Restore preview generated');
    }
    const log = await backupService.restorePayload(req, payload, {
      backupRecordId,
      mode: req.body.mode || 'merge',
      targetRestaurantId: rid,
      targetBranchId: req.body.targetBranchId || req.branchId || null,
      branchName: req.body.branchName,
      conflictStrategy: req.body.conflictStrategy || 'rename',
      partialGroups: parsePartialGroups(req.body),
    });
    return success(res, log, 'Backup restored');
  } catch (err) {
    return error(res, err.message, err.message.includes('Cross-tenant') || err.message.includes('migration') ? 403 : 400);
  }
});

const saveSchedule = asyncHandler(async (req, res) => {
  if (!ensureBackupAdmin(req, res)) return;
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const frequency = req.body.frequency || 'daily';
  if (!['daily', 'weekly', 'monthly'].includes(frequency)) return error(res, 'Invalid backup frequency', 400);
  const row = await BackupSchedule.findOneAndUpdate(
    { restaurantId: rid, branchId: req.body.branchId || req.branchId || null },
    {
      restaurantId: rid,
      branchId: req.body.branchId || req.branchId || null,
      createdBy: actorId(req),
      createdByModel: actorModel(req),
      frequency,
      backupType: req.body.backupType || 'snapshot',
      includedSections: parseSections(req.body),
      storageProvider: req.body.storageProvider || 'local',
      retentionPolicy: req.body.retentionPolicy || {
        dailyDays: Number(req.body.retentionDaily || 7),
        weeklyDays: Number(req.body.retentionWeekly || 31),
        monthlyDays: Number(req.body.retentionMonthly || 366),
      },
      nextRunAt: req.body.nextRunAt ? new Date(req.body.nextRunAt) : backupService.nextRunDate(frequency, new Date()),
      isActive: req.body.isActive !== false,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  await writeAudit(req, 'schedule_update', { scheduleId: row._id, frequency });
  return success(res, row, 'Backup schedule saved');
});

const cloneBranch = asyncHandler(async (req, res) => {
  if (!ensureBackupAdmin(req, res)) return;
  if (!req.body.sourceBranchId) return error(res, 'sourceBranchId is required', 400);
  try {
    const result = await backupService.cloneBranch(req, {
      sourceBranchId: req.body.sourceBranchId,
      branchName: req.body.branchName,
    });
    return success(res, result, 'Branch cloned', 201);
  } catch (err) {
    return error(res, err.message, 400);
  }
});

const rollbackRestore = asyncHandler(async (req, res) => {
  if (!ensureBackupAdmin(req, res)) return;
  const rid = resolveRestaurantId(req);
  const snapshot = await RestoreSnapshot.findOne({ _id: req.params.snapshotId, restaurantId: rid, status: 'active' }).populate('backupRecordId');
  if (!snapshot?.backupRecordId) return error(res, 'Snapshot not found', 404);
  req.body.backupId = String(snapshot.backupRecordId._id || snapshot.backupRecordId);
  req.body.mode = 'replace';
  req.body.async = 'true';
  return startRestore(req, res);
});

module.exports = {
  createBackup,
  getBackupHistory,
  downloadBackupWithToken,
  downloadBackup,
  deleteBackup,
  validateBackup,
  previewBackup,
  requestOtp,
  confirmOtp,
  startRestore,
  getRestoreJob,
  cancelRestore,
  restoreBackup,
  saveSchedule,
  cloneBranch,
  rollbackRestore,
};
