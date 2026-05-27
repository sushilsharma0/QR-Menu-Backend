const mongoose = require('mongoose');

const restoreJobSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    backupRecordId: { type: mongoose.Schema.Types.ObjectId, ref: 'BackupRecord', default: null },
    migrationLogId: { type: mongoose.Schema.Types.ObjectId, ref: 'MigrationLog', default: null },
    snapshotId: { type: mongoose.Schema.Types.ObjectId, ref: 'RestoreSnapshot', default: null },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'requestedByModel', required: true },
    requestedByModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth', 'Admin'], required: true },
    mode: {
      type: String,
      enum: ['full', 'partial', 'merge', 'replace', 'migration', 'create_new_branch', 'branch_clone'],
      required: true,
    },
    status: {
      type: String,
      enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
      default: 'queued',
      index: true,
    },
    sections: { type: [String], default: [] },
    conflictStrategy: { type: String, enum: ['skip', 'replace', 'rename', 'merge', 'duplicate'], default: 'rename' },
    progress: {
      percent: { type: Number, default: 0 },
      currentStep: { type: String, default: '' },
      currentLabel: { type: String, default: '' },
      stepsCompleted: { type: Number, default: 0 },
      stepsTotal: { type: Number, default: 0 },
      etaSeconds: { type: Number, default: null },
    },
    restoredCounts: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    conflicts: { type: [mongoose.Schema.Types.Mixed], default: [] },
    warnings: { type: [String], default: [] },
    errorMessages: { type: [String], default: [] },
    sourceRestaurantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    targetRestaurantId: { type: mongoose.Schema.Types.ObjectId, required: true },
    targetBranchId: { type: mongoose.Schema.Types.ObjectId, default: null },
    bullJobId: { type: String, default: '' },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    failureReason: { type: String, default: '' },
    ipAddress: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    deviceInfo: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },
  { timestamps: true },
);

restoreJobSchema.index({ restaurantId: 1, createdAt: -1 });
restoreJobSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('RestoreJob', restoreJobSchema);
