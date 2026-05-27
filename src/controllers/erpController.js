const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const { success, error } = require('../utils/apiResponse');
const resolveRestaurantId = require('../middleware/restaurant/resolveRestaurantId');
const Supplier = require('../models/restaurant/Supplier');
const Budget = require('../models/restaurant/Budget');
const Expense = require('../models/restaurant/Expense');
const SalesReport = require('../models/restaurant/SalesReport');
const InventoryItem = require('../models/restaurant/InventoryItem');
const InventoryLog = require('../models/restaurant/InventoryLog');
const InventoryPurchase = require('../models/restaurant/InventoryPurchase');
const Payroll = require('../models/restaurant/Payroll');
const Employee = require('../models/restaurant/Employee');
const CustomerOrder = require('../models/restaurant/CustomerOrder');
const TdsSettings = require('../models/restaurant/TdsSettings');
const ChartOfAccount = require('../models/restaurant/ChartOfAccount');
const JournalEntry = require('../models/restaurant/JournalEntry');
const AuditLog = require('../models/platform/AuditLog');
const { ensureDefaultCoa } = require('../services/chartOfAccountsService');
const { syncSalesReportsForRestaurant, buildSalesReportDedupePipeline } = require('../services/salesReportService');
const { notifyBudgetExceededIfNeeded } = require('../services/budgetNotifyService');
const { inventoryBranchItemFilter } = require('../utils/inventoryBranchScope');
const { applyCashBookDelta, roundMoney } = require('../services/cashBookService');
const accountingSecurity = require('../services/accountingSecurityService');
const {
  validatePositiveQuantity,
  insufficientStockError,
  roundQty,
} = require('../utils/inventoryStock');
const { readNumber, readObjectId, readSearchRegex, readString } = require('../utils/inputValidation');

function authModel(req) {
  return req.user?.scope === 'employee' ? 'Employee' : 'Restaurant';
}

function asObjectId(v) {
  return new mongoose.Types.ObjectId(String(v));
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

// --- Suppliers ---
const listSuppliers = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const page = readNumber(req.query.page, { min: 1, max: 10000, integer: true, fallback: 1 });
  const limit = readNumber(req.query.limit, { min: 1, max: 100, integer: true, fallback: 50 });
  const filter = { restaurantId: rid, isDeleted: false };
  const [rows, total] = await Promise.all([
    Supplier.find(filter).sort({ name: 1 }).skip((page - 1) * limit).limit(limit),
    Supplier.countDocuments(filter),
  ]);
  return success(res, { items: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } }, 'Suppliers retrieved');
});

const createSupplier = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const { name, phone, email, address, panVat, paymentDue, notes } = req.body;
  if (!name) return error(res, 'name is required', 400);
  const trimmed = String(name).trim();
  const existing = await Supplier.findOne({ restaurantId: rid, isDeleted: false, name: trimmed });
  if (existing) return error(res, 'A supplier with this name already exists', 409);
  const row = await Supplier.create({
    restaurantId: rid,
    name: trimmed,
    phone,
    email,
    address,
    panVat,
    paymentDue: Number(paymentDue || 0),
    notes,
    verificationStatus: 'pending',
  });
  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'supplier_create',
    resource: 'system',
    resourceId: row._id,
    details: { name: row.name, panVat: row.panVat },
    ipAddress: req.ip,
  });
  return success(res, row, 'Supplier created', 201);
});

const updateSupplier = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const row = await Supplier.findOne({ _id: req.params.id, restaurantId: rid, isDeleted: false });
  if (!row) return error(res, 'Supplier not found', 404);
  const fields = ['name', 'phone', 'email', 'address', 'panVat', 'paymentDue', 'notes'];
  for (const f of fields) {
    if (req.body[f] !== undefined) row[f] = f === 'paymentDue' ? Number(req.body[f] || 0) : req.body[f];
  }
  await row.save();
  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'supplier_update',
    resource: 'system',
    resourceId: row._id,
    details: { name: row.name, paymentDue: row.paymentDue },
    ipAddress: req.ip,
  });
  return success(res, row, 'Supplier updated');
});

const deleteSupplier = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const row = await Supplier.findOne({ _id: req.params.id, restaurantId: rid, isDeleted: false });
  if (!row) return error(res, 'Supplier not found', 404);
  row.isDeleted = true;
  await row.save();
  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'supplier_delete',
    resource: 'system',
    resourceId: row._id,
    details: { name: row.name },
    ipAddress: req.ip,
  });
  return success(res, null, 'Supplier deleted');
});

