const mongoose = require('mongoose');

const posApprovalSchema = new mongoose.Schema(
  {
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    action: {
      type: String,
      enum: ['discount', 'refund', 'void_bill', 'drawer_adjustment', 'shift_close_variance'],
      required: true,
      index: true,
    },
    resourceType: { type: String, default: 'order' },
    resourceId: { type: mongoose.Schema.Types.ObjectId, index: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'requestedByModel' },
    requestedByModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth'], default: 'Employee' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'approvedByModel' },
    approvedByModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth'], default: 'Employee' },
    reason: { type: String, default: '' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    status: { type: String, enum: ['approved', 'rejected'], default: 'approved', index: true },
  },
  { timestamps: true }
);

posApprovalSchema.index({ restaurant: 1, branchId: 1, createdAt: -1 });
posApprovalSchema.index({ resourceId: 1, action: 1, createdAt: -1 });

module.exports = mongoose.model('POSApproval', posApprovalSchema);
