const mongoose = require('mongoose');

const migrationLogSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    restoreJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'RestoreJob', default: null, index: true },
    backupRecordId: { type: mongoose.Schema.Types.ObjectId, ref: 'BackupRecord', default: null },
    sourceRestaurantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    targetRestaurantId: { type: mongoose.Schema.Types.ObjectId, required: true },
    targetBranchId: { type: mongoose.Schema.Types.ObjectId, default: null },
    mode: { type: String, required: true },
    status: { type: String, enum: ['running', 'completed', 'failed', 'rolled_back'], default: 'running', index: true },
    idMapSummary: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    modifiedCollections: { type: [String], default: [] },
    restoredCounts: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    checksum: { type: String, default: '' },
    backupVersion: { type: String, default: '' },
    schemaVersion: { type: String, default: '' },
    durationMs: { type: Number, default: 0 },
    failureReason: { type: String, default: '' },
    warnings: { type: [String], default: [] },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'requestedByModel' },
    requestedByModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth', 'Admin'] },
    ipAddress: { type: String, default: '' },
    userAgent: { type: String, default: '' },
  },
  { timestamps: true },
);

migrationLogSchema.index({ restaurantId: 1, createdAt: -1 });

module.exports = mongoose.model('MigrationLog', migrationLogSchema);
