const mongoose = require('mongoose');

const restoreLogSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    backupRecordId: { type: mongoose.Schema.Types.ObjectId, ref: 'BackupRecord', default: null, index: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'requestedByModel', required: true },
    requestedByModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth', 'Admin'], required: true },
    mode: { type: String, enum: ['merge', 'replace', 'create_new_branch', 'clone_restaurant'], required: true },
    status: { type: String, enum: ['previewed', 'running', 'completed', 'failed', 'rolled_back'], default: 'running', index: true },
    sourceRestaurantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    targetRestaurantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    targetBranchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    idMapSummary: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    restoredCounts: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    preview: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    checksum: { type: String, default: '' },
    failureReason: { type: String, default: '' },
    ipAddress: { type: String, default: '' },
    userAgent: { type: String, default: '' },
  },
  { timestamps: true },
);

restoreLogSchema.index({ restaurantId: 1, createdAt: -1 });

module.exports = mongoose.model('RestoreLog', restoreLogSchema);
