const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const CustomerOrder = require('../../models/restaurant/CustomerOrder');
const MenuItem = require('../../models/restaurant/MenuItem');
const Table = require('../../models/restaurant/Table');
const Transaction = require('../../models/restaurant/Transaction');
const POSShift = require('../../models/restaurant/POSShift');
const POSOrder = require('../../models/restaurant/POSOrder');
const POSInvoice = require('../../models/restaurant/POSInvoice');
const POSPayment = require('../../models/restaurant/POSPayment');
const POSRefund = require('../../models/restaurant/POSRefund');
const POSCart = require('../../models/restaurant/POSCart');
const Restaurant = require('../../models/restaurant/Restaurant');
const Employee = require('../../models/restaurant/Employee');
const BranchAuth = require('../../models/restaurant/BranchAuth');
const POSApproval = require('../../models/restaurant/POSApproval');
const POSActivity = require('../../models/restaurant/POSActivity');
const POSOfflineSync = require('../../models/restaurant/POSOfflineSync');
const POSSequence = require('../../models/restaurant/POSSequence');
const { generateRandomToken } = require('../../utils/generateToken');
const { success, error } = require('../../utils/apiResponse');
const {
  emitNewOrder,
  emitOrderUpdate,
  emitPaymentUpdate,
  emitPosNewOrder,
  emitPosPaymentSuccess,
  emitPosTableUpdated,
  emitPosShiftOpened,
  emitPosShiftClosed,
} = require('../../services/socketService');
const { getOrCreateVirtualPosTable, generatePickupToken } = require('../../services/posTableHelper');
const { applyRecipeDeductionForCompletedOrder } = require('../../services/recipeInventoryService');
const { ensureSalesReportForOrder } = require('../../services/salesReportService');
const notificationService = require('../../services/notificationService');
const { writeAuditLog } = require('../../utils/auditLog');
const {
  restaurantIdFromUser,
  shiftOperatorFromUser,
  openShiftQueryFromUser,
} = require('../../middleware/restaurant/requirePosAccess');
const { branchMenuItemBaseFilter } = require('../../services/branchService');
const { legacyRestaurantScope } = require('../../utils/tenantScope');
const fraudDetection = require('../../services/fraudDetectionService');

const PAYMENT_METHODS = new Set(['cash', 'online', 'credit']);
const SENSITIVE_ACTIONS = new Set(['discount', 'refund', 'void_bill', 'drawer_adjustment', 'shift_close_variance']);

function actorId(req) {
  return req.user.employeeId || req.user.id;
}

function createdByType(req) {
  if (req.user.scope !== 'employee') return 'restaurant';
  if (req.user.role === 'waiter') return 'waiter';
  if (req.user.role === 'cashier') return 'cashier';
  if (req.user.role === 'manager') return 'manager';
  return 'cashier';
}

function shiftActorDetails(req) {
  const operator = shiftOperatorFromUser(req);
  return {
    operatorType: operator.operatorType,
    operatorId: String(operator.operator || ''),
    operatorRole: req.user?.role,
    operatorName: req.user?.name,
  };
}

function actorModel(req) {
  if (req.user?.scope === 'branch_user') return 'BranchAuth';
  if (req.user?.scope === 'employee' || req.user?.employeeId) return 'Employee';
  return 'Restaurant';
}

function actorRef(req) {
  return req.user?.employeeId || req.user?.id;
}

function requestIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || '')
    .split(',')[0]
    .trim();
}

async function logPosActivity(req, { action, resourceType = '', resourceId = null, risk = 'low', metadata = {} }) {
  await POSActivity.create({
    restaurant: restaurantIdFromUser(req),
    branchId: req.branchId || null,
    shift: req.posShiftId || null,
    actorType: actorModel(req),
    actor: actorRef(req),
    action,
    resourceType,
    resourceId,
    risk,
    ipAddress: requestIp(req),
    userAgent: String(req.get('user-agent') || ''),
    metadata,
  });
}

function isManagerLike(req) {
  if (req.user?.scope === 'restaurant' && req.user?.role === 'restaurant') return true;
  if (req.user?.scope === 'branch_user' && ['branch_admin', 'branch_manager'].includes(req.user.role)) return true;
  return req.user?.scope === 'employee' && req.user.role === 'manager';
}

async function verifyApprovalCredential(req, approvalInput = {}, action) {
  if (!SENSITIVE_ACTIONS.has(action)) return null;
  const restaurantId = restaurantIdFromUser(req);
  const managerId = approvalInput.managerId || approvalInput.approvedBy || approvalInput.employeeId;
  const password = approvalInput.password || approvalInput.managerPassword || approvalInput.approvalPassword;
  const pin = approvalInput.pin || approvalInput.managerPin || approvalInput.approvalPin;
  const reason = String(approvalInput.reason || '').trim();
  const credentialRequired = ['refund', 'void_bill', 'drawer_adjustment'].includes(action);
  if (credentialRequired && !password && !pin) {
    const err = new Error('Manager PIN or password is required for this POS action');
    err.statusCode = 403;
    throw err;
  }

  if (req.user?.scope === 'restaurant' && req.user?.role === 'restaurant') {
    if (password || pin) {
      const restaurant = await Restaurant.findById(req.user.id).select('+password');
      const ok = restaurant && password && (await restaurant.comparePassword(password));
      if (!ok && pin !== process.env.POS_OWNER_APPROVAL_PIN) {
        const err = new Error('Owner approval credential is invalid');
        err.statusCode = 403;
        throw err;
      }
    }
    return {
      approvedBy: req.user.id,
      approvedByModel: 'Restaurant',
      reason,
    };
  }

  if (req.user?.scope === 'branch_user' && ['branch_admin', 'branch_manager'].includes(req.user.role)) {
    if (password || pin) {
      const branchUser = await BranchAuth.findOne({
        _id: req.user.id,
        restaurantId,
        branchId: req.branchId,
        activeStatus: true,
      }).select('+passwordHash');
      const ok = branchUser && password && bcrypt.compareSync(password, branchUser.passwordHash);
      if (!ok) {
        const err = new Error('Branch manager approval credential is invalid');
        err.statusCode = 403;
        throw err;
      }
    }
    return { approvedBy: req.user.id, approvedByModel: 'BranchAuth', reason };
  }

  let manager = null;
  if (managerId && mongoose.Types.ObjectId.isValid(String(managerId))) {
    manager = await Employee.findOne({
      _id: managerId,
      restaurant: restaurantId,
      branchId: req.branchId,
      role: 'manager',
      isActive: true,
    }).select('+password +posPinHash');
  } else if (req.user?.scope === 'employee' && req.user.role === 'manager') {
    manager = await Employee.findOne({
      _id: req.user.employeeId || req.user.id,
      restaurant: restaurantId,
      branchId: req.branchId,
      role: 'manager',
      isActive: true,
    }).select('+password +posPinHash');
  }

  if (!manager) {
    const err = new Error('Manager approval is required');
    err.statusCode = 403;
    throw err;
  }

  const pinOk = pin ? await manager.comparePosPin(pin) : false;
  const passwordOk = password ? await manager.comparePassword(password) : false;
  if (!pinOk && !passwordOk) {
    const err = new Error('Manager approval credential is invalid');
    err.statusCode = 403;
    throw err;
  }

  return { approvedBy: manager._id, approvedByModel: 'Employee', reason };
}

