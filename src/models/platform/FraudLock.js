const mongoose = require('mongoose');

const fraudLockSchema = new mongoose.Schema(
  {
    subjectType: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth', 'Platform', 'ip'], required: true },
    subjectId: { type: String, required: true },
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', default: null, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    reason: { type: String, required: true },
    alert: { type: mongoose.Schema.Types.ObjectId, ref: 'FraudAlert', default: null },
    lockedUntil: { type: Date, required: true, index: true },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

fraudLockSchema.index({ subjectType: 1, subjectId: 1, active: 1, lockedUntil: 1 });

module.exports = mongoose.model('FraudLock', fraudLockSchema);
