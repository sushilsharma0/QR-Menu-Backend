const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const CustomerOrder = require('../../models/restaurant/CustomerOrder');
const POSOrder = require('../../models/restaurant/POSOrder');
const Table = require('../../models/restaurant/Table');
const MenuItem = require('../../models/restaurant/MenuItem');
const { generateRandomToken } = require('../../utils/generateToken');
const { success, error } = require('../../utils/apiResponse');
const {
  emitOrderUpdate,
  emitPosKitchenReady,
  emitPosNewOrder,
  emitPosTableUpdated,
} = require('../../services/socketService');
const { createNewOrderNotifications } = require('../../services/notifications/orderNotificationService');
const { sendOrderConfirmationEmail } = require('../../services/emailService');
const { sendOrderReadySms } = require('../../services/smsService');
const Restaurant = require('../../models/restaurant/Restaurant');
const { getLoyaltySettings } = require('../../services/loyaltyService');
const { writeAuditLog } = require('../../utils/auditLog');
const { applyRecipeDeductionForCompletedOrder } = require('../../services/recipeInventoryService');
const { ensureSalesReportForOrder } = require('../../services/salesReportService');
const { addFieldsPaymentMethodBucket } = require('../../utils/paymentMethodAggregation');
const { legacyRestaurantScope } = require('../../utils/tenantScope');
const {
  buildOrderLineFromMenuItem,
  roundMoney,
} = require('../../services/variationService');

const parseDateOnly = (value, endOfDay = false) => {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(value);

  if (Number.isNaN(date.getTime())) return null;
  date.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  return date;
};

/**
 * @desc    Create customer order via QR
 * @route   POST /api/restaurant/customer-orders
 * @access  Private
 */
const createOrder = asyncHandler(async (req, res) => {
  const {
    tableId,
    customerName,
    customerPhone,
    customerEmail,
    items,
    specialRequests,
    guestId,
    orderChannel: orderChannelBody,
  } = req.body;
  const restaurantId = req.user.restaurantId || req.user.id;
  const isWaiter = req.user.scope === 'employee' && req.user.role === 'waiter';
  
  if (!tableId || !items || items.length === 0) {
    return error(res, 'Table ID and items are required', 400);
  }

  const normalizedCustomerName =
    String(customerName || '').trim() ||
    (isWaiter ? `Walk-in (${req.user.name || 'Waiter'})` : 'QR Customer');
  
  const table = await Table.findOne({
    _id: tableId,
    restaurant: restaurantId,
    branchId: req.branchId,
    isActive: true,
    isDeleted: false
  });
  
  if (!table) {
    return error(res, 'Table not found or inactive', 404);
  }

  if (!table.allowsConcurrentOrders) {
    const activeOrder = await CustomerOrder.findOne({
      ...legacyRestaurantScope(req),
      table: tableId,
      status: { $in: ['pending', 'confirmed', 'preparing', 'cooking', 'ready'] },
      isActive: true,
    });

    if (activeOrder) {
      return error(res, 'Table already has an active order', 400);
    }
  }
  
  let totalAmount = 0;
  let taxAmount = 0;
  const orderItems = [];
  
  for (const item of items) {
    const menuItem = await MenuItem.findOne({
      _id: item.menuItemId,
      restaurant: restaurantId,
      branchId: req.branchId,
      isDeleted: false,
    });
    
    if (!menuItem) {
      return error(res, `Menu item not found: ${item.menuItemId}`, 404);
    }
    
    if (!menuItem.isAvailable) {
      return error(res, `${menuItem.name} is currently unavailable`, 400);
    }
    
    let orderLine;
    try {
      orderLine = buildOrderLineFromMenuItem(menuItem, item, {
        branchId: req.branchId,
        orderType: orderChannelBody || 'dine_in',
      });
    } catch (err) {
      return error(res, err.message || 'Invalid variation selections', err.statusCode || 400);
    }
    const subtotal = orderLine.subtotal;
    const itemTax = orderLine.taxAmount;
    totalAmount += subtotal;
    taxAmount += itemTax;
    orderItems.push(orderLine);
  }
  
  const grandTotal = totalAmount + taxAmount;
  const qrToken = generateRandomToken(32);

  const channelAllowed = ['dine_in', 'qr_ordering', 'delivery', 'takeaway'];
  let orderChannel = isWaiter ? 'dine_in' : 'qr_ordering';
  if (orderChannelBody && channelAllowed.includes(String(orderChannelBody))) {
    orderChannel = orderChannelBody;
  }
  
  const order = await CustomerOrder.create({
    qrToken,
    restaurant: restaurantId,
    restaurantId,
    branchId: req.branchId,
    table: tableId,
    guestId: guestId || null,
    customerName: normalizedCustomerName,
    customerPhone,
    customerEmail,
    items: orderItems,
    totalAmount,
    taxAmount,
    grandTotal,
    specialRequests,
    orderChannel,
    createdBy: {
      type: isWaiter ? 'waiter' : 'qr',
      employeeId: isWaiter ? req.user.id : null,
    },
    statusHistory: [{ status: 'pending', timestamp: new Date() }]
  });
  
  await order.populate('table', 'tableNumber');

  await POSOrder.create({
    restaurant: restaurantId,
    branchId: req.branchId,
    customerOrder: order._id,
    primaryStaff: isWaiter ? req.user.id : undefined,
    source: 'qr_menu',
  });

  if (!table.allowsConcurrentOrders) {
    table.posStatus = 'occupied';
    table.currentCustomerOrder = order._id;
    await table.save();
    emitPosTableUpdated(String(restaurantId), table);
  }
  
  await createNewOrderNotifications(order);
  emitPosNewOrder(String(restaurantId), {
    order,
    tableId: table._id,
    mode: 'dine_in',
    source: 'qr_menu',
  });
  
  if (customerEmail) {
    await sendOrderConfirmationEmail(customerEmail, order.orderNumber, orderItems, grandTotal);
  }
  
  return success(res, {
    orderId: order._id,
    orderNumber: order.orderNumber,
    qrToken: order.qrToken,
    status: order.status,
    totalAmount: order.grandTotal
  }, 'Order placed successfully', 201);
});