async function createApproval(req, { action, resourceType = 'order', resourceId, approvalInput, metadata = {} }) {
  const approval = await verifyApprovalCredential(req, approvalInput, action);
  const doc = await POSApproval.create({
    restaurant: restaurantIdFromUser(req),
    branchId: req.branchId || null,
    action,
    resourceType,
    resourceId,
    requestedBy: actorRef(req),
    requestedByModel: actorModel(req),
    approvedBy: approval.approvedBy,
    approvedByModel: approval.approvedByModel,
    reason: approval.reason || approvalInput?.reason || '',
    metadata,
    status: 'approved',
  });
  await logPosActivity(req, {
    action: `approval_${action}`,
    resourceType,
    resourceId,
    risk: ['refund', 'void_bill'].includes(action) ? 'high' : 'medium',
    metadata: { approvalId: String(doc._id), ...metadata },
  });

  return doc;
}

async function getOpenShiftForUser(req) {
  return POSShift.findOne(openShiftQueryFromUser(req));
}

async function nextInvoiceNumber(restaurantId, branchId) {
  const row = await POSSequence.findOneAndUpdate(
    { restaurant: restaurantId, branchId: branchId || null, key: 'invoice' },
    { $inc: { value: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return `INV-${String(row.value).padStart(7, '0')}`;
}

async function lockInvoiceForOrder(order, req) {
  await POSInvoice.findOneAndUpdate(
    {
      restaurant: order.restaurant,
      branchId: order.branchId || null,
      customerOrder: order._id,
      status: { $ne: 'voided' },
    },
    {
      $set: {
        status: 'locked',
        lockedAt: new Date(),
        lockedBy: actorRef(req),
        lockedByModel: actorModel(req),
      },
    },
    { new: true }
  );
}

async function releaseTableForCompletedPosOrder(order) {
  if (!order.table || order.posDetails?.mode !== 'dine_in') return;
  const table = await Table.findOne({
    _id: order.table,
    restaurant: order.restaurant,
    branchId: order.branchId,
    isDeleted: false,
  });
  if (!table || table.allowsConcurrentOrders) return;
  table.posStatus = 'available';
  table.guestCount = 0;
  table.currentCustomerOrder = null;
  await table.save();
  emitPosTableUpdated(String(order.restaurant), table);
}

async function applyPaidTransition(order, req) {
  const rid = String(order.restaurant);
  if (order.status === 'served') {
    order.status = 'completed';
    order.statusHistory.push({
      status: 'completed',
      timestamp: new Date(),
      updatedBy: actorId(req),
      note: 'Payment completed — thank you',
    });
  } else {
    order.status = 'served';
    order.statusHistory.push({
      status: 'served',
      timestamp: new Date(),
      updatedBy: actorId(req),
      note: 'Marked served after payment',
    });
  }
  await order.save();
  await ensureSalesReportForOrder(order);

  if (order.status === 'completed') {
    try {
      await applyRecipeDeductionForCompletedOrder(order, {
        userId: actorId(req),
        userModel: req.user.scope === 'employee' ? 'Employee' : 'Restaurant',
      });
    } catch (err) {
      console.error('recipeInventory deduction failed', err);
    }
    await releaseTableForCompletedPosOrder(order);
  }

  emitOrderUpdate(rid, order);
  emitPosPaymentSuccess(rid, {
    customerOrderId: order._id,
    orderNumber: order.orderNumber,
    paymentStatus: order.paymentStatus,
    status: order.status,
  });
}

/**
 * @route POST /api/restaurant/pos/order
 */
const createPosOrder = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromUser(req);
  const {
    mode,
    tableId,
    guestsCount = 1,
    waiterId,
    customerName,
    customerPhone,
    customerEmail,
    items,
    specialRequests,
    discountAmount = 0,
    discountPercent = 0,
    serviceChargeAmount: bodyService,
    deliveryCharge = 0,
    deliveryAddress,
    riderName,
    riderPhone,
    promoCode,
    taxInclusive = false,
    requiresDiscountApproval,
  } = req.body;

  if (!mode || !['dine_in', 'takeaway', 'delivery'].includes(mode)) {
    return error(res, 'Valid mode is required (dine_in, takeaway, delivery)', 400);
  }
  if (!items || !Array.isArray(items) || items.length === 0) {
    return error(res, 'Items are required', 400);
  }

  const restaurant = await Restaurant.findById(restaurantId);
  if (!restaurant) return error(res, 'Restaurant not found', 404);

  let table;
  if (mode === 'dine_in') {
    if (!tableId) return error(res, 'Table is required for dine-in', 400);
    table = await Table.findOne({
      _id: tableId,
      restaurant: restaurantId,
      branchId: req.branchId,
      isActive: true,
      isDeleted: false,
    });
    if (!table) return error(res, 'Table not found', 404);
    const expectedBranch = await branchMenuItemBaseFilter(table);
    if (String(expectedBranch.branchId) !== String(req.branchId)) {
      return error(res, 'Table does not belong to this branch', 403);
    }
    if (!table.allowsConcurrentOrders) {
      const active = await CustomerOrder.findOne({
        restaurant: restaurantId,
        branchId: req.branchId,
        table: tableId,
        status: { $in: ['pending', 'confirmed', 'preparing', 'cooking', 'ready'] },
        isActive: true,
      });
      if (active) return error(res, 'Table already has an active order', 400);
    }
  } else {
    table = await getOrCreateVirtualPosTable(restaurantId, mode, req.branchId);
  }

  const flatDisc = Number(discountAmount) || 0;
  const pctDisc = Number(discountPercent) || 0;

  let totalAmount = 0;
  let taxAmount = 0;
  const orderItems = [];

  for (const item of items) {
    const menuItem = await MenuItem.findOne({
      _id: item.menuItemId || item.menuItem,
      restaurant: restaurantId,
      branchId: req.branchId,
      isDeleted: false,
    });
    if (!menuItem) {
      return error(res, `Menu item not found: ${item.menuItemId || item.menuItem}`, 404);
    }
    if (!menuItem.isAvailable) {
      return error(res, `${menuItem.name} is unavailable`, 400);
    }
    const qty = Math.max(1, Number(item.quantity) || 1);
    const lineSub = menuItem.price * qty;
    const lineTax = (lineSub * (menuItem.taxRate || 0)) / 100;
    totalAmount += lineSub;
    taxAmount += lineTax;
    orderItems.push({
      menuItem: menuItem._id,
      name: menuItem.name,
      price: menuItem.price,
      quantity: qty,
      specialInstructions: item.specialInstructions || '',
      cookingInstructions: item.cookingInstructions || '',
      customizations: Array.isArray(item.customizations) ? item.customizations : [],
      addOns: Array.isArray(item.addOns) ? item.addOns : [],
      subtotal: lineSub,
    });
  }

  let discountTotal = flatDisc;
  if (pctDisc > 0) {
    discountTotal += Math.round((totalAmount + taxAmount) * (pctDisc / 100) * 100) / 100;
  }

  let promoExtra = 0;
  if (promoCode && String(promoCode).toUpperCase() === 'WELCOME') {
    promoExtra = Math.round((totalAmount + taxAmount) * 0.1 * 100) / 100;
  }
  discountTotal += promoExtra;

  const baseForDisc = totalAmount + taxAmount;
  const impliedDiscPct = baseForDisc > 0 ? (discountTotal / baseForDisc) * 100 : 0;
  const needsManagerDiscount =
    discountTotal > 0 && (!isManagerLike(req) || impliedDiscPct > 25 || flatDisc > 500 || requiresDiscountApproval === true);
  let discountApproval = null;
  if (needsManagerDiscount) {
    try {
      discountApproval = await createApproval(req, {
        action: 'discount',
        approvalInput: req.body.managerApproval || req.body.approval || {},
        metadata: {
          discountAmount: discountTotal,
          discountPercent: pctDisc,
          promoCode: promoCode || '',
          impliedDiscPct,
        },
      });
    } catch (approvalErr) {
      return error(res, approvalErr.message || 'Discount approval required', approvalErr.statusCode || 403);
    }
  }

  const serviceChargeAmount =
    bodyService != null
      ? Number(bodyService)
      : Math.round(((totalAmount * (restaurant.settings?.serviceChargePercent || 0)) / 100) * 100) / 100;

  const dCharge = mode === 'delivery' ? Number(deliveryCharge) || 0 : 0;

  const grandTotal = Math.max(
    0,
    totalAmount + taxAmount + serviceChargeAmount + dCharge - discountTotal
  );

  const pickupToken = mode === 'takeaway' ? generatePickupToken() : '';
  const qrToken = generateRandomToken(32);

  const normalizedName =
    String(customerName || '').trim() ||
    (mode === 'dine_in' ? `Guest (Table ${table.tableNumber})` : 'Walk-in');

  const shift = await getOpenShiftForUser(req);

  const cbType = createdByType(req);
  const order = await CustomerOrder.create({
    qrToken,
    guestId: null,
    restaurant: restaurantId,
    restaurantId,
    branchId: req.branchId,
    table: table._id,
    customerName: normalizedName,
    customerPhone,
    customerEmail,
    items: orderItems,
    totalAmount,
    taxAmount,
    discountAmount: discountTotal,
    grandTotal,
    specialRequests,
    orderChannel: mode === 'dine_in' ? 'dine_in' : mode === 'delivery' ? 'delivery' : 'takeaway',
    posDetails: {
      mode,
      pickupToken,
      deliveryAddress: deliveryAddress || '',
      riderName: riderName || '',
      riderPhone: riderPhone || '',
      deliveryCharge: dCharge,
      guestsCount: Number(guestsCount) || 1,
      serviceChargeAmount,
      taxInclusive: Boolean(taxInclusive),
      promoCode: promoCode || '',
      loyaltyPointsEarned: Math.floor(grandTotal / 100),
    },
    amountPaidTotal: 0,
    createdBy: {
      type: cbType,
      employeeId: req.user.scope === 'employee' ? req.user.id : null,
    },
    statusHistory: [{ status: 'pending', timestamp: new Date() }],
  });

  const invoiceNumber = await nextInvoiceNumber(restaurantId, req.branchId);
  await POSInvoice.create({
    restaurant: restaurantId,
    branchId: req.branchId,
    customerOrder: order._id,
    invoiceNumber,
    totals: {
      subtotal: totalAmount,
      taxAmount,
      serviceCharge: serviceChargeAmount,
      discountAmount: discountTotal,
      grandTotal,
    },
  });

  const primaryStaff = waiterId || (req.user.scope === 'employee' ? req.user.id : null);
  await POSOrder.create({
    restaurant: restaurantId,
    branchId: req.branchId,
    customerOrder: order._id,
    shift: shift?._id,
    invoiceNumber,
    primaryStaff,
    source: 'pos_terminal',
  });

  if (mode === 'dine_in' && !table.allowsConcurrentOrders) {
    table.posStatus = 'occupied';
    table.guestCount = Number(guestsCount) || 1;
    table.assignedWaiter = waiterId || table.assignedWaiter;
    table.currentCustomerOrder = order._id;
    await table.save();
    emitPosTableUpdated(String(restaurantId), table);
  }

  await order.populate('table', 'tableNumber posStatus');
  emitNewOrder(String(restaurantId), order);
  emitPosNewOrder(String(restaurantId), {
    order,
    tableId: table._id,
    mode,
    pickupToken,
  });

  await writeAuditLog(req, {
    action: 'pos_order_created',
    resource: 'order',
    resourceId: order._id,
    details: {
      restaurantId: String(restaurantId),
      orderNumber: order.orderNumber,
      mode,
      invoiceNumber,
    },
  });

  await logPosActivity(req, {
    action: 'pos_order_created',
    resourceType: 'order',
    resourceId: order._id,
    risk: discountTotal > 0 ? 'medium' : 'low',
    metadata: {
      orderNumber: order.orderNumber,
      invoiceNumber,
      discountAmount: discountTotal,
      discountApprovalId: discountApproval ? String(discountApproval._id) : null,
    },
  });
  await fraudDetection.detectSuspiciousDiscount({
    req,
    order,
    discountAmount: discountTotal,
    discountPercent: pctDisc,
    impliedDiscPct,
  });
  await fraudDetection.detectDuplicateOrder({ req, order });

  return success(
    res,
    {
      order,
      invoiceNumber,
      pickupToken,
    },
    'POS order created',
    201
  );
});

/**
 * @route GET /api/restaurant/pos/orders
 */
const listPosOrders = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromUser(req);
  const { limit = 40, status } = req.query;
  const parsedLimit = parseInt(limit, 10);
  let rows = await POSOrder.find({ restaurant: restaurantId, branchId: req.branchId })
    .sort({ createdAt: -1 })
    .limit(parsedLimit)
    .populate({
      path: 'customerOrder',
      populate: { path: 'table', select: 'tableNumber posStatus' },
    });
  rows = rows.filter((row) => String(row.customerOrder?.branchId || '') === String(req.branchId));

  const linkedOrderIds = rows
    .map((r) => r.customerOrder?._id)
    .filter(Boolean);

  const legacyQrOrders = await CustomerOrder.find({
    ...legacyRestaurantScope(req),
    isActive: true,
    orderChannel: { $in: ['qr_ordering', 'dine_in'] },
    createdBy: { $ne: null },
    'createdBy.type': { $in: ['qr', 'waiter'] },
    ...(linkedOrderIds.length ? { _id: { $nin: linkedOrderIds } } : {}),
  })
    .sort({ createdAt: -1 })
    .limit(parsedLimit)
    .populate('table', 'tableNumber posStatus');

  rows = [
    ...rows,
    ...legacyQrOrders.map((order) => ({
      _id: `customer-${order._id}`,
      restaurant: order.restaurant,
      customerOrder: order,
      source: order.createdBy?.type === 'qr' ? 'qr_menu' : 'pos_terminal',
      createdAt: order.createdAt,
    })),
  ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, parsedLimit);

  if (status) {
    const set = new Set(String(status).split(',').map((s) => s.trim()).filter(Boolean));
    rows = rows.filter((r) => r.customerOrder && set.has(r.customerOrder.status));
  }
  return success(res, { orders: rows }, 'POS orders');
});

