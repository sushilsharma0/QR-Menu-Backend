const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const { success, error } = require('../utils/apiResponse');
const resolveRestaurantId = require('../middleware/restaurant/resolveRestaurantId');
const Expense = require('../models/restaurant/Expense');
const SalesReport = require('../models/restaurant/SalesReport');
const TransactionLog = require('../models/restaurant/TransactionLog');
const CustomerOrder = require('../models/restaurant/CustomerOrder');
const MenuItem = require('../models/restaurant/MenuItem');
const TaxSettings = require('../models/restaurant/TaxSettings');
const TaxReport = require('../models/restaurant/TaxReport');
const InventoryItem = require('../models/restaurant/InventoryItem');
const InventoryLog = require('../models/restaurant/InventoryLog');
const InventoryPurchase = require('../models/restaurant/InventoryPurchase');
const ProfitLossReport = require('../models/restaurant/ProfitLossReport');
const AuditLog = require('../models/platform/AuditLog');
const { buildProfitLoss } = require('../services/profitLossService');
const notificationService = require('../services/notificationService');
const {
  buildSalesReportDedupePipeline,
  ensureSalesReportForOrder,
  syncSalesReportsForRestaurant,
} = require('../services/salesReportService');
const { notifyBudgetExceededIfNeeded } = require('../services/budgetNotifyService');
const { expenseBranchMatch } = require('../utils/expenseBranchMatch');
const { addFieldsPaymentMethodBucket } = require('../utils/paymentMethodAggregation');
const { inventoryBranchItemFilter } = require('../utils/inventoryBranchScope');
const {
  computeWeightedAverageCost,
  replacePurchaseInAverage,
  removePurchaseFromAverage,
  validatePositiveQuantity,
  validateNonNegativeQuantity,
  insufficientStockError,
  roundQty,
} = require('../utils/inventoryStock');
const {
  applyPurchaseCreate,
  applyPurchaseReplace,
  applyPurchaseDelete,
  applyExpenseCreate,
  applyExpenseReplace,
  applyExpenseSoftDelete,
} = require('../services/cashBookService');
const Restaurant = require('../models/restaurant/Restaurant');
const FinancialPeriodLock = require('../models/restaurant/FinancialPeriodLock');
const { readNumber, readObjectId, readSearchRegex, readString } = require('../utils/inputValidation');
const accountingSecurity = require('../services/accountingSecurityService');

function authModel(req) {
  return req.user?.scope === 'employee' ? 'Employee' : 'Restaurant';
}

function asObjectId(v) {
  return new mongoose.Types.ObjectId(String(v));
}

function dateOrNull(value) {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

async function notifyLowStockLine(restaurantId, item) {
  if (Number(item.quantity || 0) > Number(item.minimumStock || 0)) return;
  try {
    await notificationService.sendNotification({
      recipientType: 'restaurant',
      recipientId: String(restaurantId),
      category: 'inventory',
      type: 'low_stock',
      priority: 'medium',
      title: 'Low stock alert',
      message: `${item.name} is at or below minimum (${item.quantity} ${item.unit}).`,
      dedupeKey: `lowstock-${String(restaurantId)}-${String(item._id)}`,
      actionUrl: '/notifications',
    });
  } catch (e) {
    console.error('notifyLowStockLine', e);
  }
}

function parseDateRange(q) {
  const now = new Date();
  const from = q.from ? new Date(q.from) : new Date(now.getFullYear(), now.getMonth(), 1);
  const to = q.to ? new Date(q.to) : now;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error('Invalid date range');
  }
  return { from, to };
}

const getSales = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const restaurantId = asObjectId(rid);
  await syncSalesReportsForRestaurant(restaurantId);
  let from;
  let to;
  try {
    ({ from, to } = parseDateRange(req.query));
  } catch (e) {
    return error(res, e.message, 400);
  }

  const [salesSummary, expenseSummary] = await Promise.all([
    SalesReport.aggregate([
      { $match: { restaurantId, branchId: req.branchId, soldAt: { $gte: from, $lte: to } } },
      ...buildSalesReportDedupePipeline(),
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$totalRevenue' },
          netRevenue: { $sum: '$netRevenue' },
          taxCollected: { $sum: '$taxAmount' },
          refundAmount: { $sum: '$refundAmount' },
          totalOrders: { $sum: 1 },
          itemCount: { $sum: '$itemCount' },
        },
      },
    ]),
    Expense.aggregate([
      {
        $match: {
          restaurantId,
          ...expenseBranchMatch(req.branchId),
          isDeleted: false,
          expenseDate: { $gte: from, $lte: to },
        },
      },
      {
        $group: {
          _id: null,
          totalExpenses: { $sum: '$amount' },
          paidExpenses: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, '$amount', 0] } },
          pendingExpenses: { $sum: { $cond: [{ $in: ['$paymentStatus', ['pending', 'partial']] }, '$amount', 0] } },
          expenseEntries: { $sum: 1 },
        },
      },
    ]),
  ]);

  const summary = salesSummary[0] || {};
  const expenses = expenseSummary[0] || {};
  const totalRevenue = Number(summary?.totalRevenue || 0);
  const netRevenue = Number(summary?.netRevenue || 0);
  const totalExpenses = Number(expenses?.totalExpenses || 0);
  const netProfit = netRevenue - totalExpenses;

  const cards = {
    totalRevenue,
    totalOrders: Number(summary?.totalOrders || 0),
    averageOrderValue:
      Number(summary?.totalOrders || 0) > 0
        ? Number((totalRevenue / Number(summary.totalOrders)).toFixed(2))
        : 0,
    netRevenue,
    taxCollected: Number(summary?.taxCollected || 0),
    refundAmount: Number(summary?.refundAmount || 0),
    itemCount: Number(summary?.itemCount || 0),
    totalExpenses,
    paidExpenses: Number(expenses?.paidExpenses || 0),
    pendingExpenses: Number(expenses?.pendingExpenses || 0),
    expenseEntries: Number(expenses?.expenseEntries || 0),
    netProfit,
    profitMarginPercent: netRevenue > 0 ? Number(((netProfit / netRevenue) * 100).toFixed(2)) : 0,
  };
  return success(res, cards, 'Sales summary retrieved');
});