const verifySupplier = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const row = await Supplier.findOne({ _id: req.params.id, restaurantId: rid, isDeleted: false });
  if (!row) return error(res, 'Supplier not found', 404);
  const status = req.body.status === 'rejected' ? 'rejected' : 'verified';
  let approvalDoc;
  try {
    approvalDoc = await accountingSecurity.createApproval(req, {
      action: 'supplier',
      resourceType: 'supplier',
      resourceId: row._id,
      approval: req.body.approval || req.body.managerApproval || {},
      metadata: { supplier: row.name, status, reason: req.body.reason || '' },
    });
  } catch (e) {
    return error(res, e.message, e.statusCode || 403);
  }
  row.verificationStatus = status;
  row.verifiedAt = status === 'verified' ? new Date() : null;
  row.verifiedBy = approvalDoc.approvedBy;
  row.verifiedByModel = approvalDoc.approvedByModel;
  await row.save();
  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'supplier_verify',
    resource: 'system',
    resourceId: row._id,
    details: { name: row.name, status },
    ipAddress: req.ip,
  });
  return success(res, row, 'Supplier verification updated');
});

// --- Inventory reports ---
const getInventoryReportSummary = asyncHandler(async (req, res) => {
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
  const branchItemIds = await InventoryItem.find({
    restaurantId: rid,
    isDeleted: false,
    ...inventoryBranchItemFilter(req.branchId),
  }).distinct('_id');

  const branchPurchaseMatch = branchItemIds.length
    ? { inventoryItemId: { $in: branchItemIds } }
    : { inventoryItemId: { $in: [] } };

  const [purchaseAgg, logByType, purchasesPending] = await Promise.all([
    InventoryPurchase.aggregate([
      {
        $match: {
          restaurantId,
          purchasedAt: { $gte: from, $lte: to },
          ...branchPurchaseMatch,
        },
      },
      { $group: { _id: null, total: { $sum: '$totalCost' }, tax: { $sum: '$taxAmount' } } },
    ]),
    InventoryLog.aggregate([
      {
        $match: {
          restaurantId,
          inventoryItemId: { $in: branchItemIds },
          createdAt: { $gte: from, $lte: to },
        },
      },
      { $group: { _id: '$type', qty: { $sum: '$quantity' }, cost: { $sum: '$totalCost' } } },
    ]),
    InventoryPurchase.countDocuments({
      restaurantId,
      paymentStatus: 'pending',
      ...branchPurchaseMatch,
    }),
  ]);

  return success(
    res,
    {
      range: { from, to },
      purchases: {
        subtotal: Number(purchaseAgg[0]?.total || 0),
        tax: Number(purchaseAgg[0]?.tax || 0),
        pendingBills: purchasesPending,
      },
      ledgerByType: logByType,
    },
    'Inventory report summary',
  );
});

const listInventoryLogs = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const branchItemIds = await InventoryItem.find({
    restaurantId: rid,
    isDeleted: false,
    ...inventoryBranchItemFilter(req.branchId),
  }).distinct('_id');

  const base = { restaurantId: rid };
  if (req.query.type) base.type = req.query.type;
  if (req.query.inventoryItemId) {
    const wanted = String(req.query.inventoryItemId);
    if (!branchItemIds.map(String).includes(wanted)) {
      return success(res, [], 'Inventory transactions retrieved');
    }
    base.inventoryItemId = wanted;
  } else {
    base.inventoryItemId = { $in: branchItemIds };
  }
  if (req.query.from || req.query.to) {
    base.createdAt = {};
    if (req.query.from) base.createdAt.$gte = new Date(req.query.from);
    if (req.query.to) base.createdAt.$lte = new Date(req.query.to);
  }

  const q = readSearchRegex(req.query.q);
  let filter = base;
  if (q) {
    const nameMatched = await InventoryItem.find({
      _id: { $in: branchItemIds },
      name: q,
    }).distinct('_id');
    const textOr = [
      { note: q },
      { referenceNumber: q },
    ];
    if (nameMatched.length) textOr.push({ inventoryItemId: { $in: nameMatched } });
    filter = { $and: [base, { $or: textOr }] };
  }

  const rows = await InventoryLog.find(filter)
    .populate('inventoryItemId', 'name unit category costPerUnit')
    .populate({ path: 'createdBy', select: 'name businessName email', strictPopulate: false })
    .sort({ createdAt: -1 })
    .limit(readNumber(req.query.limit, { min: 1, max: 200, integer: true, fallback: 100 }));
  const enriched = rows.map((row) => {
    const doc = row.toObject();
    const creator = doc.createdBy;
    doc.createdByName =
      creator?.name || creator?.businessName || creator?.email || (doc.createdByModel === 'Restaurant' ? 'Owner' : 'Staff');
    return doc;
  });
  return success(res, enriched, 'Inventory transactions retrieved');
});

const listInventoryPurchases = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const branchItemIds = await InventoryItem.find({
    restaurantId: rid,
    isDeleted: false,
    ...inventoryBranchItemFilter(req.branchId),
  }).distinct('_id');
  const filter = { restaurantId: rid, inventoryItemId: { $in: branchItemIds } };
  const supplierId = readObjectId(req.query.supplierId);
  const paymentStatus = readString(req.query.paymentStatus, { max: 32 });
  if (supplierId) filter.supplierId = supplierId;
  if (paymentStatus) filter.paymentStatus = paymentStatus;
  const rows = await InventoryPurchase.find(filter)
    .populate('inventoryItemId', 'name unit category')
    .populate('supplierId', 'name phone panVat paymentDue')
    .sort({ purchasedAt: -1, createdAt: -1 })
    .limit(readNumber(req.query.limit, { min: 1, max: 200, integer: true, fallback: 100 }));
  return success(res, rows, 'Inventory purchases retrieved');
});