/**
 * @route POST /api/restaurant/pos/payment
 */
const postPosPayment = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromUser(req);
  const { customerOrderId, payments } = req.body;
  if (!customerOrderId || !Array.isArray(payments) || payments.length === 0) {
    return error(res, 'customerOrderId and payments[] are required', 400);
  }

  for (const p of payments) {
    if (!PAYMENT_METHODS.has(String(p.method))) {
      return error(res, `Invalid payment method: ${p.method}`, 400);
    }
    if (p.amount == null || Number(p.amount) <= 0) {
      return error(res, 'Each payment needs a positive amount', 400);
    }
  }

  const order = await CustomerOrder.findOne({
    _id: customerOrderId,
    ...legacyRestaurantScope(req),
    isActive: true,
  });

  if (!order) return error(res, 'Order not found', 404);
  if (order.paymentStatus === 'paid') return error(res, 'Order already paid', 400);

  const shift = await getOpenShiftForUser(req);
  const splitGroupId = payments.length > 1 ? new mongoose.Types.ObjectId() : null;
  const paySum = payments.reduce((s, p) => s + Number(p.amount), 0);
  const already = Number(order.amountPaidTotal) || 0;
  const remaining = Math.round((order.grandTotal - already) * 100) / 100;

  if (paySum > remaining + 0.01) {
    return error(res, 'Payment total exceeds balance due', 400);
  }

  const processor = actorId(req);

  for (const p of payments) {
    const tx = await Transaction.create({
      restaurant: restaurantId,
      branchId: req.branchId,
      customerOrder: order._id,
      amount: Number(p.amount),
      paymentMethod: p.method,
      status: 'success',
      processedBy: req.user.employeeId || req.user.id,
      notes: p.notes || 'POS payment',
      linkedOrderStatus: order.status,
      linkedOrderPaymentStatus: order.paymentStatus,
      splitGroupId: splitGroupId || undefined,
      posShift: shift?._id,
    });
    await POSPayment.create({
      restaurant: restaurantId,
      branchId: req.branchId,
      customerOrder: order._id,
      transaction: tx._id,
      posShift: shift?._id,
      method: p.method,
      amount: Number(p.amount),
      processedBy: req.user.employeeId || undefined,
    });
  }

  const newPaid = Math.round((already + paySum) * 100) / 100;
  order.amountPaidTotal = newPaid;
  order.paymentMethod = payments[0].method;

  if (newPaid >= order.grandTotal - 0.01) {
    order.paymentStatus = 'paid';
    await applyPaidTransition(order, req);
    await lockInvoiceForOrder(order, req);
  } else {
    order.paymentStatus = 'partial';
    await order.save();
    emitOrderUpdate(String(restaurantId), order);
  }

  if (shift && newPaid >= order.grandTotal - 0.01) {
    shift.totalSales = Math.round((Number(shift.totalSales) + order.grandTotal) * 100) / 100;
    for (const p of payments) {
      if (p.method === 'cash') shift.cashSales = Math.round((Number(shift.cashSales) + Number(p.amount)) * 100) / 100;
      if (p.method === 'online') shift.onlineSales = Math.round((Number(shift.onlineSales) + Number(p.amount)) * 100) / 100;
    }
    await shift.save();
  }
  await fraudDetection.detectSalesSpike({ restaurantId, branchId: req.branchId });

  emitPaymentUpdate(String(restaurantId), {
    customerOrder: { _id: order._id, orderNumber: order.orderNumber, grandTotal: order.grandTotal },
    orderNumber: order.orderNumber,
    paymentStatus: order.paymentStatus,
    amountPaidTotal: order.amountPaidTotal,
  });

  await notificationService.sendNotification({
    recipientType: 'restaurant',
    recipientId: restaurantId,
    category: 'order',
    type: 'payment_received',
    priority: 'high',
    title: 'POS payment',
    message: `Payment recorded for order #${order.orderNumber}.`,
    relatedEntity: { entityType: 'order', entityId: order._id },
    actionUrl: '/notifications',
  });

  await writeAuditLog(req, {
    action: 'pos_payment',
    resource: 'order',
    resourceId: order._id,
    details: {
      restaurantId: String(restaurantId),
      orderNumber: order.orderNumber,
      payments,
      paymentStatus: order.paymentStatus,
    },
  });

  await logPosActivity(req, {
    action: 'pos_payment',
    resourceType: 'order',
    resourceId: order._id,
    risk: payments.length > 1 ? 'medium' : 'low',
    metadata: {
      orderNumber: order.orderNumber,
      totalPaid: paySum,
      paymentStatus: order.paymentStatus,
      splitGroupId: splitGroupId ? String(splitGroupId) : null,
    },
  });

  return success(res, { order, splitGroupId }, 'Payment recorded');
});