const getSalesAnalytics = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const restaurantId = asObjectId(rid);
  await syncSalesReportsForRestaurant(restaurantId);
  let from;
  let to;
  try {
    ({ from, to } = parseDateRange(req.query));
  } catch (e) {
    return error(res, e.message, 400);
  }

  const [trend, byMethod, hourly, byCategory, expenseTrend, expenseByCategory, expenseByStatus] = await Promise.all([
    SalesReport.aggregate([
      { $match: { restaurantId, branchId: req.branchId, soldAt: { $gte: from, $lte: to } } },
      ...buildSalesReportDedupePipeline(),
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$soldAt' } },
          revenue: { $sum: '$totalRevenue' },
          orders: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    SalesReport.aggregate([
      { $match: { restaurantId, branchId: req.branchId, soldAt: { $gte: from, $lte: to } } },
      ...buildSalesReportDedupePipeline(),
      addFieldsPaymentMethodBucket('$paymentMethod', '_paymentMethodBucket'),
      { $group: { _id: '$_paymentMethodBucket', amount: { $sum: '$totalRevenue' }, orders: { $sum: 1 } } },
      { $sort: { amount: -1 } },
    ]),
    SalesReport.aggregate([
      { $match: { restaurantId, branchId: req.branchId, soldAt: { $gte: from, $lte: to } } },
      ...buildSalesReportDedupePipeline(),
      { $project: { hour: { $hour: '$soldAt' }, totalRevenue: 1 } },
      { $group: { _id: '$hour', amount: { $sum: '$totalRevenue' }, orders: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    SalesReport.aggregate([
      { $match: { restaurantId, branchId: req.branchId, soldAt: { $gte: from, $lte: to } } },
      ...buildSalesReportDedupePipeline(),
      { $unwind: '$categoryBreakdown' },
      {
        $group: {
          _id: '$categoryBreakdown.categoryName',
          amount: { $sum: '$categoryBreakdown.amount' },
        },
      },
      { $sort: { amount: -1 } },
    ]),
    Expense.aggregate([
      {
        $match: {
          restaurantId,
          ...expenseBranchMatch(req.branchId),
          isDeleted: false,
          expenseDate: { $gte: from, $lte: to },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$expenseDate' } },
          expenses: { $sum: '$amount' },
          entries: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Expense.aggregate([
      {
        $match: {
          restaurantId,
          ...expenseBranchMatch(req.branchId),
          isDeleted: false,
          expenseDate: { $gte: from, $lte: to },
        },
      },
      { $group: { _id: '$category', amount: { $sum: '$amount' }, entries: { $sum: 1 } } },
      { $sort: { amount: -1 } },
    ]),
    Expense.aggregate([
      {
        $match: {
          restaurantId,
          ...expenseBranchMatch(req.branchId),
          isDeleted: false,
          expenseDate: { $gte: from, $lte: to },
        },
      },
      { $group: { _id: '$paymentStatus', amount: { $sum: '$amount' }, entries: { $sum: 1 } } },
      { $sort: { amount: -1 } },
    ]),
  ]);

  const expenseByDate = new Map(expenseTrend.map((row) => [row._id, row]));
  const dates = new Set([...trend.map((row) => row._id), ...expenseTrend.map((row) => row._id)]);
  const profitTrend = Array.from(dates)
    .sort()
    .map((date) => {
      const sales = trend.find((row) => row._id === date) || {};
      const expense = expenseByDate.get(date) || {};
      const revenue = Number(sales.revenue || 0);
      const expenses = Number(expense.expenses || 0);
      return {
        _id: date,
        revenue,
        expenses,
        profit: revenue - expenses,
        orders: Number(sales.orders || 0),
      };
    });

  return success(
    res,
    {
      revenueTrend: trend,
      salesByPaymentMethod: byMethod,
      peakSalesHours: hourly,
      salesByCategory: byCategory,
      expenseTrend,
      expenseByCategory,
      expenseByStatus,
      profitTrend,
    },
    'Sales analytics retrieved',
  );
});

const getSalesTopItems = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const restaurantId = asObjectId(rid);
  await syncSalesReportsForRestaurant(restaurantId);
  let from;
  let to;
  try {
    ({ from, to } = parseDateRange(req.query));
  } catch (e) {
    return error(res, e.message, 400);
  }

  const rows = await CustomerOrder.aggregate([
    { $match: { restaurant: restaurantId, branchId: req.branchId, createdAt: { $gte: from, $lte: to } } },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.name',
        quantity: { $sum: '$items.quantity' },
        revenue: { $sum: { $multiply: ['$items.quantity', '$items.price'] } },
      },
    },
    { $sort: { revenue: -1 } },
    { $limit: Number(req.query.limit || 10) },
  ]);
  return success(res, rows, 'Top selling items retrieved');
});

const syncSalesFromCompletedOrders = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const restaurantId = asObjectId(rid);

  const completed = await CustomerOrder.find({
    restaurant: restaurantId,
    branchId: req.branchId,
    isActive: true,
    $or: [{ status: 'completed' }, { paymentStatus: 'paid' }],
  }).select(
    'restaurant orderNumber grandTotal totalAmount taxAmount discountAmount paymentMethod items createdAt updatedAt _id orderChannel paymentStatus status',
  );

  let inserted = 0;
  for (const order of completed) {
    const exists = await SalesReport.findOne({ restaurantId, orderId: order._id }).select('_id');
    if (exists) continue;
    await ensureSalesReportForOrder(order);
    inserted += 1;
  }

  return success(res, { inserted }, 'Sales sync completed');
});

const createExpense = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const {
    title,
    amount,
    category,
    paymentMethod,
    description,
    expenseDate,
    notes,
    paymentStatus,
    isRecurring,
    recurringFrequency,
    nextDueDate,
  } = req.body;
  if (!title || amount === undefined || !category || !expenseDate) {
    return error(res, 'title, amount, category and expenseDate are required', 400);
  }
  if (category === 'staff_salary') {
    return error(
      res,
      'Staff salary is created automatically when you pay payroll. Pick another category for manual expenses.',
      400,
    );
  }
  try {
    await accountingSecurity.assertPeriodOpen({ restaurantId: rid, branchId: req.branchId, date: expenseDate });
  } catch (e) {
    return error(res, e.message, e.statusCode || 400);
  }
  let approvalDoc = null;
  if (Number(amount) >= Number(process.env.EXPENSE_APPROVAL_AMOUNT || 5000) || req.body.requiresApproval === true) {
    try {
      approvalDoc = await accountingSecurity.createApproval(req, {
        action: 'expense',
        resourceType: 'expense',
        approval: req.body.approval || req.body.managerApproval || {},
        metadata: { amount: Number(amount), category, title },
      });
    } catch (e) {
      return error(res, e.message, e.statusCode || 403);
    }
  }
  const row = await Expense.create({
    restaurantId: rid,
    branchId: req.branchId,
    title,
    amount: Number(amount),
    category,
    paymentMethod,
    description,
    notes: notes || description || '',
    paymentStatus: paymentStatus || 'paid',
    isRecurring: isRecurring === true || isRecurring === 'true',
    recurringFrequency: recurringFrequency || '',
    nextDueDate: nextDueDate ? new Date(nextDueDate) : null,
    expenseDate: new Date(expenseDate),
    receiptImage: req.file?.path || '',
    addedBy: req.user.id,
    addedByModel: authModel(req),
    approval: approvalDoc?._id || null,
    approvalStatus: approvalDoc ? 'approved' : 'approved',
  });
  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'expense_create',
    resource: 'system',
    details: { expenseId: row._id, amount: row.amount, category: row.category },
    ipAddress: req.ip,
  });
  await applyExpenseCreate(rid, row);
  setImmediate(() => notifyBudgetExceededIfNeeded(rid, row));
  return success(res, row, 'Expense added', 201);
});