const postInventoryWastageOrAdjustment = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const { inventoryItemId, quantity, type, note, reason, referenceNumber } = req.body;
  if (!inventoryItemId || quantity === undefined || !type) {
    return error(res, 'inventoryItemId, quantity and type are required', 400);
  }
  if (!mongoose.Types.ObjectId.isValid(String(inventoryItemId))) {
    return error(res, 'Please select a valid inventory item', 400);
  }
  if (!['stock_in', 'stock_out', 'usage', 'wastage', 'adjustment'].includes(type)) {
    return error(res, 'type must be stock_in, stock_out, usage, wastage or adjustment', 400);
  }
  if (req.body.stockUpdateAction === 'left' && type !== 'usage') {
    return error(res, 'Left item must decrease stock as a usage movement', 400);
  }
  const qtyCheck = validatePositiveQuantity(quantity, 'Quantity');
  if (!qtyCheck.ok) return error(res, qtyCheck.message, 400);
  const q = qtyCheck.value;
  try {
    await accountingSecurity.assertPeriodOpen({ restaurantId: rid, branchId: req.branchId, date: new Date() });
  } catch (e) {
    return error(res, e.message, e.statusCode || 400);
  }

  const item = await InventoryItem.findOne({
    _id: inventoryItemId,
    restaurantId: rid,
    isDeleted: false,
    ...inventoryBranchItemFilter(req.branchId),
  });
  if (!item) return error(res, 'Inventory item not found', 404);

  const available = Number(item.quantity || 0);
  const isLeftStockReturn =
    type === 'stock_in' &&
    (req.body.leftStockReturn === true ||
      req.body.leftStockReturn === 'true' ||
      req.body.offsetLatestUsage === true ||
      req.body.offsetLatestUsage === 'true');

  if (isLeftStockReturn) {
    return error(
      res,
      'Inventory usage logs are immutable. Record returned stock as a new stock_in movement with manager approval.',
      409,
    );
  }

  let approvalDoc = null;
  if (['stock_in', 'stock_out', 'wastage', 'adjustment'].includes(type)) {
    try {
      approvalDoc = await accountingSecurity.createApproval(req, {
        action: 'stock_adjustment',
        resourceType: 'inventory_item',
        resourceId: item._id,
        approval: req.body.approval || req.body.managerApproval || {},
        metadata: { item: item.name, type, quantity: q, reason: reason || note || '' },
      });
    } catch (e) {
      return error(res, e.message, e.statusCode || 403);
    }
  }

  if (false && isLeftStockReturn) {
    let remainingReturnQty = q;
    const usageLogs = await InventoryLog.find({
      restaurantId: rid,
      branchId: req.branchId,
      inventoryItemId: item._id,
      type: 'usage',
      quantity: { $gt: 0 },
    }).sort({ createdAt: -1 });

    for (const usageLog of usageLogs) {
      if (remainingReturnQty <= 0) break;
      const oldQuantity = Number(usageLog.quantity || 0);
      const correctedBy = Math.min(oldQuantity, remainingReturnQty);
      const oldAmount = Number(usageLog.totalCost || 0);
      usageLog.quantity = Number((oldQuantity - correctedBy).toFixed(6));
      usageLog.totalCost = usageLog.quantity * Number(item.costPerUnit || 0);
      const leftNote = `left stock returned ${correctedBy} ${item.unit || ''}`.trim();
      usageLog.note = usageLog.note ? `${usageLog.note}; ${leftNote}` : leftNote;
      await usageLog.save();
      await syncInventoryUsageExpense(req, rid, usageLog, item, oldAmount);
      remainingReturnQty = Number((remainingReturnQty - correctedBy).toFixed(6));
    }

    const correctedUsageQty = Number((q - remainingReturnQty).toFixed(6));
    const extraStockInQty = Math.max(0, remainingReturnQty);
    item.quantity = available + q;
    await item.save();

    let returnLog = null;
    if (extraStockInQty > 0) {
      returnLog = await InventoryLog.create({
        restaurantId: rid,
        branchId: req.branchId,
        inventoryItemId: item._id,
        type: 'stock_in',
        quantity: extraStockInQty,
        totalCost: extraStockInQty * Number(item.costPerUnit || 0),
        referenceNumber: referenceNumber || '',
        note: note || reason || 'Left stock returned',
        createdBy: req.user.id,
        createdByModel: authModel(req),
      });
    }

    await AuditLog.create({
      user: req.user.id,
      userModel: authModel(req),
      action: 'inventory_left_stock_return',
      resource: 'system',
      resourceId: item._id,
      details: {
        item: item.name,
        before: available,
        after: item.quantity,
        returnedQuantity: q,
        correctedUsageQty,
        stockInQty: extraStockInQty,
      },
      ipAddress: req.ip,
    });

    return success(
      res,
      { item, movedQty: q, correctedUsageQty, stockInQty: extraStockInQty, log: returnLog },
      'Left stock added and previous usage corrected',
      201,
    );
  }

  const isIncrease = type === 'stock_in' || (type === 'adjustment' && req.body.direction === 'increase');
  if (!isIncrease && q > available) {
    return error(res, insufficientStockError(available, q, item.unit), 400);
  }
  const movedQty = q;
  const totalCost = movedQty * Number(item.costPerUnit || 0);
  const syncWastageExpense =
    type === 'wastage' &&
    (req.body.syncWastageExpense === undefined ||
      req.body.syncWastageExpense === true ||
      req.body.syncWastageExpense === 'true');
  const syncIngredientsExpense =
    type === 'usage' &&
    (req.body.syncIngredientsExpense === undefined ||
      req.body.syncIngredientsExpense === true ||
      req.body.syncIngredientsExpense === 'true');
  const ingredientsPaidFrom =
    String(req.body.ingredientsPaidFrom || 'cash').toLowerCase() === 'bank' ? 'bank' : 'cash';

  item.quantity = isIncrease ? available + movedQty : Math.max(0, available - movedQty);
  await item.save();

  const log = await InventoryLog.create({
    restaurantId: rid,
    branchId: req.branchId,
    inventoryItemId: item._id,
    type,
    quantity: movedQty,
    totalCost,
    referenceNumber: referenceNumber || '',
    note:
      type === 'adjustment'
        ? note || reason || (isIncrease ? 'Stock increase (adjustment)' : 'Stock decrease (adjustment)')
        : note || reason || '',
    createdBy: req.user.id,
    createdByModel: authModel(req),
    approval: approvalDoc?._id || null,
  });

  let expenseDoc = null;
  if (syncIngredientsExpense && type === 'usage' && movedQty > 0 && totalCost > 0) {
    expenseDoc = await Expense.create({
      restaurantId: rid,
      branchId: req.branchId,
      title: `Raw material use — ${item.name}`,
      amount: totalCost,
      category: 'ingredients',
      paymentMethod: ingredientsPaidFrom === 'bank' ? 'bank_transfer' : 'cash',
      description: `${movedQty} ${item.unit} × ${Number(item.costPerUnit || 0).toFixed(2)} per ${item.unit} = ${totalCost.toFixed(2)}`,
      notes: `source=inventory_usage log=${log._id}`,
      paymentStatus: 'paid',
      expenseDate: new Date(),
      addedBy: req.user.id,
      addedByModel: authModel(req),
      sourceInventoryLogId: log._id,
    });
    const out = roundMoney(totalCost);
    await applyCashBookDelta(
      rid,
      ingredientsPaidFrom === 'bank' ? { bankDelta: -out } : { cashDelta: -out },
    );
    setImmediate(() => notifyBudgetExceededIfNeeded(rid, expenseDoc));
  }

  if (syncWastageExpense && type === 'wastage' && movedQty > 0 && totalCost > 0) {
    expenseDoc = await Expense.create({
      restaurantId: rid,
      branchId: req.branchId,
      title: `Inventory waste — ${item.name}`,
      amount: roundMoney(totalCost),
      category: 'miscellaneous',
      paymentMethod: 'cash',
      description: `${movedQty} ${item.unit} wasted × ${Number(item.costPerUnit || 0).toFixed(2)}`,
      notes: `source=inventory_wastage log=${log._id}`,
      paymentStatus: 'paid',
      expenseDate: new Date(),
      addedBy: req.user.id,
      addedByModel: authModel(req),
      sourceInventoryLogId: log._id,
    });
    setImmediate(() => notifyBudgetExceededIfNeeded(rid, expenseDoc));
  }

  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'inventory_movement',
    resource: 'system',
    resourceId: item._id,
    details: { item: item.name, type, before: available, after: item.quantity, quantity: movedQty },
    ipAddress: req.ip,
  });

  return success(res, { item, movedQty, log, expense: expenseDoc }, 'Inventory movement recorded', 201);
});

