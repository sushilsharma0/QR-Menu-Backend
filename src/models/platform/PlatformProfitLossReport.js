const mongoose = require('mongoose');

const platformProfitLossReportSchema = new mongoose.Schema(
  {
    reportPeriod: { type: String, default: 'custom' },
    fromDate: { type: Date, required: true },
    toDate: { type: Date, required: true },
    revenue: { type: Number, default: 0 },
    expenses: { type: Number, default: 0 },
    payrollExpenses: { type: Number, default: 0 },
    operatingExpenses: { type: Number, default: 0 },
    grossProfit: { type: Number, default: 0 },
    netProfit: { type: Number, default: 0 },
    marginPercent: { type: Number, default: 0 },
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Platform' },
  },
  { timestamps: true },
);

module.exports = mongoose.model('PlatformProfitLossReport', platformProfitLossReportSchema);