/**
 * @desc    Get order by QR token (customer tracking)
 * @route   GET /api/restaurant/customer-orders/track/:token
 * @access  Public
 */
const getOrderByQRToken = asyncHandler(async (req, res) => {
  const { token } = req.params;
  
  const order = await CustomerOrder.findOne({
    qrToken: token,
    isActive: true
  })
    .populate('restaurant', 'name logo')
    .populate('table', 'tableNumber');
  
  if (!order) {
    return error(res, 'Order not found', 404);
  }
  
  let estimatedCompletionTime = null;
  if (order.estimatedWaitTime && !['served', 'completed', 'cancelled'].includes(order.status)) {
    const confirmedAt = order.statusHistory.find(h => h.status === 'confirmed')?.timestamp || order.createdAt;
    estimatedCompletionTime = new Date(confirmedAt.getTime() + (order.estimatedWaitTime * 60 * 1000));
    if (order.kitchenDelayMinutes > 0) {
      estimatedCompletionTime = new Date(
        estimatedCompletionTime.getTime() + order.kitchenDelayMinutes * 60 * 1000,
      );
    }
  }
  
  return success(res, {
    orderNumber: order.orderNumber,
    status: order.status,
    customerName: order.customerName,
    tableNumber: order.table.tableNumber,
    restaurant: {
      name: order.restaurant.name,
      logo: order.restaurant.logo
    },
    totalAmount: order.grandTotal,
    items: order.items,
    orderTime: order.createdAt,
    estimatedWaitTime: order.estimatedWaitTime,
    estimatedCompletionTime,
    actualWaitTime: order.actualWaitTime,
    statusHistory: order.statusHistory,
    kitchenDelayMinutes: order.kitchenDelayMinutes || 0,
    kitchenDelayMessage: order.kitchenDelayMessage || '',
    kitchenDelayUpdatedAt: order.kitchenDelayUpdatedAt,
  }, 'Order details retrieved');
});

