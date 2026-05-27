const fs = require('fs/promises');
const path = require('path');
const { logger } = require('../../utils/logger');

function providerEnabled(name) {
  if (name === 's3') return Boolean(process.env.AWS_S3_BACKUP_BUCKET && process.env.AWS_ACCESS_KEY_ID);
  if (name === 'gcs') return Boolean(process.env.GCS_BACKUP_BUCKET);
  if (name === 'backblaze') return Boolean(process.env.B2_BACKUP_BUCKET);
  if (name === 'cloudinary') return Boolean(process.env.CLOUDINARY_CLOUD_NAME);
  return true;
}

async function uploadLocal(filePath, { restaurantId, filename }) {
  return {
    provider: 'local',
    path: filePath,
    url: null,
    key: filename,
    restaurantId: String(restaurantId),
  };
}

async function uploadS3(filePath, { restaurantId, filename }) {
  if (!providerEnabled('s3')) {
    logger.warn('S3 backup upload skipped: credentials not configured');
    return uploadLocal(filePath, { restaurantId, filename });
  }
  // Production: wire @aws-sdk/client-s3 PutObjectCommand
  const key = `backups/${restaurantId}/${filename}`;
  logger.info('S3 backup upload queued (stub): %s', key);
  return { provider: 's3', key, path: filePath, syncStatus: 'pending_configuration' };
}

async function uploadToCloud(filePath, options = {}) {
  const provider = options.storageProvider || process.env.BACKUP_CLOUD_PROVIDER || 'local';
  if (provider === 's3') return uploadS3(filePath, options);
  return uploadLocal(filePath, options);
}

async function downloadFromCloud(record) {
  if (record.storageProvider === 'local' || !record.cloudKey) {
    return fs.readFile(record.storagePath);
  }
  throw new Error(`Cloud download for ${record.storageProvider} is not configured on this server`);
}

module.exports = {
  uploadToCloud,
  downloadFromCloud,
  providerEnabled,
};
