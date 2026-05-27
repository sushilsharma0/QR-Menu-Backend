const mongoose = require('mongoose');

/** Audit row per POS payment leg (pairs with Transaction). */
const posPaymentSchema = new mongoose.Schema(
  {
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    customerOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CustomerOrder',
      required: true,
    },
    transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: true },
    posShift: { type: mongoose.Schema.Types.ObjectId, ref: 'POSShift' },
    method: { type: String, required: true },
    amount: { type: Number, required: true },
    status: { type: String, enum: ['success', 'failed'], default: 'success', index: true },
    processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
  },
  { timestamps: true }
);

posPaymentSchema.index({ restaurant: 1, branchId: 1, createdAt: -1 });
posPaymentSchema.index({ customerOrder: 1 });

module.exports = mongoose.model('POSPayment', posPaymentSchema);
