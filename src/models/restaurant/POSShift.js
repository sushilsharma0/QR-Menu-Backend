const mongoose = require('mongoose');

const posshiftSchema = new mongoose.Schema(
  {
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    operatorType: {
      type: String,
      enum: ['Restaurant', 'Employee', 'BranchAuth'],
      default: 'Employee',
      index: true,
    },
    operator: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: 'operatorType',
      index: true,
    },
    openedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
    openedByModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth'], default: 'Employee' },
    closedByModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth'], default: 'Employee' },
    openedAt: { type: Date, default: Date.now },
    closedAt: Date,
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    openingCash: { type: Number, default: 0 },
    closingCash: { type: Number, default: 0 },
    expectedCash: { type: Number, default: 0 },
    difference: { type: Number, default: 0 },
    totalSales: { type: Number, default: 0 },
    cashSales: { type: Number, default: 0 },
    onlineSales: { type: Number, default: 0 },
    refunds: { type: Number, default: 0 },
    drawerAdjustments: [{
      amount: { type: Number, required: true },
      reason: { type: String, default: '' },
      type: { type: String, enum: ['cash_in', 'cash_out'], required: true },
      approvedBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'drawerAdjustments.approvedByModel' },
      approvedByModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth'], default: 'Employee' },
      createdAt: { type: Date, default: Date.now },
    }],
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

posshiftSchema.index({ restaurant: 1, status: 1 });
posshiftSchema.index({ restaurant: 1, branchId: 1, status: 1 });
posshiftSchema.index({ restaurant: 1, operatorType: 1, operator: 1, status: 1 });
posshiftSchema.index({ restaurant: 1, openedAt: -1 });

module.exports = mongoose.model('POSShift', posshiftSchema);
