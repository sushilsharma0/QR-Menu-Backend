const mongoose = require('mongoose');

const backupScheduleSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'createdByModel', required: true },
    createdByModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth', 'Admin'], required: true },
    frequency: { type: String, enum: ['daily', 'weekly', 'monthly'], required: true, index: true },
    backupType: { type: String, enum: ['full', 'partial', 'incremental', 'snapshot'], default: 'snapshot' },
    includedSections: { type: [String], default: [] },
    storageProvider: { type: String, enum: ['local', 's3', 'backblaze', 'gcs'], default: 'local' },
    retentionPolicy: {
      dailyDays: { type: Number, default: 7 },
      weeklyDays: { type: Number, default: 31 },
      monthlyDays: { type: Number, default: 366 },
    },
    lastRunAt: { type: Date, default: null },
    nextRunAt: { type: Date, required: true, index: true },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

backupScheduleSchema.index({ restaurantId: 1, isActive: 1, nextRunAt: 1 });

module.exports = mongoose.model('BackupSchedule', backupScheduleSchema);
