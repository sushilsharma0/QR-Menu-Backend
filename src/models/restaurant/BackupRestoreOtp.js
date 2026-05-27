const mongoose = require('mongoose');

const backupRestoreOtpSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'requestedByModel', required: true },
    requestedByModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth', 'Admin'], required: true },
    otpHash: { type: String, required: true, select: false },
    purpose: { type: String, enum: ['restore', 'migration', 'replace'], default: 'restore' },
    expiresAt: { type: Date, required: true, index: true },
    verifiedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    ipAddress: { type: String, default: '' },
  },
  { timestamps: true },
);

backupRestoreOtpSchema.index({ restaurantId: 1, purpose: 1, verifiedAt: 1 });

module.exports = mongoose.model('BackupRestoreOtp', backupRestoreOtpSchema);