/**
 * @route POST /api/restaurant/pos/refund
 */
const postPosRefund = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromUser(req);
  const { customerOrderId, amount, kind, reason, managerApproval, approval } = req.body;
  if (!customerOrderId || !amount || !kind) {
    return error(res, 'customerOrderId, amount, and kind are required', 400);
  }

  const order = await CustomerOrder.findOne({
    _id: customerOrderId,
    ...legacyRestaurantScope(req),
  });

  if (!order) return error(res, 'Order not found', 404);
  if (Number(amount) <= 0 || Number(amount) > Number(order.amountPaidTotal || order.grandTotal || 0) + 0.01) {
    return error(res, 'Refund amount is invalid', 400);
  }

  let approvalDoc;
  try {
    approvalDoc = await createApproval(req, {
      action: kind === 'void' ? 'void_bill' : 'refund',
      resourceType: 'order',
      resourceId: order._id,
      approvalInput: managerApproval || approval || {},
      metadata: { amount: Number(amount), kind, orderNumber: order.orderNumber },
    });
  } catch (approvalErr) {
    return error(res, approvalErr.message || 'Manager approval required', approvalErr.statusCode || 403);
  }

  const refund = await POSRefund.create({
    restaurant: restaurantId,
    branchId: req.branchId,
    customerOrder: order._id,
    amount: Number(amount),
    kind,
    reason: reason || '',
    requestedBy: actorRef(req),
    requestedByModel: actorModel(req),
    approvedBy: approvalDoc.approvedBy,
    approvedByModel: approvalDoc.approvedByModel,
    approval: approvalDoc._id,
    status: 'approved',
  });

  order.paymentStatus = 'failed';
  if (kind === 'void') {
    order.status = 'cancelled';
    await POSInvoice.findOneAndUpdate(
      {
        restaurant: restaurantId,
        branchId: req.branchId,
        customerOrder: order._id,
      },
      {
        $set: {
          status: 'voided',
          voidedAt: new Date(),
          voidedBy: approvalDoc.approvedBy,
          voidedByModel: approvalDoc.approvedByModel,
          voidReason: reason || '',
        },
      }
    );
  }
  order.statusHistory.push({
    status: order.status,
    timestamp: new Date(),
    updatedBy: actorId(req),
    note: `Refund (${kind}): ${reason || '—'}`,
  });
  await order.save();
  emitOrderUpdate(String(restaurantId), order);

  await writeAuditLog(req, {
    action: 'pos_refund',
    resource: 'order',
    resourceId: order._id,
    details: { refundId: String(refund._id), amount, kind },
  });

  const shift = await getOpenShiftForUser(req);
  if (shift) {
    shift.refunds = Math.round((Number(shift.refunds || 0) + Number(amount)) * 100) / 100;
    await shift.save();
  }

  await logPosActivity(req, {
    action: kind === 'void' ? 'pos_void_bill' : 'pos_refund',
    resourceType: 'order',
    resourceId: order._id,
    risk: 'high',
    metadata: {
      refundId: String(refund._id),
      approvalId: String(approvalDoc._id),
      amount: Number(amount),
      kind,
      reason: reason || '',
    },
  });

  await fraudDetection.detectRefundFraud({ req, order, refund, amount: Number(amount), kind });

  return success(res, { refund, order }, 'Refund recorded');
});

