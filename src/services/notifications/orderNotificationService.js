const Employee = require('../../models/restaurant/Employee');
const notificationService = require('../notificationService');
const { emitNewOrder } = require('../socketService');

function buildOrderAlertPayload(order) {
  const tableNumber = order.table?.tableNumber || order.tableNumber || null;
  return {
    orderId: String(order._id),
    orderNumber: order.orderNumber,
    restaurantId: String(order.restaurant),
    branchId: order.branchId ? String(order.branchId) : null,
    tableNumber,
    customerGuestId: order.guestId || null,
    orderItems: (order.items || []).map((item) => ({
      name: item.name,
      quantity: item.quantity,
      price: item.price,
      subtotal: item.subtotal,
      specialInstructions: item.specialInstructions || '',
    })),
    totalAmount: order.grandTotal,
    paymentMethod: order.paymentMethod || 'unpaid',
    orderType: order.orderChannel || 'qr_ordering',
    isAdditionalBatch: Boolean(order.isAdditionalBatch),
    batchNumber: order.batchNumber || null,
    createdAt: order.createdAt,
  };
}

async function createNewOrderNotifications(order) {
  const payload = buildOrderAlertPayload(order);
  const title = payload.isAdditionalBatch ? 'Additional Items Added' : 'New Order Received';
  const message = payload.isAdditionalBatch
    ? `Table ${payload.tableNumber || '-'} - Order #${payload.orderNumber} - Batch #${payload.batchNumber || '-'} - Rs. ${payload.totalAmount}`
    : `Table ${payload.tableNumber || '-'} - Order #${payload.orderNumber} - Rs. ${payload.totalAmount}`;

  await notificationService.sendNotification({
    recipientType: 'restaurant',
    recipientId: payload.restaurantId,
    restaurant: payload.restaurantId,
    restaurantId: payload.restaurantId,
    branchId: payload.branchId,
    type: 'NEW_ORDER',
    category: 'order',
    priority: 'high',
    title,
    message,
    relatedEntity: { entityType: 'order', entityId: payload.orderId },
    relatedOrder: payload.orderId,
    actionUrl: '/notifications',
    metadata: payload,
  });

  const employees = await Employee.find({
    restaurant: payload.restaurantId,
    isActive: true,
    role: { $in: ['kitchen', 'cashier', 'waiter', 'manager'] },
  }).select('_id role');

  await Promise.all(
    employees.map((employee) =>
      notificationService.sendNotification({
        recipientType: 'employee',
        recipientId: employee._id,
        restaurant: payload.restaurantId,
        restaurantId: payload.restaurantId,
        branchId: payload.branchId,
        employee: employee._id,
        type: 'NEW_ORDER',
        category: 'order',
        priority: employee.role === 'kitchen' ? 'urgent' : 'high',
        title,
        message,
        relatedEntity: { entityType: 'order', entityId: payload.orderId },
        relatedOrder: payload.orderId,
        actionUrl: '/notifications',
        metadata: payload,
      }),
    ),
  );

  emitNewOrder(payload.restaurantId, payload);
  return payload;
}

module.exports = {
  buildOrderAlertPayload,
  createNewOrderNotifications,
};