const getExpenses = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const { q, from, to } = req.query;
  const page = readNumber(req.query.page, { min: 1, max: 10000, integer: true, fallback: 1 });
  const limit = readNumber(req.query.limit, { min: 1, max: 100, integer: true, fallback: 20 });
  const category = readString(req.query.category, { max: 80 });
  const filter = { restaurantId: rid, isDeleted: false, ...expenseBranchMatch(req.branchId) };
  const titleRegex = readSearchRegex(q);
  if (titleRegex) filter.title = titleRegex;
  if (category) filter.category = category;
  if (from || to) {
    filter.expenseDate = {};
    if (from) filter.expenseDate.$gte = new Date(from);
    if (to) filter.expenseDate.$lte = new Date(to);
  }
  const skip = (page - 1) * limit;
  const [rows, total, breakdown] = await Promise.all([
    Expense.find(filter).sort({ expenseDate: -1 }).skip(skip).limit(limit),
    Expense.countDocuments(filter),
    Expense.aggregate([
      { $match: filter },
      { $group: { _id: '$category', amount: { $sum: '$amount' } } },
      { $sort: { amount: -1 } },
    ]),
  ]);
  return success(res, {
    items: rows,
    summary: {
      totalMonthlyExpense: rows.reduce((s, x) => s + Number(x.amount || 0), 0),
      highestExpenseCategory: breakdown[0]?._id || null,
      categoryBreakdown: breakdown,
    },
    pagination: { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / Number(limit)) },
  }, 'Expenses retrieved');
});

const updateExpense = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const row = await Expense.findOne({ _id: req.params.id, restaurantId: rid, isDeleted: false });
  if (!row) return error(res, 'Expense not found', 404);
  if (row.sourcePayrollId) {
    return error(res, 'Payroll-linked expenses cannot be edited here. Change amounts on the payroll record before paying.', 400);
  }
  if (row.sourceInventoryLogId) {
    return error(
      res,
      'This ingredients line was created from Inventory stock update. Adjust stock usage there instead of editing the expense.',
      400,
    );
  }
  try {
    await accountingSecurity.assertPeriodOpen({ restaurantId: rid, branchId: req.branchId, date: row.expenseDate });
  } catch (e) {
    return error(res, e.message, e.statusCode || 400);
  }
  const cashBookBefore = {
    paymentStatus: row.paymentStatus,
    paymentMethod: row.paymentMethod,
    amount: Number(row.amount || 0),
    sourcePayrollId: row.sourcePayrollId,
    sourceInventoryLogId: row.sourceInventoryLogId,
  };
  const fields = [
    'title',
    'amount',
    'category',
    'paymentMethod',
    'description',
    'notes',
    'expenseDate',
    'paymentStatus',
    'isRecurring',
    'recurringFrequency',
    'nextDueDate',
  ];
  for (const f of fields) {
    if (req.body[f] === undefined) continue;
    if (f === 'amount') row[f] = Number(req.body[f]);
    else if (f === 'isRecurring') row[f] = req.body[f] === true || req.body[f] === 'true';
    else if (f === 'nextDueDate') row[f] = req.body[f] ? new Date(req.body[f]) : null;
    else row[f] = req.body[f];
  }
  if (req.file?.path) row.receiptImage = req.file.path;
  await row.save();
  await applyExpenseReplace(rid, cashBookBefore, row.toObject());
  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'expense_edit',
    resource: 'system',
    details: { expenseId: row._id },
    ipAddress: req.ip,
  });
  return success(res, row, 'Expense updated');
});

