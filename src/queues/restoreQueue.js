const { logger } = require('../utils/logger');
const RestoreJob = require('../models/restaurant/RestoreJob');

let queue = null;
let useBull = false;

function redisConfigured() {
  return Boolean(process.env.REDIS_URL || process.env.REDIS_HOST);
}

async function initRestoreQueue() {
  if (!redisConfigured()) {
    logger.info('Restore queue: Redis not configured — using in-process job runner');
    return null;
  }

  try {
    const { Queue, Worker } = require('bullmq');
    const IORedis = require('ioredis');
    const connection = new IORedis(process.env.REDIS_URL || {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT || 6379),
      maxRetriesPerRequest: null,
    });

    queue = new Queue('backup-restore', {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    });

    const worker = new Worker(
      'backup-restore',
      async (bullJob) => {
        const { jobId, reqSnapshot, bufferBase64, otpId } = bullJob.data;
        const { processRestoreJob } = require('../services/backup/restoreJobProcessor');
        const buffer = bufferBase64 ? Buffer.from(bufferBase64, 'base64') : null;
        const req = {
          user: reqSnapshot.user,
          body: reqSnapshot.body || {},
          branchId: reqSnapshot.branchId,
          ip: reqSnapshot.ip,
          get: (h) => reqSnapshot.headers?.[h.toLowerCase()],
        };
        return processRestoreJob(jobId, req, { buffer, otpId });
      },
      { connection, concurrency: Number(process.env.RESTORE_WORKER_CONCURRENCY || 2) },
    );

    worker.on('failed', (job, err) => {
      logger.error('Restore worker job %s failed: %s', job?.id, err.message);
    });

    useBull = true;
    logger.info('Restore queue: BullMQ worker started');
    return queue;
  } catch (err) {
    logger.warn('Restore queue: BullMQ unavailable (%s) — in-process fallback', err.message);
    return null;
  }
}

async function enqueueRestoreJob(jobId, req, { buffer, otpId } = {}) {
  const reqSnapshot = {
    user: {
      id: req.user?.id,
      restaurantId: req.user?.restaurantId,
      employeeId: req.user?.employeeId,
      role: req.user?.role,
      scope: req.user?.scope,
    },
    body: req.body,
    branchId: req.branchId,
    ip: req.ip,
    headers: { 'user-agent': req.get?.('User-Agent') },
  };

  if (queue && useBull) {
    const bullJob = await queue.add(
      'restore',
      {
        jobId: String(jobId),
        reqSnapshot,
        bufferBase64: buffer ? buffer.toString('base64') : null,
        otpId,
      },
      { jobId: `restore-${jobId}` },
    );
    await RestoreJob.findByIdAndUpdate(jobId, { bullJobId: String(bullJob.id), status: 'queued' });
    return { queued: true, bullJobId: bullJob.id };
  }

  const { processRestoreJob } = require('../services/backup/restoreJobProcessor');
  setImmediate(() => {
    processRestoreJob(jobId, req, { buffer, otpId }).catch((err) => {
      logger.error('In-process restore job %s failed: %s', jobId, err.message);
    });
  });
  return { queued: true, inProcess: true };
}

async function cancelRestoreJob(jobId) {
  const job = await RestoreJob.findById(jobId);
  if (!job) throw new Error('Job not found');
  if (['completed', 'failed', 'cancelled'].includes(job.status)) {
    throw new Error(`Cannot cancel job in status ${job.status}`);
  }
  job.status = 'cancelled';
  job.cancelledAt = new Date();
  await job.save();

  if (queue && job.bullJobId) {
    try {
      const bullJob = await queue.getJob(job.bullJobId);
      if (bullJob) await bullJob.remove();
    } catch {
      /* ignore */
    }
  }
  return job;
}

module.exports = {
  initRestoreQueue,
  enqueueRestoreJob,
  cancelRestoreJob,
};