/**
 * @desc    Get all customer orders for restaurant
 * @route   GET /api/restaurant/customer-orders
 * @access  Private
 */
const getRestaurantOrders = asyncHandler(async (req, res) => {
  const restaurantId = req.user.restaurantId || req.user.id;
  const {
    status,
    paymentStatus,
    search,
    dateFrom,
    dateTo,
    page = 1,
    limit = 20,
    isCreditSale,
    creditCustomerId,
  } = req.query;
  
  const query = { ...legacyRestaurantScope(req), isActive: true };
  if (status) {
    const statuses = String(status)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    query.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
  }
  if (paymentStatus) {
    const paymentStatuses = String(paymentStatus)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    query.paymentStatus =
      paymentStatuses.length > 1 ? { $in: paymentStatuses } : paymentStatuses[0];
  }
  if (search && String(search).trim()) {
    const q = String(search).trim();
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.$or = [
      { orderNumber: new RegExp(esc, 'i') },
      { guestId: new RegExp(esc, 'i') },
      { customerName: new RegExp(esc, 'i') },
      { customerPhone: new RegExp(esc, 'i') },
      { customerEmail: new RegExp(esc, 'i') },
    ];
  }
  if (dateFrom || dateTo) {
    query.createdAt = {};
    if (dateFrom) {
      const from = parseDateOnly(dateFrom);
      if (from) query.createdAt.$gte = from;
    }
    if (dateTo) {
      const to = parseDateOnly(dateTo, true);
      if (to) query.createdAt.$lte = to;
    }
    if (Object.keys(query.createdAt).length === 0) delete query.createdAt;
  }

  if (String(isCreditSale).toLowerCase() === 'true') {
    query.isCreditSale = true;
  }
  if (creditCustomerId && mongoose.Types.ObjectId.isValid(String(creditCustomerId))) {
    query.restaurantCreditCustomer = new mongoose.Types.ObjectId(String(creditCustomerId));
    query.isCreditSale = true;
  }
  
  const skip = (page - 1) * limit;
  
  const orders = await CustomerOrder.find(query)
    .populate('table', 'tableNumber')
    .populate('createdBy.employeeId', 'name username role')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(parseInt(limit));
  
  const total = await CustomerOrder.countDocuments(query);
  
  return success(res, {
    orders,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / limit)
    }
  }, 'Orders retrieved');
});

/**
 * @desc    Get single customer order
 * @route   GET /api/restaurant/customer-orders/:id
 * @access  Private
 */
const getOrderDetails = asyncHandler(async (req, res) => {
  const restaurantId = req.user.restaurantId || req.user.id;
  const order = await CustomerOrder.findOne({
    _id: req.params.id,
    ...legacyRestaurantScope(req),
    isActive: true
  })
    .populate('table', 'tableNumber')
    .populate('createdBy.employeeId', 'name username role')
    .populate('items.menuItem', 'name price image');
  
  if (!order) {
    return error(res, 'Order not found', 404);
  }
  
  return success(res, order, 'Order details retrieved');
});

/**
 * @desc    Update customer order status
 * @route   PATCH /api/restaurant/customer-orders/:id/status
 * @access  Private
 */