const deleteExpense = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const row = await Expense.findOne({ _id: req.params.id, restaurantId: rid, isDeleted: false });
  if (!row) return error(res, 'Expense not found', 404);
  if (row.sourcePayrollId) {
    return error(res, 'This expense is tied to a payroll payment. Delete is not allowed here to keep P&L aligned.', 400);
  }
  if (row.sourceInventoryLogId) {
    return error(
      res,
      'This expense is tied to an inventory usage record. It cannot be deleted from here.',
      400,
    );
  }
  try {
    await accountingSecurity.assertPeriodOpen({ restaurantId: rid, branchId: req.branchId, date: row.expenseDate });
  } catch (e) {
    return error(res, e.message, e.statusCode || 400);
  }
  await applyExpenseSoftDelete(rid, row.toObject());
  row.isDeleted = true;
  await row.save();
  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'expense_delete',
    resource: 'system',
    details: { expenseId: row._id },
    ipAddress: req.ip,
  });
  return success(res, null, 'Expense deleted');
});

const getProfitLoss = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const report = await buildProfitLoss({
    restaurantId: asObjectId(rid),
    branchId: req.branchId,
    fromDate: req.query.from,
    toDate: req.query.to,
    reportPeriod: req.query.period || 'custom',
  });

  const trends = await ProfitLossReport.aggregate([
    { $match: { restaurantId: asObjectId(rid), branchId: req.branchId } },
    { $sort: { createdAt: -1 } },
    { $limit: 12 },
    { $project: { _id: 0, createdAt: 1, revenue: 1, expenses: 1, taxes: 1, refunds: 1, grossProfit: 1, netProfit: 1, marginPercent: 1 } },
  ]);

  return success(res, { report, trends: trends.reverse() }, 'Profit/Loss report generated');
});

const getTaxSettings = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const settings = await TaxSettings.getForRestaurant(rid);
  return success(res, settings, 'Tax settings retrieved');
});

const updateTaxSettings = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const settings = await TaxSettings.getForRestaurant(rid);
  const fields = ['vatRate', 'serviceChargeRate', 'enabled', 'taxType', 'pricingMode'];
  for (const f of fields) {
    if (req.body[f] !== undefined) settings[f] = req.body[f];
  }
  await settings.save();
  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'tax_settings_update',
    resource: 'system',
    details: { vatRate: settings.vatRate, serviceChargeRate: settings.serviceChargeRate },
    ipAddress: req.ip,
  });
  return success(res, settings, 'Tax settings updated');
});

const getTaxReport = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  let from;
  let to;
  try {
    ({ from, to } = parseDateRange(req.query));
  } catch (e) {
    return error(res, e.message, 400);
  }
  const restaurantId = asObjectId(rid);
  const [agg] = await SalesReport.aggregate([
    { $match: { restaurantId, branchId: req.branchId, soldAt: { $gte: from, $lte: to } } },
    ...buildSalesReportDedupePipeline(),
    {
      $group: {
        _id: null,
        taxableAmount: { $sum: '$netRevenue' },
        taxCollected: { $sum: '$taxAmount' },
      },
    },
  ]);
  const settings = await TaxSettings.getForRestaurant(rid);
  const doc = await TaxReport.create({
    restaurantId: rid,
    fromDate: from,
    toDate: to,
    taxType: settings.taxType,
    taxableAmount: Number(agg?.taxableAmount || 0),
    taxCollected: Number(agg?.taxCollected || 0),
    serviceChargeCollected: 0,
  });
  return success(res, doc, 'Tax report generated');
});

const listFinancialPeriodLocks = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const filter = { restaurantId: rid };
  if (req.branchId) filter.$or = [{ branchId: req.branchId }, { branchId: null }];
  if (req.query.active !== undefined) filter.isActive = req.query.active !== 'false';
  const rows = await FinancialPeriodLock.find(filter).sort({ periodStart: -1 }).limit(100);
  return success(res, rows, 'Financial period locks retrieved');
});

const lockFinancialPeriod = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const periodStart = dateOrNull(req.body.periodStart || req.body.from);
  const periodEnd = dateOrNull(req.body.periodEnd || req.body.to);
  if (!periodStart || !periodEnd || periodStart > periodEnd) {
    return error(res, 'Valid periodStart and periodEnd are required', 400);
  }
  let approvalDoc;
  try {
    approvalDoc = await accountingSecurity.createApproval(req, {
      action: 'expense',
      resourceType: 'financial_period_lock',
      approval: req.body.approval || req.body.managerApproval || {},
      metadata: { periodStart, periodEnd, reason: req.body.reason || '' },
    });
  } catch (e) {
    return error(res, e.message, e.statusCode || 403);
  }
  const row = await FinancialPeriodLock.create({
    restaurantId: rid,
    branchId: req.body.restaurantWide === true || req.body.restaurantWide === 'true' ? null : req.branchId,
    periodStart,
    periodEnd,
    reason: req.body.reason || '',
    lockedBy: approvalDoc.approvedBy || req.user.id,
    lockedByModel: approvalDoc.approvedByModel || authModel(req),
    isActive: true,
  });
  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'financial_period_lock',
    resource: 'system',
    resourceId: row._id,
    details: { periodStart, periodEnd, reason: row.reason },
    ipAddress: req.ip,
  });
  return success(res, row, 'Financial period locked', 201);
});

