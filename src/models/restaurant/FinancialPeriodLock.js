const mongoose = require('mongoose');

const financialPeriodLockSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    reason: { type: String, default: '' },
    lockedBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'lockedByModel', required: true },
    lockedByModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth'], required: true },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

financialPeriodLockSchema.index({ restaurantId: 1, branchId: 1, periodStart: 1, periodEnd: 1, isActive: 1 });

module.exports = mongoose.model('FinancialPeriodLock', financialPeriodLockSchema);
