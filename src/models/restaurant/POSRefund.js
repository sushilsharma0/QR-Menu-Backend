const mongoose = require('mongoose');

const posRefundSchema = new mongoose.Schema(
  {
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    customerOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CustomerOrder',
      required: true,
    },
    amount: { type: Number, required: true },
    kind: { type: String, enum: ['full', 'partial', 'void'], required: true },
    reason: { type: String, default: '' },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
    requestedByModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth'], default: 'Employee' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'approvedByModel' },
    approvedByModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth'], default: 'Employee' },
    approval: { type: mongoose.Schema.Types.ObjectId, ref: 'POSApproval', default: null },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  },
  { timestamps: true }
);

posRefundSchema.index({ restaurant: 1, branchId: 1, createdAt: -1 });

module.exports = mongoose.model('POSRefund', posRefundSchema);