const unlockFinancialPeriod = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const row = await FinancialPeriodLock.findOne({ _id: req.params.id, restaurantId: rid, isActive: true });
  if (!row) return error(res, 'Financial period lock not found', 404);
  try {
    await accountingSecurity.createApproval(req, {
      action: 'expense',
      resourceType: 'financial_period_unlock',
      resourceId: row._id,
      approval: req.body.approval || req.body.managerApproval || {},
      metadata: { periodStart: row.periodStart, periodEnd: row.periodEnd, reason: req.body.reason || '' },
    });
  } catch (e) {
    return error(res, e.message, e.statusCode || 403);
  }
  row.isActive = false;
  await row.save();
  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'financial_period_unlock',
    resource: 'system',
    resourceId: row._id,
    details: { periodStart: row.periodStart, periodEnd: row.periodEnd },
    ipAddress: req.ip,
  });
  return success(res, row, 'Financial period unlocked');
});

const createInventoryItem = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const {
    name,
    unit,
    quantity,
    openingStock,
    minimumStock,
    costPerUnit,
    supplier,
    supplierId,
    category,
    purchaseUnit,
    conversionFactor,
    manufacturingDate,
    expiryDate,
    notes,
    invoiceDocumentUrl,
  } = req.body;
  if (!name) return error(res, 'name is required', 400);
  const qtyCheck = validateNonNegativeQuantity(quantity ?? openingStock ?? 0, 'Opening stock');
  if (!qtyCheck.ok) return error(res, qtyCheck.message, 400);
  const qty = qtyCheck.value;
  const costCheck = validateNonNegativeQuantity(costPerUnit ?? 0, 'Cost per unit');
  if (!costCheck.ok) return error(res, costCheck.message, 400);
  let row;
  try {
    row = await InventoryItem.create({
      restaurantId: rid,
      branchId: req.branchId,
      name,
      unit,
      quantity: qty,
      openingStock: Number(openingStock ?? qty ?? 0),
      minimumStock: Number(minimumStock || 0),
      costPerUnit: costCheck.value,
      supplier,
      supplierId: supplierId || null,
      category,
      purchaseUnit: purchaseUnit || '',
      conversionFactor: Number(conversionFactor || 1),
      manufacturingDate: manufacturingDate ? new Date(manufacturingDate) : null,
      expiryDate: expiryDate ? new Date(expiryDate) : null,
      notes: notes || '',
      invoiceDocumentUrl: invoiceDocumentUrl || req.file?.path || '',
    });
  } catch (err) {
    if (err && err.code === 11000) {
      return error(
        res,
        'An inventory item with this name already exists for this restaurant or branch. If you are sure it is new, restart the server once so legacy database indexes can sync, then try again.',
        409,
      );
    }
    throw err;
  }
  if (qty > 0) {
    await InventoryLog.create({
      restaurantId: rid,
      branchId: req.branchId,
      inventoryItemId: row._id,
      type: 'stock_in',
      quantity: qty,
      totalCost: qty * Number(row.costPerUnit || 0),
      note: 'Opening stock',
      createdBy: req.user.id,
      createdByModel: authModel(req),
    });
  }
  await notifyLowStockLine(rid, row);
  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'inventory_item_create',
    resource: 'system',
    resourceId: row._id,
    details: { name: row.name, quantity: row.quantity, costPerUnit: row.costPerUnit },
    ipAddress: req.ip,
  });
  return success(res, row, 'Inventory item created', 201);
});

const getInventoryItems = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const page = readNumber(req.query.page, { min: 1, max: 10000, integer: true, fallback: 1 });
  const limit = readNumber(req.query.limit, { min: 1, max: 100, integer: true, fallback: 50 });
  const filter = { restaurantId: rid, isDeleted: false, ...inventoryBranchItemFilter(req.branchId) };
  const nameRegex = readSearchRegex(req.query.q);
  if (nameRegex) filter.name = nameRegex;
  const skip = (page - 1) * limit;
  const [rows, total, allForSummary] = await Promise.all([
    InventoryItem.find(filter).populate('supplierId', 'name phone panVat paymentDue').sort({ createdAt: -1 }).skip(skip).limit(limit),
    InventoryItem.countDocuments(filter),
    InventoryItem.find(filter).select('quantity minimumStock costPerUnit expiryDate').lean(),
  ]);
  const valuation = allForSummary.reduce((s, x) => s + Number(x.quantity || 0) * Number(x.costPerUnit || 0), 0);
  const lowStock = allForSummary.filter(
    (x) => Number(x.minimumStock || 0) > 0 && Number(x.quantity || 0) <= Number(x.minimumStock || 0),
  ).length;
  const deadStock = allForSummary.filter((x) => Number(x.quantity || 0) === 0).length;
  const now = new Date();
  const next7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const expiringSoon = allForSummary.filter((x) => x.expiryDate && new Date(x.expiryDate) <= next7).length;
  return success(
    res,
    { items: rows, valuation, lowStock, deadStock, expiringSoon, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    'Inventory retrieved',
  );
});

