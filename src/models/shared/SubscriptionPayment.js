const mongoose = require('mongoose');

const subscriptionPaymentSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      required: true,
      index: true,
    },
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subscription',
      required: true,
      index: true,
    },
    amount: { type: Number, required: true, min: 0 },
    paymentMethod: {
      type: String,
      enum: ['esewa', 'khalti', 'manual'],
      required: true,
      index: true,
    },
    transactionId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    gatewayReference: { type: String, trim: true },
    paymentGatewayData: { type: mongoose.Schema.Types.Mixed, default: {} },
    screenshot: { type: String },
    status: {
      type: String,
      enum: ['pending', 'paid', 'pending_verification', 'approved', 'rejected', 'failed'],
      default: 'pending',
      index: true,
    },
    adminNote: { type: String },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Platform' },
    verifiedAt: { type: Date },
  },
  { timestamps: true },
);

subscriptionPaymentSchema.index({ restaurantId: 1, createdAt: -1 });
subscriptionPaymentSchema.index({ status: 1, createdAt: -1 });
subscriptionPaymentSchema.index({ gatewayReference: 1 }, { sparse: true });
subscriptionPaymentSchema.index(
  { restaurantId: 1, planId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['pending', 'paid', 'pending_verification'] } },
  },
);

module.exports = mongoose.model('SubscriptionPayment', subscriptionPaymentSchema);