const updateOrderStatus = asyncHandler(async (req, res) => {
  const {
    status,
    estimatedWaitTime,
    note,
    kitchenDelayMinutes,
    kitchenDelayMessage,
  } = req.body;
  const restaurantId = req.user.restaurantId || req.user.id;
  
  const validStatuses = ['pending', 'confirmed', 'preparing', 'cooking', 'ready', 'served', 'completed', 'cancelled'];
  if (status && !validStatuses.includes(status)) {
    return error(res, 'Invalid order status', 400);
  }
  if (!status && kitchenDelayMinutes == null && !kitchenDelayMessage) {
    return error(res, 'status or kitchen delay fields are required', 400);
  }
  
  const order = await CustomerOrder.findOne({
    _id: req.params.id,
    ...legacyRestaurantScope(req),
    isActive: true
  });

  if (!order) {
    return error(res, 'Order not found', 404);
  }

  if (kitchenDelayMinutes != null && kitchenDelayMinutes !== '') {
    const mins = Number(kitchenDelayMinutes);
    if (!Number.isNaN(mins) && mins > 0) {
      order.kitchenDelayMinutes = mins;
      order.kitchenDelayMessage =
        kitchenDelayMessage || `Your order may take about ${mins} extra minutes.`;
      order.kitchenDelayUpdatedAt = new Date();
    }
  } else if (kitchenDelayMessage) {
    order.kitchenDelayMessage = String(kitchenDelayMessage);
    order.kitchenDelayUpdatedAt = new Date();
  }

  if (!status) {
    await order.save();
    emitOrderUpdate(restaurantId, order);
    return success(res, {
      orderId: order._id,
      orderNumber: order.orderNumber,
      status: order.status,
      kitchenDelayMinutes: order.kitchenDelayMinutes,
      kitchenDelayMessage: order.kitchenDelayMessage,
    }, 'Kitchen notice updated');
  }
  
  const previousStatus = order.status;
  order.status = status;
  order.statusHistory.push({
    status,
    timestamp: new Date(),
    updatedBy: req.user.employeeId || req.user.id,
    note
  });
  
  if (status === 'confirmed' && estimatedWaitTime) {
    order.estimatedWaitTime = estimatedWaitTime;
  }
  
  if (status === 'served' || status === 'completed') {
    const confirmedTime = order.statusHistory.find(h => h.status === 'confirmed')?.timestamp;
    if (confirmedTime) {
      order.actualWaitTime = Math.round((new Date() - confirmedTime) / (1000 * 60));
    }
  }
  
  await order.save();

  if (status === 'completed' && previousStatus !== 'completed') {
    try {
      await applyRecipeDeductionForCompletedOrder(order, {
        userId: req.user.employeeId || req.user.id,
        userModel: req.user.scope === 'employee' ? 'Employee' : 'Restaurant',
      });
    } catch (err) {
      console.error('recipeInventory deduction failed', err);
    }

    try {
      await ensureSalesReportForOrder(order);
    } catch (err) {
      console.error('sales report sync failed', err);
    }
  }

  await writeAuditLog(req, {
    action: 'order_status_update',
    resource: 'order',
    resourceId: order._id,
    details: {
      restaurantId: String(restaurantId),
      orderNumber: order.orderNumber,
      previousStatus,
      status,
      estimatedWaitTime: order.estimatedWaitTime,
      note,
      message: `Order #${order.orderNumber} moved from ${previousStatus} to ${status}`,
    },
  });

  if (status === 'ready') {
    emitPosKitchenReady(String(restaurantId), {
      orderId: order._id,
      orderNumber: order.orderNumber,
    });
    if (order.customerPhone) {
      try {
        const restaurantDoc = await Restaurant.findById(restaurantId).select('name settings.loyalty').lean();
        const loyaltyCfg = getLoyaltySettings(restaurantDoc);
        if (loyaltyCfg.smsOnOrderReady) {
          await sendOrderReadySms({
            phone: order.customerPhone,
            restaurantName: restaurantDoc?.name,
            orderNumber: order.orderNumber,
          });
        }
      } catch (smsErr) {
        console.error('order ready sms', smsErr);
      }
    }
  }
  
  emitOrderUpdate(restaurantId, order);
  
  return success(res, {
    orderId: order._id,
    orderNumber: order.orderNumber,
    status: order.status,
    estimatedWaitTime: order.estimatedWaitTime,
    actualWaitTime: order.actualWaitTime,
    kitchenDelayMinutes: order.kitchenDelayMinutes,
    kitchenDelayMessage: order.kitchenDelayMessage,
  }, 'Order status updated');
});

