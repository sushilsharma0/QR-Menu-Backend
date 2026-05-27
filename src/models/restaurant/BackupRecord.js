const mongoose = require('mongoose');

const backupRecordSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'createdByModel', required: true },
    createdByModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth', 'Admin'], required: true },
    type: {
      type: String,
      enum: ['full', 'partial', 'incremental', 'snapshot', 'scheduled', 'branch_clone'],
      default: 'full',
      index: true,
    },
    status: {
      type: String,
      enum: ['queued', 'running', 'completed', 'failed', 'deleted'],
      default: 'queued',
      index: true,
    },
    label: { type: String, default: '' },
    includedSections: { type: [String], default: [] },
    backupVersion: { type: String, default: '1.0.0' },
    appVersion: { type: String, default: '' },
    schemaVersion: { type: String, default: '1' },
    storageProvider: { type: String, enum: ['local', 's3', 'backblaze', 'gcs'], default: 'local' },
    storagePath: { type: String, default: '', select: false },
    downloadName: { type: String, default: '' },
    checksum: { type: String, default: '' },
    manifestSignature: { type: String, default: '' },
    encrypted: { type: Boolean, default: true },
    size: { type: Number, default: 0 },
    documentCount: { type: Number, default: 0 },
    collectionCounts: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    incrementalSince: { type: Date, default: null },
    expiresAt: { type: Date, default: null, index: true },
    verifiedAt: { type: Date, default: null },
    verificationReport: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    failureReason: { type: String, default: '' },
  },
  { timestamps: true },
);

backupRecordSchema.index({ restaurantId: 1, createdAt: -1 });
backupRecordSchema.index({ restaurantId: 1, type: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('BackupRecord', backupRecordSchema);
