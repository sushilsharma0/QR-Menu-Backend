const mongoose = require('mongoose');

const transactionLogSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerOrder', required: true, index: true },
    transactionId: { type: String, default: '', index: true },
    amount: { type: Number, required: true, min: 0 },
    paymentMethod: { type: String, default: 'cash' },
    status: { type: String, enum: ['pending', 'success', 'failed', 'refunded'], default: 'success', index: true },
    taxAmount: { type: Number, default: 0, min: 0 },
    refundAmount: { type: Number, default: 0, min: 0 },
    loggedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

transactionLogSchema.index({ restaurantId: 1, loggedAt: -1 });

module.exports = mongoose.model('TransactionLog', transactionLogSchema);
