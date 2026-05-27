const mongoose = require('mongoose');

const restoreAuditSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    action: {
      type: String,
      enum: [
        'backup_create',
        'backup_create_failed',
        'backup_delete',
        'backup_download',
        'backup_validate',
        'backup_preview',
        'backup_restore',
        'branch_clone',
        'schedule_update',
        'restore_otp_request',
        'restore_otp_verified',
        'restore_start',
        'restore_complete',
        'restore_failed',
        'restore_cancel',
        'restore_rollback',
        'schedule_update',
        'cloud_upload',
        'cloud_restore',
      ],
      required: true,
      index: true,
    },
    actorId: { type: mongoose.Schema.Types.ObjectId, refPath: 'actorModel' },
    actorModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth', 'Admin'] },
    resourceType: { type: String, default: 'backup' },
    resourceId: { type: mongoose.Schema.Types.ObjectId, default: null },
    details: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    ipAddress: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    deviceInfo: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },
  { timestamps: true },
);

restoreAuditSchema.index({ restaurantId: 1, createdAt: -1 });

module.exports = mongoose.model('RestoreAudit', restoreAuditSchema);