function movementIsIncrease(log) {
  if (log.type === 'stock_in') return true;
  if (log.type === 'adjustment' && /increase/i.test(String(log.note || ''))) return true;
  return false;
}

const reverseMovementQuantity = (log) => {
  const q = Number(log.quantity || 0);
  if (movementIsIncrease(log)) return -q;
  if (['stock_out', 'usage', 'wastage', 'adjustment'].includes(log.type)) return q;
  return 0;
};

const applyMovementQuantity = (log, quantity) => {
  const q = Number(quantity || 0);
  if (movementIsIncrease(log)) return q;
  if (['stock_out', 'usage', 'wastage', 'adjustment'].includes(log.type)) return -q;
  return 0;
};

const syncInventoryWastageExpense = async (req, rid, log, item) => {
  if (log.type !== 'wastage') return null;
  const amount = roundMoney(Number(log.totalCost || 0));
  let expense = await Expense.findOne({ sourceInventoryLogId: log._id });
  if (amount <= 0) {
    if (expense && !expense.isDeleted) {
      expense.isDeleted = true;
      expense.notes = `${expense.notes || ''} waste entry removed`;
      await expense.save();
    }
    return null;
  }
  if (!expense) {
    expense = await Expense.create({
      restaurantId: rid,
      branchId: req.branchId,
      title: `Inventory waste — ${item.name}`,
      amount,
      category: 'miscellaneous',
      paymentMethod: 'cash',
      description: `${log.quantity} ${item.unit} wasted × ${Number(item.costPerUnit || 0).toFixed(2)}`,
      notes: `source=inventory_wastage log=${log._id}`,
      paymentStatus: 'paid',
      expenseDate: new Date(),
      addedBy: req.user.id,
      addedByModel: authModel(req),
      sourceInventoryLogId: log._id,
    });
    return expense;
  }
  expense.isDeleted = false;
  expense.amount = amount;
  expense.title = `Inventory waste — ${item.name}`;
  expense.description = `${log.quantity} ${item.unit} wasted × ${Number(item.costPerUnit || 0).toFixed(2)}`;
  await expense.save();
  return expense;
};

