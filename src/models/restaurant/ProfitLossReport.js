const mongoose = require('mongoose');

const profitLossReportSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    reportPeriod: { type: String, enum: ['daily', 'weekly', 'monthly', 'yearly', 'custom'], required: true },
    fromDate: { type: Date, required: true },
    toDate: { type: Date, required: true },
    revenue: { type: Number, required: true, min: 0, default: 0 },
    expenses: { type: Number, required: true, min: 0, default: 0 },
    taxes: { type: Number, required: true, min: 0, default: 0 },
    refunds: { type: Number, required: true, min: 0, default: 0 },
    grossProfit: { type: Number, required: true, default: 0 },
    netProfit: { type: Number, required: true, default: 0 },
    marginPercent: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

profitLossReportSchema.index({ restaurantId: 1, branchId: 1, fromDate: -1, toDate: -1 });

module.exports = mongoose.model('ProfitLossReport', profitLossReportSchema);