const updateOrderItemKitchenStatus = asyncHandler(async (req, res) => {
  const { itemId } = req.params;
  const { kitchenStatus, kitchenStation, note } = req.body;
  const restaurantId = req.user.restaurantId || req.user.id;
  const validItemStatuses = ['queued', 'preparing', 'cooking', 'ready', 'served', 'held', 'cancelled'];

  if (!validItemStatuses.includes(kitchenStatus)) {
    return error(res, 'Invalid kitchen item status', 400);
  }

  const order = await CustomerOrder.findOne({
    _id: req.params.id,
    ...legacyRestaurantScope(req),
    isActive: true,
  }).populate('table', 'tableNumber');

  if (!order) return error(res, 'Order not found', 404);

  const item = order.items.id(itemId);
  if (!item) return error(res, 'Order item not found', 404);

  item.kitchenStatus = kitchenStatus;
  if (kitchenStation != null) item.kitchenStation = String(kitchenStation || 'main').trim() || 'main';
  if (kitchenStatus === 'preparing' && !item.kitchenStartedAt) item.kitchenStartedAt = new Date();
  if (kitchenStatus === 'cooking' && !item.kitchenStartedAt) item.kitchenStartedAt = new Date();
  if (kitchenStatus === 'ready') item.kitchenReadyAt = new Date();
  if (kitchenStatus === 'served') item.kitchenServedAt = new Date();
  item.kitchenStatusHistory.push({
    status: kitchenStatus,
    timestamp: new Date(),
    updatedBy: req.user.employeeId || req.user.id,
    note: String(note || ''),
  });

  const statuses = order.items.map((row) => row.kitchenStatus || 'queued');
  const previousStatus = order.status;
  if (statuses.length && statuses.every((s) => s === 'ready' || s === 'served')) {
    order.status = 'ready';
  } else if (statuses.some((s) => s === 'cooking')) {
    order.status = 'cooking';
  } else if (statuses.some((s) => s === 'preparing')) {
    order.status = 'preparing';
  } else if (order.status === 'pending') {
    order.status = 'confirmed';
  }

  if (order.status !== previousStatus) {
    order.statusHistory.push({
      status: order.status,
      timestamp: new Date(),
      updatedBy: req.user.employeeId || req.user.id,
      note: `Kitchen item ${item.name || itemId} moved to ${kitchenStatus}`,
    });
  }

  await order.save();

  if (order.status === 'ready' && previousStatus !== 'ready') {
    emitPosKitchenReady(String(restaurantId), {
      orderId: order._id,
      orderNumber: order.orderNumber,
    });
  }

  emitOrderUpdate(restaurantId, order);

  return success(res, order, 'Kitchen item status updated');
});

/**
 * @desc    Cancel customer order
 * @route   PATCH /api/restaurant/customer-orders/:id/cancel
 * @access  Private
 */
const cancelOrder = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const restaurantId = req.user.restaurantId || req.user.id;
  
  const order = await CustomerOrder.findOne({
    _id: req.params.id,
    ...legacyRestaurantScope(req),
    isActive: true,
    status: { $nin: ['served', 'completed', 'cancelled'] }
  });
  
  if (!order) {
    return error(res, 'Order not found or cannot be cancelled', 404);
  }
  
  order.status = 'cancelled';
  order.statusHistory.push({
    status: 'cancelled',
    timestamp: new Date(),
    updatedBy: req.user.employeeId || req.user.id,
    note: reason
  });
  
  await order.save();

  await writeAuditLog(req, {
    action: 'order_cancelled',
    resource: 'order',
    resourceId: order._id,
    details: {
      restaurantId: String(restaurantId),
      orderNumber: order.orderNumber,
      status: 'cancelled',
      reason,
      message: `Order #${order.orderNumber} was cancelled`,
    },
  });
  
  emitOrderUpdate(restaurantId, order);
  
  return success(res, {
    orderId: order._id,
    orderNumber: order.orderNumber,
    status: 'cancelled'
  }, 'Order cancelled');
});

/**
 * @desc    Get order statistics for restaurant
 * @route   GET /api/restaurant/customer-orders/stats
 * @access  Private
 */
/**
 * @desc    Order activity report: date range, optional order # search, daily totals
 * @route   GET /api/restaurant/customer-orders/activity-report
 * @access  Private (restaurant owner)
 */