const syncInventoryUsageExpense = async (req, rid, log, item, previousAmount = 0) => {
  if (log.type !== 'usage') return null;
  const amount = roundMoney(Number(log.totalCost || 0));
  const ingredientsPaidFrom =
    String(req.body.ingredientsPaidFrom || '').toLowerCase() === 'bank' ? 'bank' : 'cash';
  let expense = await Expense.findOne({ sourceInventoryLogId: log._id });
  const previousPaymentSource = expense?.paymentMethod === 'bank_transfer' ? 'bank' : 'cash';

  if (amount <= 0) {
    if (expense && !expense.isDeleted) {
      await applyCashBookDelta(
        rid,
        previousPaymentSource === 'bank' ? { bankDelta: roundMoney(expense.amount) } : { cashDelta: roundMoney(expense.amount) },
      );
      expense.isDeleted = true;
      expense.notes = `${expense.notes || ''} stock update removed`;
      await expense.save();
    }
    return null;
  }

  if (!expense) {
    expense = await Expense.create({
      restaurantId: rid,
      branchId: req.branchId,
      title: `Stock update use - ${item.name}`,
      amount,
      category: 'ingredients',
      paymentMethod: ingredientsPaidFrom === 'bank' ? 'bank_transfer' : 'cash',
      description: `${log.quantity} ${item.unit} x ${Number(item.costPerUnit || 0).toFixed(2)} per ${item.unit} = ${amount.toFixed(2)}`,
      notes: `source=inventory_usage log=${log._id}`,
      paymentStatus: 'paid',
      expenseDate: new Date(),
      addedBy: req.user.id,
      addedByModel: authModel(req),
      sourceInventoryLogId: log._id,
    });
    await applyCashBookDelta(
      rid,
      ingredientsPaidFrom === 'bank' ? { bankDelta: -amount } : { cashDelta: -amount },
    );
    return expense;
  }

  const oldAmount = roundMoney(previousAmount || expense.amount || 0);
  const nextPaymentSource = String(req.body.ingredientsPaidFrom || previousPaymentSource).toLowerCase() === 'bank' ? 'bank' : 'cash';
  if (oldAmount > 0 && previousPaymentSource) {
    await applyCashBookDelta(
      rid,
      previousPaymentSource === 'bank' ? { bankDelta: oldAmount } : { cashDelta: oldAmount },
    );
  }
  await applyCashBookDelta(
    rid,
    nextPaymentSource === 'bank' ? { bankDelta: -amount } : { cashDelta: -amount },
  );

  expense.isDeleted = false;
  expense.amount = amount;
  expense.paymentMethod = nextPaymentSource === 'bank' ? 'bank_transfer' : 'cash';
  expense.title = `Stock update use - ${item.name}`;
  expense.description = `${log.quantity} ${item.unit} x ${Number(item.costPerUnit || 0).toFixed(2)} per ${item.unit} = ${amount.toFixed(2)}`;
  expense.notes = `source=inventory_usage log=${log._id}`;
  await expense.save();
  return expense;
};