/**
 * @route GET /api/restaurant/pos/reports
 */
const getPosReports = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromUser(req);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const weekStart = new Date(start);
  weekStart.setDate(start.getDate() - 6);
  const restaurantObjectId = new mongoose.Types.ObjectId(restaurantId);
  const match = { restaurant: restaurantObjectId, createdAt: { $gte: start } };
  const weekMatch = { restaurant: restaurantObjectId, createdAt: { $gte: weekStart } };

  const [
    orderCount,
    paidAgg,
    methodAgg,
    unpaidAgg,
    refundAgg,
    statusAgg,
    channelAgg,
    hourlyAgg,
    weekAgg,
    openShifts,
    staffCollections,
  ] = await Promise.all([
    POSOrder.countDocuments({ restaurant: restaurantId, createdAt: { $gte: start } }),
    CustomerOrder.aggregate([
      { $match: { ...match, paymentStatus: 'paid' } },
      { $group: { _id: null, total: { $sum: '$grandTotal' } } },
    ]),
    POSPayment.aggregate([
      { $match: match },
      { $group: { _id: '$method', total: { $sum: '$amount' } } },
    ]),
    CustomerOrder.aggregate([
      { $match: { ...match, paymentStatus: { $in: ['pending', 'partial'] } } },
      {
        $group: {
          _id: null,
          total: { $sum: '$grandTotal' },
          paid: { $sum: '$amountPaidTotal' },
          count: { $sum: 1 },
        },
      },
    ]),
    POSRefund.aggregate([
      { $match: match },
      { $group: { _id: '$kind', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    CustomerOrder.aggregate([
      { $match: match },
      { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$grandTotal' } } },
      { $sort: { count: -1 } },
    ]),
    CustomerOrder.aggregate([
      { $match: match },
      { $group: { _id: '$orderChannel', count: { $sum: 1 }, total: { $sum: '$grandTotal' } } },
      { $sort: { total: -1 } },
    ]),
    CustomerOrder.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $hour: '$createdAt' },
          orders: { $sum: 1 },
          revenue: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, '$grandTotal', 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    CustomerOrder.aggregate([
      { $match: weekMatch },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          orders: { $sum: 1 },
          revenue: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, '$grandTotal', 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    POSShift.find({ restaurant: restaurantId, status: 'open' })
      .populate('operator', 'name username role')
      .sort({ openedAt: -1 })
      .lean(),
    POSPayment.aggregate([
      { $match: match },
      { $group: { _id: '$processedBy', total: { $sum: '$amount' }, payments: { $sum: 1 } } },
      { $sort: { total: -1 } },
      { $limit: 8 },
      {
        $lookup: {
          from: 'employees',
          localField: '_id',
          foreignField: '_id',
          as: 'employee',
        },
      },
      { $unwind: { path: '$employee', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          total: 1,
          payments: 1,
          name: { $ifNull: ['$employee.name', 'Owner / Restaurant'] },
          role: '$employee.role',
        },
      },
    ]),
  ]);

  const topItems = await CustomerOrder.aggregate([
    { $match: { restaurant: restaurantObjectId, createdAt: { $gte: start } } },
    { $unwind: '$items' },
    { $group: { _id: '$items.name', qty: { $sum: '$items.quantity' }, revenue: { $sum: '$items.subtotal' } } },
    { $sort: { qty: -1 } },
    { $limit: 8 },
  ]);

  const unpaidRow = unpaidAgg[0] || { total: 0, paid: 0, count: 0 };
  const refundTotal = refundAgg.reduce((sum, row) => sum + Number(row.total || 0), 0);
  const weekRevenue = weekAgg.reduce((sum, row) => sum + Number(row.revenue || 0), 0);
  const weekOrders = weekAgg.reduce((sum, row) => sum + Number(row.orders || 0), 0);
  const todayRevenue = paidAgg[0]?.total || 0;

  return success(res, {
    today: {
      orders: orderCount,
      revenue: todayRevenue,
      averageTicket: orderCount ? Math.round((todayRevenue / orderCount) * 100) / 100 : 0,
      unpaidBalance: Math.max(0, (unpaidRow.total || 0) - (unpaidRow.paid || 0)),
      unpaidOrders: unpaidRow.count || 0,
      refunds: refundTotal,
      paymentsByMethod: methodAgg,
      topItems,
      statusBreakdown: statusAgg,
      channelBreakdown: channelAgg,
      hourly: hourlyAgg,
      staffCollections,
    },
    week: {
      orders: weekOrders,
      revenue: weekRevenue,
      daily: weekAgg,
    },
    shifts: {
      openCount: openShifts.length,
      open: openShifts.map((shift) => ({
        _id: shift._id,
        operatorType: shift.operatorType,
        operatorName: shift.operator?.name || shift.operator?.username || 'Restaurant owner',
        operatorRole: shift.operator?.role || 'owner',
        openingCash: shift.openingCash,
        totalSales: shift.totalSales,
        openedAt: shift.openedAt,
      })),
    },
  });
});

const openShift = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromUser(req);
  const { openingCash = 0, notes = '' } = req.body;
  const existing = await getOpenShiftForUser(req);
  if (existing) return error(res, 'A shift is already open', 400);
  const operator = shiftOperatorFromUser(req);
  const actorDetails = shiftActorDetails(req);

  const shift = await POSShift.create({
    restaurant: restaurantId,
    branchId: req.branchId || null,
    operatorType: operator.operatorType,
    operator: operator.operator,
    openedBy: operator.operatorType === 'Employee' ? operator.operator : undefined,
    openedByModel: operator.operatorType === 'Employee' ? 'Employee' : operator.operatorType,
    openingCash: Number(openingCash) || 0,
    notes,
    status: 'open',
  });

  await writeAuditLog(req, {
    action: 'pos_shift_open',
    resource: 'system',
    resourceId: shift._id,
    details: {
      openingCash,
      ...actorDetails,
    },
  });

  await logPosActivity(req, {
    action: 'pos_shift_open',
    resourceType: 'shift',
    resourceId: shift._id,
    risk: 'low',
    metadata: { openingCash: Number(openingCash) || 0 },
  });

  emitPosShiftOpened(String(restaurantId), {
    shiftId: shift._id,
    openedAt: shift.openedAt,
    ...actorDetails,
  });

  return success(res, { shift }, 'Shift opened', 201);
});

const closeShift = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromUser(req);
  const { closingCash = 0, notes = '', managerApproval, approval } = req.body;
  const shift = await getOpenShiftForUser(req);
  if (!shift) return error(res, 'No open shift', 400);

  const paidToday = await POSPayment.aggregate([
    {
      $match: {
        restaurant: new mongoose.Types.ObjectId(restaurantId),
        posShift: shift._id,
      },
    },
    { $group: { _id: '$method', total: { $sum: '$amount' } } },
  ]);
  const totalsByMethod = paidToday.reduce((acc, row) => {
    acc[row._id] = Number(row.total || 0);
    return acc;
  }, {});

  shift.status = 'closed';
  shift.closedAt = new Date();
  const operator = shiftOperatorFromUser(req);
  const actorDetails = shiftActorDetails(req);
  shift.closedBy = operator.operatorType === 'Employee' ? operator.operator : undefined;
  shift.closedByModel = operator.operatorType;
  shift.closingCash = Number(closingCash) || 0;
  shift.cashSales = totalsByMethod.cash || shift.cashSales || 0;
  shift.onlineSales = totalsByMethod.online || shift.onlineSales || 0;
  shift.totalSales = Object.values(totalsByMethod).reduce((sum, value) => sum + value, 0) || shift.totalSales || 0;
  const drawerAdjustmentTotal = (shift.drawerAdjustments || []).reduce((sum, row) => {
    const amt = Number(row.amount || 0);
    return sum + (row.type === 'cash_out' ? -amt : amt);
  }, 0);
  shift.expectedCash = (shift.openingCash || 0) + (shift.cashSales || 0) + drawerAdjustmentTotal - (shift.refunds || 0);
  shift.difference = shift.closingCash - shift.expectedCash;
  if (Math.abs(shift.difference) > 0.01 && !isManagerLike(req)) {
    try {
      await createApproval(req, {
        action: 'shift_close_variance',
        resourceType: 'shift',
        resourceId: shift._id,
        approvalInput: managerApproval || approval || {},
        metadata: {
          closingCash: shift.closingCash,
          expectedCash: shift.expectedCash,
          difference: shift.difference,
        },
      });
    } catch (approvalErr) {
      return error(res, approvalErr.message || 'Manager approval required for drawer variance', approvalErr.statusCode || 403);
    }
  }
  if (notes) shift.notes = `${shift.notes || ''}\n${notes}`.trim();
  await shift.save();

  emitPosShiftClosed(String(restaurantId), {
    shiftId: shift._id,
    closedAt: shift.closedAt,
    ...actorDetails,
  });

  await notificationService.sendNotification({
    recipientType: 'restaurant',
    recipientId: restaurantId,
    category: 'system',
    type: 'pos_shift_closed',
    priority: 'medium',
    title: 'POS shift closed',
    message: `${actorDetails.operatorName || actorDetails.operatorRole || 'POS operator'} closed a shift. Expected cash ${shift.expectedCash}, counted ${shift.closingCash}.`,
    actionUrl: '/notifications',
  });

  await writeAuditLog(req, {
    action: 'pos_shift_close',
    resource: 'system',
    resourceId: shift._id,
    details: {
      closingCash: shift.closingCash,
      expectedCash: shift.expectedCash,
      difference: shift.difference,
      ...actorDetails,
    },
  });

  await logPosActivity(req, {
    action: 'pos_shift_close',
    resourceType: 'shift',
    resourceId: shift._id,
    risk: Math.abs(shift.difference) > 0.01 ? 'high' : 'low',
    metadata: {
      closingCash: shift.closingCash,
      expectedCash: shift.expectedCash,
      difference: shift.difference,
    },
  });

  return success(res, { shift }, 'Shift closed');
});