const getOrderActivityReport = asyncHandler(async (req, res) => {
  const restaurantId = req.user.restaurantId || req.user.id;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 40));
  const skip = (page - 1) * limit;

  const query = { ...legacyRestaurantScope(req), isActive: true };

  if (req.query.from || req.query.to) {
    query.createdAt = {};
    if (req.query.from) {
      const d = parseDateOnly(req.query.from);
      if (d) query.createdAt.$gte = d;
    }
    if (req.query.to) {
      const d = parseDateOnly(req.query.to, true);
      if (d) query.createdAt.$lte = d;
    }
  }

  if (req.query.orderNumber && String(req.query.orderNumber).trim()) {
    const q = String(req.query.orderNumber).trim();
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.orderNumber = new RegExp(esc, 'i');
  }

  const aggregateRestaurantId = mongoose.Types.ObjectId.isValid(String(restaurantId))
    ? new mongoose.Types.ObjectId(String(restaurantId))
    : restaurantId;
  const matchStage = { ...query, restaurant: aggregateRestaurantId };

  const [
    orders,
    total,
    dailyAgg,
    rangeTotals,
    statusBreakdown,
    paymentStatusBreakdown,
    paymentMethodBreakdown,
    channelBreakdown,
    hourlyBreakdown,
    tableBreakdown,
    topItems,
  ] = await Promise.all([
    CustomerOrder.find(query)
      .select(
        'orderNumber customerName guestId createdAt status paymentStatus paymentMethod orderChannel grandTotal totalAmount taxAmount discountAmount table items'
      )
      .populate('table', 'tableNumber')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    CustomerOrder.countDocuments(query),
    CustomerOrder.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          orderCount: { $sum: 1 },
          subtotal: { $sum: '$totalAmount' },
          tax: { $sum: '$taxAmount' },
          discount: { $sum: '$discountAmount' },
          grandTotal: { $sum: '$grandTotal' },
        },
      },
      { $sort: { _id: -1 } },
    ]),
    CustomerOrder.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: null,
          orderCount: { $sum: 1 },
          subtotal: { $sum: '$totalAmount' },
          tax: { $sum: '$taxAmount' },
          discount: { $sum: '$discountAmount' },
          grandTotal: { $sum: '$grandTotal' },
          paidValue: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, '$grandTotal', 0] } },
          unpaidValue: { $sum: { $cond: [{ $in: ['$paymentStatus', ['pending', 'partial', 'failed']] }, '$grandTotal', 0] } },
          itemCount: { $sum: { $sum: '$items.quantity' } },
        },
      },
    ]),
    CustomerOrder.aggregate([
      { $match: matchStage },
      { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$grandTotal' } } },
      { $sort: { count: -1 } },
    ]),
    CustomerOrder.aggregate([
      { $match: matchStage },
      { $group: { _id: '$paymentStatus', count: { $sum: 1 }, amount: { $sum: '$grandTotal' } } },
      { $sort: { count: -1 } },
    ]),
    CustomerOrder.aggregate([
      { $match: matchStage },
      addFieldsPaymentMethodBucket('$paymentMethod', '_paymentMethodBucket'),
      { $group: { _id: '$_paymentMethodBucket', count: { $sum: 1 }, amount: { $sum: '$grandTotal' } } },
      { $sort: { amount: -1 } },
    ]),
    CustomerOrder.aggregate([
      { $match: matchStage },
      { $group: { _id: { $ifNull: ['$orderChannel', 'unknown'] }, count: { $sum: 1 }, amount: { $sum: '$grandTotal' } } },
      { $sort: { amount: -1 } },
    ]),
    CustomerOrder.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: { $dateToString: { format: '%H:00', date: '$createdAt', timezone: '+05:45' } },
          orderCount: { $sum: 1 },
          grandTotal: { $sum: '$grandTotal' },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    CustomerOrder.aggregate([
      { $match: matchStage },
      { $group: { _id: '$table', orderCount: { $sum: 1 }, grandTotal: { $sum: '$grandTotal' } } },
      { $sort: { grandTotal: -1 } },
      { $limit: 10 },
      { $lookup: { from: 'tables', localField: '_id', foreignField: '_id', as: 'table' } },
      { $unwind: { path: '$table', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          tableNumber: { $ifNull: ['$table.tableNumber', 'N/A'] },
          orderCount: 1,
          grandTotal: 1,
        },
      },
    ]),
    CustomerOrder.aggregate([
      { $match: matchStage },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.name',
          quantity: { $sum: '$items.quantity' },
          revenue: { $sum: { $multiply: ['$items.quantity', '$items.price'] } },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 10 },
    ]),
  ]);

  const rows = orders.map((o) => ({
    _id: o._id,
    orderNumber: o.orderNumber,
    createdAt: o.createdAt,
    customerName: o.customerName,
    guestId: o.guestId,
    tableNumber: o.table?.tableNumber,
    status: o.status,
    paymentStatus: o.paymentStatus,
    paymentMethod: o.paymentMethod,
    orderChannel: o.orderChannel,
    subtotalExclTax: o.totalAmount,
    taxAmount: o.taxAmount,
    discountAmount: o.discountAmount || 0,
    grandTotal: o.grandTotal,
    items: (o.items || []).map((i) => ({
      name: i.name,
      quantity: i.quantity,
      price: i.price,
      subtotal: i.subtotal,
    })),
    itemsLabel: (o.items || []).map((i) => `${i.name} ×${i.quantity}`).join(', '),
  }));

  const daily = dailyAgg.map((d) => ({
    date: d._id,
    orderCount: d.orderCount,
    subtotal: d.subtotal,
    tax: d.tax,
    discount: d.discount || 0,
    grandTotal: d.grandTotal,
  }));

  const totals = rangeTotals[0] || {
    orderCount: 0,
    subtotal: 0,
    tax: 0,
    discount: 0,
    grandTotal: 0,
    paidValue: 0,
    unpaidValue: 0,
    itemCount: 0,
  };

  return success(
    res,
    {
      rows,
      daily,
      totals,
      breakdowns: {
        status: statusBreakdown,
        paymentStatus: paymentStatusBreakdown,
        paymentMethod: paymentMethodBreakdown,
        channel: channelBreakdown,
        hourly: hourlyBreakdown,
        tables: tableBreakdown,
        topItems,
      },
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1,
      },
    },
    'Order activity report retrieved'
  );
});