const updateInventoryMovement = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
    return error(res, 'Please select a valid inventory movement', 400);
  }
  const log = await InventoryLog.findOne({ _id: req.params.id, restaurantId: rid });
  if (!log) return error(res, 'Inventory movement not found', 404);
  return error(
    res,
    'Inventory movement logs are immutable. Create a compensating stock movement instead of editing this record.',
    409,
  );
  if (!['stock_in', 'stock_out', 'usage', 'wastage', 'adjustment'].includes(log.type)) {
    return error(res, 'This transaction type cannot be edited here', 400);
  }

  const item = await InventoryItem.findOne({
    _id: log.inventoryItemId,
    restaurantId: rid,
    isDeleted: false,
    ...inventoryBranchItemFilter(req.branchId),
  });
  if (!item) return error(res, 'Inventory item not found', 404);

  const quantity = req.body.quantity !== undefined ? Number(req.body.quantity) : Number(log.quantity || 0);
  if (quantity <= 0) return error(res, 'quantity must be positive', 400);

  const before = Number(item.quantity || 0);
  const restored = Math.max(0, before + reverseMovementQuantity(log));
  if (!movementIsIncrease(log) && quantity > restored) {
    return error(res, insufficientStockError(restored, quantity, item.unit), 400);
  }
  const nextQty = quantity;
  const after = Math.max(0, restored + applyMovementQuantity(log, nextQty));
  const oldAmount = Number(log.totalCost || 0);

  item.quantity = after;
  await item.save();

  log.quantity = nextQty;
  log.totalCost = nextQty * Number(item.costPerUnit || 0);
  if (req.body.referenceNumber !== undefined) log.referenceNumber = req.body.referenceNumber || '';
  if (req.body.reason !== undefined || req.body.note !== undefined) log.note = req.body.note || req.body.reason || '';
  await log.save();

  let expense = await syncInventoryUsageExpense(req, rid, log, item, oldAmount);
  if (log.type === 'wastage') {
    expense = await syncInventoryWastageExpense(req, rid, log, item);
  }

  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'inventory_movement_update',
    resource: 'system',
    resourceId: item._id,
    details: { item: item.name, type: log.type, before, after: item.quantity, oldQuantity: Number(req.body.originalQuantity || 0) || undefined, quantity: nextQty },
    ipAddress: req.ip,
  });

  const populatedLog = await InventoryLog.findById(log._id).populate('inventoryItemId', 'name unit category costPerUnit');
  return success(res, { item, log: populatedLog, expense }, 'Inventory movement updated');
});

const deleteInventoryMovement = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
    return error(res, 'Please select a valid inventory movement', 400);
  }
  const log = await InventoryLog.findOne({ _id: req.params.id, restaurantId: rid });
  if (!log) return error(res, 'Inventory movement not found', 404);
  return error(
    res,
    'Inventory movement logs are immutable. Create a compensating stock movement instead of deleting this record.',
    409,
  );
  if (!['stock_in', 'stock_out', 'usage', 'wastage', 'adjustment'].includes(log.type)) {
    return error(res, 'This transaction type cannot be deleted here', 400);
  }

  const item = await InventoryItem.findOne({
    _id: log.inventoryItemId,
    restaurantId: rid,
    isDeleted: false,
    ...inventoryBranchItemFilter(req.branchId),
  });
  if (!item) return error(res, 'Inventory item not found', 404);

  const before = Number(item.quantity || 0);
  item.quantity = Math.max(0, before + reverseMovementQuantity(log));
  await item.save();

  const expense = await Expense.findOne({ sourceInventoryLogId: log._id });
  if (expense && !expense.isDeleted) {
    if (log.type === 'usage') {
      const source = expense.paymentMethod === 'bank_transfer' ? 'bank' : 'cash';
      await applyCashBookDelta(
        rid,
        source === 'bank' ? { bankDelta: roundMoney(expense.amount) } : { cashDelta: roundMoney(expense.amount) },
      );
    }
    expense.isDeleted = true;
    expense.notes = `${expense.notes || ''} inventory movement deleted`;
    await expense.save();
  }

  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'inventory_movement_delete',
    resource: 'system',
    resourceId: item._id,
    details: { item: item.name, type: log.type, before, after: item.quantity, quantity: log.quantity },
    ipAddress: req.ip,
  });

  await log.deleteOne();
  return success(res, { item }, 'Inventory movement deleted and stock restored');
});

// --- Budget ---
const listBudgets = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const { year } = req.query;
  const filter = { restaurantId: rid };
  if (year) filter.year = Number(year);
  const rows = await Budget.find(filter).sort({ year: -1, month: -1 });
  return success(res, rows, 'Budgets retrieved');
});

const upsertBudget = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const { periodType, year, month, lines, notes } = req.body;
  if (!periodType || !year || month === undefined || !Array.isArray(lines)) {
    return error(res, 'periodType, year, month and lines[] are required', 400);
  }
  const row = await Budget.findOneAndUpdate(
    { restaurantId: rid, periodType, year: Number(year), month: Number(month) },
    {
      $set: {
        lines: lines.map((l) => ({
          category: String(l.category),
          amount: Number(l.amount || 0),
        })),
        notes: notes || '',
        createdBy: req.user.id,
        createdByModel: authModel(req),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return success(res, row, 'Budget saved', 201);
});

const getBudgetVariance = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const year = Number(req.query.year || new Date().getFullYear());
  const month = Number(req.query.month || new Date().getMonth() + 1);
  const budget = await Budget.findOne({ restaurantId: rid, periodType: 'monthly', year, month });
  if (!budget) return success(res, { budget: null, variance: [] }, 'No budget for period');

  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  const spent = await Expense.aggregate([
    {
      $match: {
        restaurantId: asObjectId(rid),
        isDeleted: false,
        expenseDate: { $gte: start, $lte: end },
      },
    },
    { $group: { _id: '$category', amount: { $sum: '$amount' } } },
  ]);
  const spentMap = new Map(spent.map((s) => [s._id, s.amount]));

  const variance = budget.lines.map((l) => {
    const actual = Number(spentMap.get(l.category) || 0);
    return {
      category: l.category,
      budgeted: l.amount,
      actual,
      remaining: Number(l.amount) - actual,
    };
  });

  return success(res, { budget, variance }, 'Budget variance');
});