const getShift = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromUser(req);
  const shift = await getOpenShiftForUser(req);
  return success(res, { shift, open: Boolean(shift) });
});

const getPosMeta = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromUser(req);
  const restaurant = await Restaurant.findById(restaurantId).select('name logo settings');
  const tables = await Table.find({
    restaurant: restaurantId,
    isDeleted: false,
    isActive: true,
    allowsConcurrentOrders: { $ne: true },
  })
    .select('tableNumber capacity posStatus guestCount assignedWaiter currentCustomerOrder')
    .sort({ tableNumber: 1 });
  const shift = await getOpenShiftForUser(req);
  const activeTables = await Table.countDocuments({
    restaurant: restaurantId,
    isDeleted: false,
    posStatus: 'occupied',
  });
  return success(res, { restaurant, tables, shift, activeTables });
});

const saveCartDraft = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromUser(req);
  const keyedBy =
    req.user.scope === 'employee' ? `emp:${req.user.id}` : `rest:${req.user.id}`;
  const { payload } = req.body;
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await POSCart.findOneAndUpdate(
    { restaurant: restaurantId, keyedBy },
    { payload: payload || {}, expiresAt },
    { upsert: true, new: true }
  );
  return success(res, {}, 'Cart saved');
});

const loadCartDraft = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromUser(req);
  const keyedBy =
    req.user.scope === 'employee' ? `emp:${req.user.id}` : `rest:${req.user.id}`;
  const doc = await POSCart.findOne({ restaurant: restaurantId, keyedBy });
  return success(res, { payload: doc?.payload || null });
});