const updateInventoryItem = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const row = await InventoryItem.findOne({
    _id: req.params.id,
    restaurantId: rid,
    isDeleted: false,
    ...inventoryBranchItemFilter(req.branchId),
  });
  if (!row) return error(res, 'Inventory item not found', 404);
  try {
    await accountingSecurity.assertPeriodOpen({ restaurantId: rid, branchId: req.branchId, date: new Date() });
  } catch (e) {
    return error(res, e.message, e.statusCode || 400);
  }
  const beforeQty = Number(row.quantity || 0);
  const fields = [
    'name',
    'unit',
    'quantity',
    'openingStock',
    'minimumStock',
    'costPerUnit',
    'supplier',
    'supplierId',
    'category',
    'purchaseUnit',
    'conversionFactor',
    'manufacturingDate',
    'expiryDate',
    'notes',
    'invoiceDocumentUrl',
  ];
  for (const f of fields) {
    if (req.body[f] === undefined) continue;
    if (['quantity', 'openingStock', 'minimumStock', 'costPerUnit', 'conversionFactor'].includes(f)) {
      const check = validateNonNegativeQuantity(req.body[f], f);
      if (!check.ok) return error(res, check.message, 400);
      row[f] = check.value;
    }
    else if (['manufacturingDate', 'expiryDate'].includes(f)) row[f] = req.body[f] ? new Date(req.body[f]) : null;
    else if (f === 'supplierId') row[f] = req.body[f] || null;
    else row[f] = req.body[f];
  }
  await row.save();
  if (req.body.quantity !== undefined) {
    const qty = Number(row.quantity || 0) - beforeQty;
    if (qty !== 0) {
      let approvalDoc = null;
      try {
        approvalDoc = await accountingSecurity.createApproval(req, {
          action: 'stock_adjustment',
          resourceType: 'inventory_item',
          resourceId: row._id,
          approval: req.body.approval || req.body.managerApproval || {},
          metadata: { beforeQty, afterQty: row.quantity, delta: qty, item: row.name },
        });
      } catch (e) {
        return error(res, e.message, e.statusCode || 403);
      }
      await InventoryLog.create({
        restaurantId: rid,
        branchId: req.branchId,
        inventoryItemId: row._id,
        type: 'adjustment',
        quantity: Math.abs(qty),
        totalCost: Math.abs(qty) * Number(row.costPerUnit || 0),
        note: qty > 0 ? 'Stock increase (manual)' : 'Stock decrease (manual)',
        approval: approvalDoc._id,
        createdBy: req.user.id,
        createdByModel: authModel(req),
      });
    }
  }
  await notifyLowStockLine(rid, row);
  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'inventory_item_update',
    resource: 'system',
    resourceId: row._id,
    details: { name: row.name, beforeQty, afterQty: row.quantity },
    ipAddress: req.ip,
  });
  return success(res, row, 'Inventory item updated');
});

const deleteInventoryItem = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const row = await InventoryItem.findOne({
    _id: req.params.id,
    restaurantId: rid,
    isDeleted: false,
    ...inventoryBranchItemFilter(req.branchId),
  });
  if (!row) return error(res, 'Inventory item not found', 404);
  row.isDeleted = true;
  await row.save();
  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'inventory_item_delete',
    resource: 'system',
    resourceId: row._id,
    details: { name: row.name },
    ipAddress: req.ip,
  });
  return success(res, null, 'Inventory item deleted');
});

const getCashBookBalances = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const r = await Restaurant.findById(rid).select('settings.cashBalance settings.bankBalance').lean();
  return success(
    res,
    {
      cashBalance: Number(r?.settings?.cashBalance || 0),
      bankBalance: Number(r?.settings?.bankBalance || 0),
    },
    'Cash book balances',
  );
});

const patchCashBookBalances = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  if (req.body.cashBalance === undefined && req.body.bankBalance === undefined) {
    return error(res, 'Provide cashBalance and/or bankBalance to set opening figures', 400);
  }
  const r = await Restaurant.findById(rid);
  if (!r) return error(res, 'Restaurant not found', 404);
  if (req.body.cashBalance !== undefined) {
    const v = Number(req.body.cashBalance);
    if (!Number.isFinite(v)) return error(res, 'cashBalance must be a number', 400);
    r.settings.cashBalance = v;
  }
  if (req.body.bankBalance !== undefined) {
    const v = Number(req.body.bankBalance);
    if (!Number.isFinite(v)) return error(res, 'bankBalance must be a number', 400);
    r.settings.bankBalance = v;
  }
  r.markModified('settings');
  await r.save();
  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'cash_book_manual_set',
    resource: 'system',
    resourceId: r._id,
    details: {
      cashBalance: r.settings.cashBalance,
      bankBalance: r.settings.bankBalance,
    },
    ipAddress: req.ip,
  });
  return success(
    res,
    { cashBalance: Number(r.settings.cashBalance || 0), bankBalance: Number(r.settings.bankBalance || 0) },
    'Cash book updated',
  );
});

