const mongoose = require('mongoose');

const restoreSnapshotSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    backupRecordId: { type: mongoose.Schema.Types.ObjectId, ref: 'BackupRecord', required: true },
    restoreJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'RestoreJob', default: null },
    label: { type: String, default: 'Pre-restore snapshot' },
    status: { type: String, enum: ['active', 'used_for_rollback', 'expired'], default: 'active', index: true },
    expiresAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'createdByModel' },
    createdByModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth', 'Admin'] },
  },
  { timestamps: true },
);

restoreSnapshotSchema.index({ restaurantId: 1, createdAt: -1 });

module.exports = mongoose.model('RestoreSnapshot', restoreSnapshotSchema);
