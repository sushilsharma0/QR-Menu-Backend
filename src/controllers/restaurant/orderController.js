const asyncHandler = require('express-async-handler');
const Order = require('../../models/restaurant/Order');
const MenuItem = require('../../models/restaurant/MenuItem');
const { branchMenuItemBaseFilter } = require('../../services/branchService');
const { resolveTableFromQrToken } = require('../../services/qrService');
const { emitNewOrder, emitOrderUpdate } = require('../../services/socketService');
const { success, error } = require('../../utils/apiResponse');
const { writeAuditLog } = require('../../utils/auditLog');
const { legacyRestaurantScope } = require('../../utils/tenantScope');

/**
 * @desc    Place order via QR (public)
 * @route   POST /api/restaurant/orders/place
 * @access  Public
 */
const placeOrder = asyncHandler(async (req, res) => {
  const { qrToken, items, note } = req.body;
  
  if (!qrToken || !items || items.length === 0) {
    return error(res, 'QR token and items are required', 400);
  }
  
  const table = await resolveTableFromQrToken(qrToken);
  if (!table) {
    return error(res, 'Invalid QR code', 400);
  }

  const menuBranch = await branchMenuItemBaseFilter(table);

  let totalAmount = 0;
  const orderItems = [];

  for (const item of items) {
    const menuItem = await MenuItem.findOne({
      _id: item.menuItem,
      restaurant: menuBranch.restaurant,
      branchId: menuBranch.branchId,
      isDeleted: false,
    });
    
    if (!menuItem) {
      return error(res, `Menu item not found: ${item.menuItem}`, 404);
    }
    
    if (!menuItem.isAvailable) {
      return error(res, `${menuItem.name} is currently unavailable`, 400);
    }
    
    const subtotal = menuItem.price * item.quantity;
    totalAmount += subtotal;
    
    orderItems.push({
      menuItem: menuItem._id,
      name: menuItem.name,
      quantity: item.quantity,
      price: menuItem.price,
      note: item.note
    });
  }
  
  const order = await Order.create({
    restaurant: table.restaurant,
    restaurantId: table.restaurant,
    branchId: table.branchId,
    table: table._id,
    items: orderItems,
    totalAmount,
    note,
    status: 'pending'
  });
  
  await order.populate('table', 'tableNumber');
  
  // Emit real-time notification
  emitNewOrder(table.restaurant.toString(), order);
  
  return success(res, order, 'Order placed', 201);
});

/**
 * @desc    Update order status
 * @route   PATCH /api/restaurant/orders/:id/status
 * @access  Private (Kitchen/Restaurant)
 */
const updateOrderStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const restaurantId = req.user.restaurantId || req.user.id;
  
  const validStatuses = ['pending', 'preparing', 'ready', 'served', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return error(res, 'Invalid order status', 400);
  }
  
  const existingOrder = await Order.findOne({ _id: req.params.id, ...legacyRestaurantScope(req) });
  if (!existingOrder) {
    return error(res, 'Order not found', 404);
  }

  const previousStatus = existingOrder.status;
  existingOrder.status = status;
  existingOrder.handledBy = req.user.employeeId || req.user.id;
  await existingOrder.save();

  const order = await existingOrder.populate('table', 'tableNumber');
  
  await writeAuditLog(req, {
    action: 'order_status_update',
    resource: 'order',
    resourceId: order._id,
    details: {
      restaurantId: String(restaurantId),
      orderNumber: order.orderNumber,
      previousStatus,
      status,
      message: `Order ${order.orderNumber || order._id} moved from ${previousStatus} to ${status}`,
    },
  });
  
  // Emit real-time update
  emitOrderUpdate(restaurantId.toString(), order);
  
  return success(res, order, 'Order status updated');
});

/**
 * @desc    Get all orders for restaurant
 * @route   GET /api/restaurant/orders
 * @access  Private
 */
const getRestaurantOrders = asyncHandler(async (req, res) => {
  const restaurantId = req.user.restaurantId || req.user.id;
  const { status, page = 1, limit = 20 } = req.query;
  
  const query = legacyRestaurantScope(req);
  if (status) query.status = status;
  
  const skip = (page - 1) * limit;
  
  const orders = await Order.find(query)
    .populate('table', 'tableNumber')
    .populate('handledBy', 'name')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(parseInt(limit));
  
  const total = await Order.countDocuments(query);
  
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
 * @desc    Get single order
 * @route   GET /api/restaurant/orders/:id
 * @access  Private
 */
const getOrderDetails = asyncHandler(async (req, res) => {
  const restaurantId = req.user.restaurantId || req.user.id;
  
  const order = await Order.findOne({
    _id: req.params.id,
    ...legacyRestaurantScope(req)
  }).populate('table', 'tableNumber').populate('items.menuItem', 'name price image');
  
  if (!order) {
    return error(res, 'Order not found', 404);
  }
  
  return success(res, order, 'Order retrieved');
});

/**
 * @desc    Cancel order
 * @route   PATCH /api/restaurant/orders/:id/cancel
 * @access  Private
 */
const cancelOrder = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const restaurantId = req.user.restaurantId || req.user.id;
  
  const order = await Order.findOne({
    _id: req.params.id,
    ...legacyRestaurantScope(req),
    status: { $nin: ['served', 'cancelled'] }
  });
  
  if (!order) {
    return error(res, 'Order not found or cannot be cancelled', 404);
  }
  
  order.status = 'cancelled';
  order.note = reason || order.note;
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
      message: `Order ${order.orderNumber || order._id} was cancelled`,
    },
  });
  
  // Emit real-time update
  emitOrderUpdate(restaurantId.toString(), order);
  
  return success(res, { id: order._id, status: 'cancelled' }, 'Order cancelled');
});

/**
 * @desc    Get order statistics
 * @route   GET /api/restaurant/orders/stats
 * @access  Private
 */
const getOrderStatistics = asyncHandler(async (req, res) => {
  const restaurantId = req.user.restaurantId || req.user.id;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const [total, todayOrders, pending, preparing, ready, served, cancelled] = await Promise.all([
    Order.countDocuments({ ...legacyRestaurantScope(req) }),
    Order.countDocuments({ ...legacyRestaurantScope(req), createdAt: { $gte: today } }),
    Order.countDocuments({ ...legacyRestaurantScope(req), status: 'pending' }),
    Order.countDocuments({ ...legacyRestaurantScope(req), status: 'preparing' }),
    Order.countDocuments({ ...legacyRestaurantScope(req), status: 'ready' }),
    Order.countDocuments({ ...legacyRestaurantScope(req), status: 'served' }),
    Order.countDocuments({ ...legacyRestaurantScope(req), status: 'cancelled' })
  ]);
  
  return success(res, {
    total,
    today: todayOrders,
    active: { pending, preparing, ready },
    completed: { served, cancelled }
  }, 'Order statistics retrieved');
});

module.exports = {
  placeOrder,
  updateOrderStatus,
  getRestaurantOrders,
  getOrderDetails,
  cancelOrder,
  getOrderStatistics
};