const voidBill = asyncHandler(async (req, res) => {
  req.body.kind = 'void';
  req.body.amount = req.body.amount || 0;
  const restaurantId = restaurantIdFromUser(req);
  const { customerOrderId, reason = '', managerApproval, approval } = req.body;
  if (!customerOrderId) return error(res, 'customerOrderId is required', 400);

  const order = await CustomerOrder.findOne({
    _id: customerOrderId,
    ...legacyRestaurantScope(req),
    isActive: true,
  });
  if (!order) return error(res, 'Order not found', 404);
  if (order.paymentStatus === 'paid') {
    return error(res, 'Paid invoices must be refunded before they can be voided', 400);
  }

  let approvalDoc;
  try {
    approvalDoc = await createApproval(req, {
      action: 'void_bill',
      resourceType: 'order',
      resourceId: order._id,
      approvalInput: managerApproval || approval || {},
      metadata: { orderNumber: order.orderNumber, reason },
    });
  } catch (approvalErr) {
    return error(res, approvalErr.message || 'Manager approval required', approvalErr.statusCode || 403);
  }

  order.status = 'cancelled';
  order.paymentStatus = 'failed';
  order.statusHistory.push({
    status: 'cancelled',
    timestamp: new Date(),
    updatedBy: actorId(req),
    note: `Bill voided: ${reason || 'No reason provided'}`,
  });
  await order.save();

  const invoice = await POSInvoice.findOneAndUpdate(
    {
      restaurant: restaurantId,
      branchId: req.branchId,
      customerOrder: order._id,
    },
    {
      $set: {
        status: 'voided',
        voidedAt: new Date(),
        voidedBy: approvalDoc.approvedBy,
        voidedByModel: approvalDoc.approvedByModel,
        voidReason: reason,
      },
    },
    { new: true }
  );

  emitOrderUpdate(String(restaurantId), order);
  await writeAuditLog(req, {
    action: 'pos_bill_voided',
    resource: 'order',
    resourceId: order._id,
    details: {
      restaurantId: String(restaurantId),
      orderNumber: order.orderNumber,
      invoiceNumber: invoice?.invoiceNumber,
      approvalId: String(approvalDoc._id),
      reason,
    },
  });
  await logPosActivity(req, {
    action: 'pos_bill_voided',
    resourceType: 'order',
    resourceId: order._id,
    risk: 'critical',
    metadata: {
      invoiceNumber: invoice?.invoiceNumber,
      approvalId: String(approvalDoc._id),
      reason,
    },
  });

  return success(res, { order, invoice }, 'Bill voided');
});