// --- ERP dashboard ---
const getErpDashboard = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const restaurantId = asObjectId(rid);
  await syncSalesReportsForRestaurant(restaurantId);
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const endToday = new Date();
  endToday.setHours(23, 59, 59, 999);

  const startPrevMonth = new Date();
  startPrevMonth.setMonth(startPrevMonth.getMonth() - 1);
  startPrevMonth.setDate(1);
  startPrevMonth.setHours(0, 0, 0, 0);
  const endPrevMonth = new Date(startPrevMonth.getFullYear(), startPrevMonth.getMonth() + 1, 0, 23, 59, 59, 999);

  const [
    salesToday,
    expenseToday,
    invVal,
    topExpenseCat,
    bestItem,
    salesThisMonth,
    salesPrevMonth,
  ] = await Promise.all([
    SalesReport.aggregate([
      { $match: { restaurantId, branchId: req.branchId, soldAt: { $gte: startToday, $lte: endToday } } },
      ...buildSalesReportDedupePipeline(),
      { $group: { _id: null, revenue: { $sum: '$netRevenue' } } },
    ]),
    Expense.aggregate([
      {
        $match: {
          restaurantId: asObjectId(rid),
          isDeleted: false,
          expenseDate: { $gte: startToday, $lte: endToday },
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    InventoryItem.aggregate([
      { $match: { restaurantId, isDeleted: false } },
      {
        $group: {
          _id: null,
          valuation: { $sum: { $multiply: ['$quantity', '$costPerUnit'] } },
        },
      },
    ]),
    Expense.aggregate([
      {
        $match: {
          restaurantId: asObjectId(rid),
          isDeleted: false,
          expenseDate: { $gte: startToday, $lte: endToday },
        },
      },
      { $group: { _id: '$category', amount: { $sum: '$amount' } } },
      { $sort: { amount: -1 } },
      { $limit: 1 },
    ]),
    CustomerOrder.aggregate([
      { $match: { restaurant: restaurantId, createdAt: { $gte: startToday, $lte: endToday } } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.name',
          qty: { $sum: '$items.quantity' },
          revenue: { $sum: { $multiply: ['$items.quantity', '$items.price'] } },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 1 },
    ]),
    SalesReport.aggregate([
      {
        $match: {
          restaurantId,
          branchId: req.branchId,
          soldAt: {
            $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
            $lte: endToday,
          },
        },
      },
      ...buildSalesReportDedupePipeline(),
      { $group: { _id: null, revenue: { $sum: '$netRevenue' } } },
    ]),
    SalesReport.aggregate([
      { $match: { restaurantId, branchId: req.branchId, soldAt: { $gte: startPrevMonth, $lte: endPrevMonth } } },
      ...buildSalesReportDedupePipeline(),
      { $group: { _id: null, revenue: { $sum: '$netRevenue' } } },
    ]),
  ]);

  const revenueToday = Number(salesToday[0]?.revenue || 0);
  const expensesToday = Number(expenseToday[0]?.total || 0);
  const inventoryCost = Number(invVal[0]?.valuation || 0);
  const revMonth = Number(salesThisMonth[0]?.revenue || 0);
  const revPrev = Number(salesPrevMonth[0]?.revenue || 0);
  const growthPercent =
    revPrev > 0 ? Number((((revMonth - revPrev) / revPrev) * 100).toFixed(2)) : revMonth > 0 ? 100 : 0;

  return success(
    res,
    {
      today: {
        revenue: revenueToday,
        expenses: expensesToday,
        profit: revenueToday - expensesToday,
      },
      inventoryValuation: inventoryCost,
      topExpenseCategory: topExpenseCat[0] || null,
      bestSellingItem: bestItem[0] || null,
      monthlyRevenue: revMonth,
      monthlyGrowthPercent: growthPercent,
    },
    'ERP dashboard',
  );
});

const getRevenueByChannel = asyncHandler(async (req, res) => {
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
  await syncSalesReportsForRestaurant(restaurantId);
  const rows = await SalesReport.aggregate([
    { $match: { restaurantId, branchId: req.branchId, soldAt: { $gte: from, $lte: to } } },
    ...buildSalesReportDedupePipeline(),
    { $group: { _id: '$orderChannel', revenue: { $sum: '$netRevenue' }, orders: { $sum: 1 } } },
    { $sort: { revenue: -1 } },
  ]);
  return success(res, rows, 'Revenue by channel');
});

// --- TDS (Nepal-style settings + summary) ---
const getTdsSettings = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const doc = await TdsSettings.getForRestaurant(rid);
  return success(res, doc, 'TDS settings');
});

