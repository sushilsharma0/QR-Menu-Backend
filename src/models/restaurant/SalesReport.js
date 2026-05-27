const mongoose = require('mongoose');

const salesReportSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerOrder', required: true, index: true },
    orderNumber: { type: String, default: '' },
    totalRevenue: { type: Number, required: true, min: 0, default: 0 },
    netRevenue: { type: Number, required: true, min: 0, default: 0 },
    taxAmount: { type: Number, required: true, min: 0, default: 0 },
    refundAmount: { type: Number, required: true, min: 0, default: 0 },
    paymentMethod: { type: String, default: 'cash' },
    orderChannel: {
      type: String,
      enum: ['dine_in', 'qr_ordering', 'delivery', 'takeaway'],
      default: 'qr_ordering',
      index: true,
    },
    itemCount: { type: Number, required: true, min: 0, default: 0 },
    categoryBreakdown: [
      {
        categoryName: String,
        amount: Number,
      },
    ],
    soldAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

salesReportSchema.index({ restaurantId: 1, branchId: 1, soldAt: -1 });
salesReportSchema.index({ restaurantId: 1, branchId: 1, paymentMethod: 1, soldAt: -1 });

module.exports = mongoose.model('SalesReport', salesReportSchema);