const addInventoryPurchase = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const {
    inventoryItemId,
    quantity,
    unitCost,
    supplier,
    supplierId,
    taxAmount,
    vatPercent,
    paymentStatus,
    supplierBillNumber,
    invoiceDocumentUrl,
    notes,
    purchasedAt,
    paymentSource,
  } = req.body;
  if (!inventoryItemId || quantity === undefined || unitCost === undefined) {
    return error(res, 'inventoryItemId, quantity and unitCost are required', 400);
  }
  if (!mongoose.Types.ObjectId.isValid(String(inventoryItemId))) {
    return error(res, 'Please select a valid inventory item', 400);
  }
  const item = await InventoryItem.findOne({
    _id: inventoryItemId,
    restaurantId: rid,
    isDeleted: false,
    ...inventoryBranchItemFilter(req.branchId),
  });
  if (!item) return error(res, 'Inventory item not found', 404);
  try {
    await accountingSecurity.assertPeriodOpen({ restaurantId: rid, branchId: req.branchId, date: purchasedAt || new Date() });
  } catch (e) {
    return error(res, e.message, e.statusCode || 400);
  }
  if (supplierId) {
    const Supplier = require('../models/restaurant/Supplier');
    const supplierDoc = await Supplier.findOne({ _id: supplierId, restaurantId: rid, isDeleted: false });
    if (!supplierDoc || supplierDoc.verificationStatus !== 'verified') {
      return error(res, 'Supplier must be verified before recording purchases', 403);
    }
  }
  const qtyCheck = validatePositiveQuantity(quantity, 'Purchase quantity');
  if (!qtyCheck.ok) return error(res, qtyCheck.message, 400);
  const q = qtyCheck.value;
  const c = Number(unitCost);
  if (!Number.isFinite(c) || c < 0) return error(res, 'unitCost must be a non-negative number', 400);
  const tax = Number(taxAmount || 0);
  const lineTotal = q * c;
  const ps = String(paymentSource || 'cash').toLowerCase() === 'bank' ? 'bank' : 'cash';
  let approvalDoc = null;
  if (lineTotal + tax >= Number(process.env.PURCHASE_APPROVAL_AMOUNT || 10000) || req.body.requiresApproval === true) {
    try {
      approvalDoc = await accountingSecurity.createApproval(req, {
        action: 'purchase',
        resourceType: 'inventory_purchase',
        approval: req.body.approval || req.body.managerApproval || {},
        metadata: { inventoryItemId, quantity: q, unitCost: c, totalCost: lineTotal + tax },
      });
    } catch (e) {
      return error(res, e.message, e.statusCode || 403);
    }
  }
  const stockBefore = Number(item.quantity || 0);
  const avgBefore = Number(item.costPerUnit || 0);
  item.quantity = roundQty(stockBefore + q);
  item.costPerUnit = computeWeightedAverageCost(stockBefore, avgBefore, q, c);
  if (supplier) item.supplier = supplier;
  if (supplierId) item.supplierId = supplierId;
  await item.save();

  const purchase = await InventoryPurchase.create({
    restaurantId: rid,
    inventoryItemId: item._id,
    supplierId: supplierId || null,
    quantity: q,
    unitCost: c,
    totalCost: lineTotal,
    taxAmount: tax,
    vatPercent: Number(vatPercent || 0),
    supplier: supplier || item.supplier || '',
    supplierBillNumber: supplierBillNumber || '',
    paymentStatus: paymentStatus || 'paid',
    paymentSource: ps,
    invoiceDocumentUrl: invoiceDocumentUrl || '',
    notes: notes || '',
    purchasedAt: purchasedAt ? new Date(purchasedAt) : new Date(),
    createdBy: req.user.id,
    createdByModel: authModel(req),
    approval: approvalDoc?._id || null,
    validationStatus: 'validated',
  });
  await InventoryLog.create({
    restaurantId: rid,
    branchId: req.branchId,
    inventoryItemId: item._id,
    type: 'purchase',
    quantity: q,
    totalCost: lineTotal,
    linkedPurchaseId: purchase._id,
    referenceNumber: supplierBillNumber || '',
    note: notes || 'Purchased from supplier',
    createdBy: req.user.id,
    createdByModel: authModel(req),
  });
  await notifyLowStockLine(rid, item);
  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'inventory_purchase_create',
    resource: 'system',
    resourceId: purchase._id,
    details: { itemId: item._id, item: item.name, quantity: q, totalCost: lineTotal },
    ipAddress: req.ip,
  });
  await applyPurchaseCreate(rid, purchase);
  return success(res, purchase, 'Inventory purchase recorded', 201);
});

/**
 * Update an existing purchase entry. Reverses the old stock delta and applies
 * the new quantity to keep `InventoryItem.quantity` consistent. A compensating
 * `adjustment` log row is written so the audit trail shows what moved.
 */
