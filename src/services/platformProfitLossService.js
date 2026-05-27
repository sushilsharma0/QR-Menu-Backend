const SubscriptionPayment = require('../models/shared/SubscriptionPayment');
const PlatformExpense = require('../models/platform/PlatformExpense');
const PlatformProfitLossReport = require('../models/platform/PlatformProfitLossReport');

const REVENUE_STATUSES = ['paid', 'approved'];

function toDate(v, fallback, endOfDay = false) {
  const d = v ? new Date(v) : new Date(fallback);
  const date = Number.isNaN(d.getTime()) ? new Date(fallback) : d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) {
    date.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  }
  return date;
}

async function buildPlatformProfitLoss({ fromDate, toDate: toDateInput, reportPeriod = 'custom', generatedBy }) {
  const from = toDate(fromDate, Date.now() - 30 * 24 * 60 * 60 * 1000);
  const to = toDate(toDateInput, Date.now(), true);

  const [revenueAgg, expenseAgg, payrollAgg, categoryAgg] = await Promise.all([
    SubscriptionPayment.aggregate([
      {
        $match: {
          status: { $in: REVENUE_STATUSES },
          createdAt: { $gte: from, $lte: to },
        },
      },
      { $group: { _id: null, revenue: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    PlatformExpense.aggregate([
      {
        $match: {
          isDeleted: false,
          expenseDate: { $gte: from, $lte: to },
        },
      },
      { $group: { _id: null, expenses: { $sum: '$amount' } } },
    ]),
    PlatformExpense.aggregate([
      {
        $match: {
          isDeleted: false,
          category: 'staff_salary',
          expenseDate: { $gte: from, $lte: to },
        },
      },
      { $group: { _id: null, payrollExpenses: { $sum: '$amount' } } },
    ]),
    PlatformExpense.aggregate([
      {
        $match: {
          isDeleted: false,
          expenseDate: { $gte: from, $lte: to },
        },
      },
      { $group: { _id: '$category', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { amount: -1 } },
    ]),
  ]);

  const revenue = Number(revenueAgg[0]?.revenue || 0);
  const expenses = Number(expenseAgg[0]?.expenses || 0);
  const payrollExpenses = Number(payrollAgg[0]?.payrollExpenses || 0);
  const operatingExpenses = expenses - payrollExpenses;
  const grossProfit = revenue - expenses;
  const netProfit = grossProfit;
  const marginPercent = revenue > 0 ? Number(((netProfit / revenue) * 100).toFixed(2)) : 0;

  const report = await PlatformProfitLossReport.create({
    reportPeriod,
    fromDate: from,
    toDate: to,
    revenue,
    expenses,
    payrollExpenses,
    operatingExpenses,
    grossProfit,
    netProfit,
    marginPercent,
    generatedBy,
  });

  return {
    report,
    categoryBreakdown: categoryAgg.map((row) => ({
      category: row._id,
      amount: Number(row.amount || 0),
      count: row.count,
    })),
    subscriptionPaymentCount: revenueAgg[0]?.count || 0,
  };
}

module.exports = {
  buildPlatformProfitLoss,
  REVENUE_STATUSES,
};