const updateTdsSettings = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const doc = await TdsSettings.getForRestaurant(rid);
  if (req.body.defaultTdsPercent !== undefined) doc.defaultTdsPercent = Number(req.body.defaultTdsPercent);
  if (req.body.defaultEpfPercent !== undefined) doc.defaultEpfPercent = Number(req.body.defaultEpfPercent);
  if (req.body.defaultEmployerEpfPercent !== undefined) {
    doc.defaultEmployerEpfPercent = Number(req.body.defaultEmployerEpfPercent);
  }
  if (req.body.enabled !== undefined) doc.enabled = Boolean(req.body.enabled);
  if (req.body.notes !== undefined) doc.notes = req.body.notes;
  await doc.save();
  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'tds_settings_update',
    resource: 'system',
    details: {
      defaultTdsPercent: doc.defaultTdsPercent,
      defaultEpfPercent: doc.defaultEpfPercent,
      defaultEmployerEpfPercent: doc.defaultEmployerEpfPercent,
      enabled: doc.enabled,
    },
    ipAddress: req.ip,
  });
  return success(res, doc, 'TDS settings updated');
});

const getTdsSummary = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const year = Number(req.query.year || new Date().getFullYear());
  const rows = await Payroll.aggregate([
    { $match: { restaurantId: asObjectId(rid), periodYear: year } },
    {
      $group: {
        _id: '$employeeId',
        ytdTds: { $sum: '$tdsAmount' },
        months: { $sum: 1 },
      },
    },
    { $sort: { ytdTds: -1 } },
  ]);
  const employees = [];
  for (const r of rows) {
    const emp = await Employee.findById(r._id).select('name panNumber role');
    employees.push({
      employeeId: r._id,
      employee: emp,
      ytdTds: Number(r.ytdTds || 0),
      months: r.months,
    });
  }
  const governmentPayable = employees.reduce((s, x) => s + Number(x.ytdTds || 0), 0);
  return success(
    res,
    { year, employees, governmentPayableTds: Number(governmentPayable.toFixed(2)) },
    'TDS summary',
  );
});

// --- Accounting ---
const listChartOfAccounts = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  await ensureDefaultCoa(rid);
  const rows = await ChartOfAccount.find({ restaurantId: rid, isDeleted: false }).sort({ code: 1 });
  return success(res, rows, 'Chart of accounts');
});

const postJournalEntry = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const { entryDate, memo, lines } = req.body;
  if (!entryDate || !Array.isArray(lines)) {
    return error(res, 'entryDate and lines are required', 400);
  }
  const normalized = lines
    .map((l) => ({
      accountCode: String(l.accountCode || '').trim(),
      debit: Number(l.debit || 0),
      credit: Number(l.credit || 0),
    }))
    .filter((l) => l.accountCode && (l.debit > 0 || l.credit > 0));

  if (normalized.length < 2) {
    return error(
      res,
      'Add at least two lines, each with an account code and a debit or credit amount',
      400,
    );
  }

  await ensureDefaultCoa(rid);
  const knownCodes = await ChartOfAccount.find({ restaurantId: rid, isDeleted: false })
    .select('code')
    .lean();
  const codeSet = new Set(knownCodes.map((row) => row.code));
  for (const line of normalized) {
    if (!codeSet.has(line.accountCode)) {
      return error(res, `Unknown account code: ${line.accountCode}`, 400);
    }
    if (line.debit > 0 && line.credit > 0) {
      return error(res, 'Each line must have either a debit or a credit, not both', 400);
    }
  }

  const deb = normalized.reduce((s, l) => s + l.debit, 0);
  const cred = normalized.reduce((s, l) => s + l.credit, 0);
  if (Number(deb.toFixed(2)) !== Number(cred.toFixed(2))) {
    return error(res, 'Debits and credits must balance', 400);
  }
  try {
    await accountingSecurity.assertPeriodOpen({ restaurantId: rid, branchId: req.branchId, date: entryDate });
  } catch (e) {
    return error(res, e.message, e.statusCode || 400);
  }
  const doc = await JournalEntry.create({
    restaurantId: rid,
    entryDate: new Date(entryDate),
    memo: memo || '',
    sourceType: 'manual',
    lines: normalized,
    createdBy: req.user.id,
    createdByModel: authModel(req),
  });
  return success(res, doc, 'Journal entry posted', 201);
});

const getTrialBalance = asyncHandler(async (req, res) => {
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
  const rows = await JournalEntry.aggregate([
    { $match: { restaurantId, entryDate: { $gte: from, $lte: to } } },
    { $unwind: '$lines' },
    {
      $group: {
        _id: '$lines.accountCode',
        debit: { $sum: '$lines.debit' },
        credit: { $sum: '$lines.credit' },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  return success(res, rows, 'Trial balance');
});

module.exports = {
  listSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  verifySupplier,
  getInventoryReportSummary,
  listInventoryLogs,
  listInventoryPurchases,
  postInventoryWastageOrAdjustment,
  updateInventoryMovement,
  deleteInventoryMovement,
  listBudgets,
  upsertBudget,
  getBudgetVariance,
  getErpDashboard,
  getRevenueByChannel,
  getTdsSettings,
  updateTdsSettings,
  getTdsSummary,
  listChartOfAccounts,
  postJournalEntry,
  getTrialBalance,
};
