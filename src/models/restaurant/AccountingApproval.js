const mongoose = require('mongoose');

const accountingApprovalSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    action: {
      type: String,
      enum: ['expense', 'stock_adjustment', 'purchase', 'supplier', 'payroll'],
      required: true,
      index: true,
    },
    resourceType: { type: String, default: '' },
    resourceId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    status: { type: String, enum: ['approved', 'rejected'], default: 'approved', index: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'requestedByModel' },
    requestedByModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth'], default: 'Restaurant' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'approvedByModel' },
    approvedByModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth'], default: 'Restaurant' },
    reason: { type: String, default: '' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },
  { timestamps: true }
);

accountingApprovalSchema.index({ restaurantId: 1, branchId: 1, createdAt: -1 });

module.exports = mongoose.model('AccountingApproval', accountingApprovalSchema);