const adjustDrawer = asyncHandler(async (req, res) => {
  const { amount, type, reason = '', managerApproval, approval } = req.body;
  const shift = await getOpenShiftForUser(req);
  if (!shift) return error(res, 'No open shift', 400);
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0 || !['cash_in', 'cash_out'].includes(type)) {
    return error(res, 'Valid amount and type are required', 400);
  }

  let approvalDoc;
  try {
    approvalDoc = await createApproval(req, {
      action: 'drawer_adjustment',
      resourceType: 'shift',
      resourceId: shift._id,
      approvalInput: managerApproval || approval || {},
      metadata: { amount: amt, type, reason },
    });
  } catch (approvalErr) {
    return error(res, approvalErr.message || 'Manager approval required', approvalErr.statusCode || 403);
  }

  shift.drawerAdjustments.push({
    amount: amt,
    type,
    reason,
    approvedBy: approvalDoc.approvedBy,
    approvedByModel: approvalDoc.approvedByModel,
  });
  await shift.save();

  await writeAuditLog(req, {
    action: 'pos_drawer_adjustment',
    resource: 'system',
    resourceId: shift._id,
    details: { amount: amt, type, reason, approvalId: String(approvalDoc._id) },
  });
  await logPosActivity(req, {
    action: 'pos_drawer_adjustment',
    resourceType: 'shift',
    resourceId: shift._id,
    risk: 'high',
    metadata: { amount: amt, type, reason, approvalId: String(approvalDoc._id) },
  });

  return success(res, { shift }, 'Drawer adjusted');
});

const syncOfflineActions = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromUser(req);
  const actions = Array.isArray(req.body?.actions) ? req.body.actions : [];
  const deviceId = String(req.body?.deviceId || req.get('X-Device-Id') || '').slice(0, 120);
  if (!actions.length) return error(res, 'actions[] is required', 400);
  if (actions.length > 50) return error(res, 'At most 50 offline actions can be synced at once', 400);

  const results = [];
  for (const row of actions) {
    const clientRequestId = String(row.clientRequestId || row.id || '').trim();
    const action = String(row.action || '').trim();
    if (!clientRequestId || !action) {
      results.push({ clientRequestId, action, status: 'rejected', message: 'clientRequestId and action are required' });
      continue;
    }

    const payloadHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(row.payload || {}))
      .digest('hex');

    const existing = await POSOfflineSync.findOne({
      restaurant: restaurantId,
      branchId: req.branchId || null,
      clientRequestId,
    });
    if (existing) {
      results.push({
        clientRequestId,
        action,
        status: existing.payloadHash === payloadHash ? 'duplicate' : 'conflict',
        result: existing.result,
      });
      continue;
    }

    if (!['create_order', 'save_cart'].includes(action)) {
      results.push({ clientRequestId, action, status: 'rejected', message: 'Unsupported offline action' });
      continue;
    }

    const result = {
      accepted: true,
      replayEndpoint: action === 'create_order' ? '/api/restaurant/pos/order' : '/api/restaurant/pos/cart',
      message: 'Action accepted for idempotent replay by the POS client',
    };
    await POSOfflineSync.create({
      restaurant: restaurantId,
      branchId: req.branchId || null,
      clientRequestId,
      deviceId,
      action,
      payloadHash,
      result,
      processedBy: actorRef(req),
      processedByModel: actorModel(req),
    });
    results.push({ clientRequestId, action, status: 'accepted', result });
  }

  await logPosActivity(req, {
    action: 'pos_offline_sync',
    resourceType: 'system',
    risk: results.some((r) => r.status === 'conflict') ? 'high' : 'medium',
    metadata: { deviceId, count: actions.length, results },
  });

  return success(res, { results }, 'Offline actions synchronized');
});

module.exports = {
  createPosOrder,
  listPosOrders,
  postPosPayment,
  postPosRefund,
  getPosReports,
  openShift,
  closeShift,
  getShift,
  getPosMeta,
  saveCartDraft,
  loadCartDraft,
  voidBill,
  adjustDrawer,
  syncOfflineActions,
};