const getOrderStatistics = asyncHandler(async (req, res) => {
  const restaurantId = req.user.restaurantId || req.user.id;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const [total, todayOrders, pending, confirmed, preparing, ready, served, cancelled, revenue] = await Promise.all([
    CustomerOrder.countDocuments({ ...legacyRestaurantScope(req) }),
    CustomerOrder.countDocuments({ ...legacyRestaurantScope(req), createdAt: { $gte: today } }),
    CustomerOrder.countDocuments({ ...legacyRestaurantScope(req), status: 'pending' }),
    CustomerOrder.countDocuments({ ...legacyRestaurantScope(req), status: 'confirmed' }),
    CustomerOrder.countDocuments({ ...legacyRestaurantScope(req), status: 'preparing' }),
    CustomerOrder.countDocuments({ ...legacyRestaurantScope(req), status: 'ready' }),
    CustomerOrder.countDocuments({ ...legacyRestaurantScope(req), status: 'served' }),
    CustomerOrder.countDocuments({ ...legacyRestaurantScope(req), status: 'cancelled' }),
    CustomerOrder.aggregate([
      { $match: { ...legacyRestaurantScope(req), paymentStatus: 'paid' } },
      { $group: { _id: null, total: { $sum: '$grandTotal' } } }
    ]).then(r => r[0]?.total || 0)
  ]);
  
  return success(res, {
    total,
    today: todayOrders,
    revenue,
    active: { pending, confirmed, preparing, ready },
    completed: { served, cancelled }
  }, 'Order statistics retrieved');
});

module.exports = {
  createOrder,
  getOrderByQRToken,
  getRestaurantOrders,
  getOrderDetails,
  updateOrderStatus,
  updateOrderItemKitchenStatus,
  cancelOrder,
  getOrderStatistics,
  getOrderActivityReport,
};