const updateInventoryPurchase = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const purchase = await InventoryPurchase.findOne({ _id: req.params.id, restaurantId: rid });
  if (!purchase) return error(res, 'Purchase not found', 404);
  try {
    await accountingSecurity.assertPeriodOpen({ restaurantId: rid, branchId: req.branchId, date: purchase.purchasedAt });
  } catch (e) {
    return error(res, e.message, e.statusCode || 400);
  }

  const cashBookBefore = {
    paymentStatus: purchase.paymentStatus,
    paymentSource: purchase.paymentSource || 'cash',
    totalCost: purchase.totalCost,
    taxAmount: purchase.taxAmount,
  };

  const item = await InventoryItem.findOne({
    _id: purchase.inventoryItemId,
    restaurantId: rid,
    isDeleted: false,
    ...inventoryBranchItemFilter(req.branchId),
  });
  if (!item) return error(res, 'Inventory item not found', 404);

  const oldQty = Number(purchase.quantity || 0);
  const oldCost = Number(purchase.unitCost || 0);
  const newQty = req.body.quantity !== undefined ? Number(req.body.quantity) : oldQty;
  if (!Number.isFinite(newQty) || newQty <= 0) {
    return error(res, 'quantity must be a positive number', 400);
  }
  const newCost = req.body.unitCost !== undefined ? Number(req.body.unitCost) : oldCost;
  if (!Number.isFinite(newCost) || newCost < 0) {
    return error(res, 'unitCost must be a non-negative number', 400);
  }
  const newTax = req.body.taxAmount !== undefined ? Number(req.body.taxAmount || 0) : Number(purchase.taxAmount || 0);

  const delta = newQty - oldQty;
  const currentQty = Number(item.quantity || 0);
  if (delta < 0 && currentQty + delta < 0) {
    return error(
      res,
      insufficientStockError(currentQty, oldQty - newQty, item.unit),
      400,
    );
  }
  if (delta !== 0) {
    item.quantity = roundQty(Math.max(0, currentQty + delta));
  }
  item.costPerUnit = replacePurchaseInAverage(
    currentQty,
    Number(item.costPerUnit || 0),
    oldQty,
    oldCost,
    newQty,
    newCost,
  );
  if (req.body.supplier !== undefined) item.supplier = req.body.supplier;
  if (req.body.supplierId !== undefined) item.supplierId = req.body.supplierId || null;
  await item.save();

  purchase.quantity = newQty;
  purchase.unitCost = newCost;
  purchase.totalCost = newQty * newCost;
  purchase.taxAmount = newTax;
  if (req.body.vatPercent !== undefined) purchase.vatPercent = Number(req.body.vatPercent || 0);
  if (req.body.supplier !== undefined) purchase.supplier = req.body.supplier;
  if (req.body.supplierId !== undefined) purchase.supplierId = req.body.supplierId ? readObjectId(req.body.supplierId) : null;
  if (req.body.supplierBillNumber !== undefined) purchase.supplierBillNumber = req.body.supplierBillNumber;
  if (req.body.paymentStatus !== undefined) purchase.paymentStatus = req.body.paymentStatus;
  if (req.body.paymentSource !== undefined) {
    purchase.paymentSource = String(req.body.paymentSource).toLowerCase() === 'bank' ? 'bank' : 'cash';
  }
  if (req.body.invoiceDocumentUrl !== undefined) purchase.invoiceDocumentUrl = req.body.invoiceDocumentUrl;
  if (req.body.notes !== undefined) purchase.notes = req.body.notes;
  if (req.body.purchasedAt !== undefined) {
    purchase.purchasedAt = req.body.purchasedAt ? new Date(req.body.purchasedAt) : purchase.purchasedAt;
  }
  await purchase.save();

  await applyPurchaseReplace(rid, cashBookBefore, purchase.toObject());

  const purchaseLog = await InventoryLog.findOne({
    restaurantId: rid,
    linkedPurchaseId: purchase._id,
    type: 'purchase',
  });
  if (false && purchaseLog) {
    purchaseLog.quantity = newQty;
    purchaseLog.totalCost = newQty * newCost;
    if (req.body.supplierBillNumber !== undefined) purchaseLog.referenceNumber = req.body.supplierBillNumber || '';
    if (req.body.notes !== undefined) purchaseLog.note = req.body.notes || 'Purchased from supplier';
    await purchaseLog.save();
  } else if (delta !== 0) {
    await InventoryLog.create({
      restaurantId: rid,
      branchId: req.branchId,
      inventoryItemId: item._id,
      type: 'adjustment',
      quantity: Math.abs(delta),
      totalCost: Math.abs(delta) * newCost,
      linkedPurchaseId: purchase._id,
      referenceNumber: purchase.supplierBillNumber || '',
      note: `Purchase edited — qty ${oldQty} → ${newQty}`,
      createdBy: req.user.id,
      createdByModel: authModel(req),
    });
  }
  await notifyLowStockLine(rid, item);
  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'inventory_purchase_update',
    resource: 'system',
    resourceId: purchase._id,
    details: { itemId: item._id, item: item.name, oldQty, newQty, newCost },
    ipAddress: req.ip,
  });
  return success(res, purchase, 'Purchase updated');
});

/**
 * Delete a purchase entry. Reverses the stock that was added by the original
 * purchase (clamped at 0 so stock never goes negative) and writes a
 * compensating adjustment log so historical reports stay consistent.
 */
const deleteInventoryPurchase = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const purchase = await InventoryPurchase.findOne({ _id: req.params.id, restaurantId: rid });
  if (!purchase) return error(res, 'Purchase not found', 404);
  try {
    await accountingSecurity.assertPeriodOpen({ restaurantId: rid, branchId: req.branchId, date: purchase.purchasedAt });
  } catch (e) {
    return error(res, e.message, e.statusCode || 400);
  }

  const item = await InventoryItem.findOne({
    _id: purchase.inventoryItemId,
    restaurantId: rid,
    isDeleted: false,
    ...inventoryBranchItemFilter(req.branchId),
  });
  const qty = Number(purchase.quantity || 0);
  const unitCost = Number(purchase.unitCost || 0);
  if (item && qty > 0) {
    const currentQty = Number(item.quantity || 0);
    if (currentQty < qty) {
      return error(
        res,
        `Cannot delete purchase: only ${currentQty} ${item.unit} remain in stock but this purchase added ${qty}. Reduce stock usage first.`,
        400,
      );
    }
    item.quantity = roundQty(currentQty - qty);
    item.costPerUnit = removePurchaseFromAverage(currentQty, Number(item.costPerUnit || 0), qty, unitCost);
    await item.save();
    await InventoryLog.create({
      restaurantId: rid,
      branchId: req.branchId,
      inventoryItemId: item._id,
      type: 'adjustment',
      quantity: qty,
      totalCost: qty * Number(purchase.unitCost || 0),
      referenceNumber: purchase.supplierBillNumber || '',
      note: `Purchase deleted — reversed ${qty} ${item.unit}`,
      createdBy: req.user.id,
      createdByModel: authModel(req),
    });
    await notifyLowStockLine(rid, item);
  }
  await applyPurchaseDelete(rid, purchase);
  await purchase.deleteOne();
  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'inventory_purchase_delete',
    resource: 'system',
    resourceId: req.params.id,
    details: { itemId: item?._id, quantityReverted: qty },
    ipAddress: req.ip,
  });
  return success(res, null, 'Purchase deleted and stock reversed');
});

module.exports = {
  getSales,
  getSalesAnalytics,
  getSalesTopItems,
  syncSalesFromCompletedOrders,
  createExpense,
  getExpenses,
  updateExpense,
  deleteExpense,
  getProfitLoss,
  getTaxSettings,
  updateTaxSettings,
  getTaxReport,
  listFinancialPeriodLocks,
  lockFinancialPeriod,
  unlockFinancialPeriod,
  createInventoryItem,
  getInventoryItems,
  updateInventoryItem,
  deleteInventoryItem,
  addInventoryPurchase,
  updateInventoryPurchase,
  deleteInventoryPurchase,
  getCashBookBalances,
  patchCashBookBalances,
};

