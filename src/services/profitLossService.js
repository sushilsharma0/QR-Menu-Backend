const SalesReport = require('../models/restaurant/SalesReport');
const Expense = require('../models/restaurant/Expense');
const TransactionLog = require('../models/restaurant/TransactionLog');
const ProfitLossReport = require('../models/restaurant/ProfitLossReport');
const { syncSalesReportsForRestaurant, buildSalesReportDedupePipeline } = require('./salesReportService');
const { expenseBranchMatch } = require('../utils/expenseBranchMatch');

function toDate(v, fallback, endOfDay = false) {
  const d = v ? new Date(v) : new Date(fallback);
  const date = Number.isNaN(d.getTime()) ? new Date(fallback) : d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) {
    date.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  }
  return date;
}

async function buildProfitLoss({
  restaurantId,
  branchId,
  fromDate: fromDateInput,
  toDate: toDateInput,
  reportPeriod = 'custom',
}) {
  const from = toDate(fromDateInput, Date.now() - 30 * 24 * 60 * 60 * 1000);
  const to = toDate(toDateInput, Date.now(), true);

  await syncSalesReportsForRestaurant(restaurantId);

  const [salesAgg, expenseAgg, txnAgg] = await Promise.all([
    SalesReport.aggregate([
      { $match: { restaurantId, ...(branchId ? { branchId } : {}), soldAt: { $gte: from, $lte: to } } },
      ...buildSalesReportDedupePipeline(),
      {
        $group: {
          _id: null,
          revenue: { $sum: '$totalRevenue' },
          netRevenue: { $sum: '$netRevenue' },
          tax: { $sum: '$taxAmount' },
          refunds: { $sum: '$refundAmount' },
        },
      },
    ]),
    Expense.aggregate([
      {
        $match: {
          restaurantId,
          ...expenseBranchMatch(branchId),
          isDeleted: false,
          expenseDate: { $gte: from, $lte: to },
        },
      },
      { $group: { _id: null, expenses: { $sum: '$amount' } } },
    ]),
    TransactionLog.aggregate([
      { $match: { restaurantId, ...(branchId ? { branchId } : {}), loggedAt: { $gte: from, $lte: to }, status: 'refunded' } },
      { $group: { _id: null, refunded: { $sum: '$refundAmount' } } },
    ]),
  ]);

  const revenue = Number(salesAgg[0]?.netRevenue || salesAgg[0]?.revenue || 0);
  const taxes = Number(salesAgg[0]?.tax || 0);
  const expense = Number(expenseAgg[0]?.expenses || 0);
  const refunds = Number(salesAgg[0]?.refunds || 0) + Number(txnAgg[0]?.refunded || 0);
  const grossProfit = revenue - expense;
  const netProfit = revenue - expense - taxes - refunds;
  const marginPercent = revenue > 0 ? (netProfit / revenue) * 100 : 0;

  const report = await ProfitLossReport.create({
    restaurantId,
    branchId,
    reportPeriod,
    fromDate: from,
    toDate: to,
    revenue,
    expenses: expense,
    taxes,
    refunds,
    grossProfit,
    netProfit,
    marginPercent: Number(marginPercent.toFixed(2)),
  });

  return report;
}

module.exports = {
  buildProfitLoss,
};
