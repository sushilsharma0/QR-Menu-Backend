const asyncHandler = require('express-async-handler');
const PlatformExpense = require('../../models/platform/PlatformExpense');
const { PLATFORM_EXPENSE_CATEGORIES } = require('../../models/platform/PlatformExpense');
const PlatformProfitLossReport = require('../../models/platform/PlatformProfitLossReport');
const AuditLog = require('../../models/platform/AuditLog');
const { success, error } = require('../../utils/apiResponse');
const { buildPlatformProfitLoss } = require('../../services/platformProfitLossService');

const MANUAL_CATEGORIES = PLATFORM_EXPENSE_CATEGORIES.filter((c) => c !== 'staff_salary');

const createExpense = asyncHandler(async (req, res) => {
  const { title, amount, category, paymentMethod, description, notes, expenseDate, paymentStatus } = req.body;
  if (!title?.trim() || amount === undefined || !category || !expenseDate) {
    return error(res, 'title, amount, category and expenseDate are required', 400);
  }
  if (!MANUAL_CATEGORIES.includes(category)) {
    return error(
      res,
      category === 'staff_salary'
        ? 'Staff salary is recorded automatically when you mark platform payroll as paid.'
        : 'Invalid expense category',
      400,
    );
  }

  const row = await PlatformExpense.create({
    title: title.trim(),
    amount: Number(amount) || 0,
    category,
    paymentMethod: paymentMethod || 'bank_transfer',
    description: description || '',
    notes: notes || description || '',
    paymentStatus: paymentStatus || 'paid',
    expenseDate: new Date(expenseDate),
    addedBy: req.user.id,
  });

  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'platform_expense_create',
    resource: 'system',
    details: { expenseId: row._id, amount: row.amount, category: row.category, title: row.title },
    ipAddress: req.ip,
  });

  return success(res, row, 'Expense added', 201);
});

const getExpenses = asyncHandler(async (req, res) => {
  const { q, from, to, category } = req.query;
  const filter = { isDeleted: false };
  if (category) filter.category = category;
  if (q?.trim()) {
    filter.title = { $regex: q.trim(), $options: 'i' };
  }
  if (from || to) {
    filter.expenseDate = {};
    if (from) filter.expenseDate.$gte = new Date(from);
    if (to) filter.expenseDate.$lte = new Date(to);
  }

  const rows = await PlatformExpense.find(filter).sort({ expenseDate: -1 }).limit(500).lean();
  const breakdown = await PlatformExpense.aggregate([
    { $match: filter },
    { $group: { _id: '$category', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
    { $sort: { amount: -1 } },
  ]);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthRows = rows.filter((r) => new Date(r.expenseDate) >= monthStart);

  return success(
    res,
    {
      items: rows,
      summary: {
        totalMonthlyExpense: monthRows.reduce((s, x) => s + Number(x.amount || 0), 0),
        totalFiltered: rows.reduce((s, x) => s + Number(x.amount || 0), 0),
        highestExpenseCategory: breakdown[0]?._id || null,
        categoryBreakdown: breakdown,
        payrollLinkedCount: rows.filter((r) => r.sourcePayrollId).length,
      },
      categories: PLATFORM_EXPENSE_CATEGORIES,
      manualCategories: MANUAL_CATEGORIES,
    },
    'Platform expenses retrieved',
  );
});

const deleteExpense = asyncHandler(async (req, res) => {
  const row = await PlatformExpense.findOne({ _id: req.params.id, isDeleted: false });
  if (!row) return error(res, 'Expense not found', 404);
  if (row.sourcePayrollId) {
    return error(res, 'Payroll-linked salary expenses cannot be deleted here. Adjust payroll instead.', 400);
  }
  row.isDeleted = true;
  await row.save();
  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'platform_expense_delete',
    resource: 'system',
    details: { expenseId: row._id },
    ipAddress: req.ip,
  });
  return success(res, null, 'Expense deleted');
});

const getProfitLoss = asyncHandler(async (req, res) => {
  const { report, categoryBreakdown, subscriptionPaymentCount } = await buildPlatformProfitLoss({
    fromDate: req.query.from,
    toDate: req.query.to,
    reportPeriod: req.query.period || 'custom',
    generatedBy: req.user.id,
  });

  const trends = await PlatformProfitLossReport.find()
    .sort({ createdAt: -1 })
    .limit(12)
    .select('createdAt revenue expenses payrollExpenses operatingExpenses grossProfit netProfit marginPercent')
    .lean();

  return success(
    res,
    {
      report: { ...report.toObject(), categoryBreakdown, subscriptionPaymentCount },
      trends: trends.reverse(),
    },
    'Profit & loss report generated',
  );
});

module.exports = {
  createExpense,
  getExpenses,
  deleteExpense,
  getProfitLoss,
};
