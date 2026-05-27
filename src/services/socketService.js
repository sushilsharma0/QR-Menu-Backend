const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');
const { jwtOptions } = require('../utils/generateToken');
const CustomerOrder = require('../models/restaurant/CustomerOrder');
const Table = require('../models/restaurant/Table');
const Platform = require('../models/platform/Platform');
const Restaurant = require('../models/restaurant/Restaurant');
const Employee = require('../models/restaurant/Employee');
const BranchAuth = require('../models/restaurant/BranchAuth');
const BranchSession = require('../models/restaurant/BranchSession');

let io = null;

function buildSocketCorsOrigin() {
  const configured = [process.env.CORS_ORIGIN, process.env.CLIENT_URL, process.env.ADMIN_URL]
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter((value) => value && value !== '*');
  const development = (process.env.NODE_ENV || 'development') === 'production'
    ? []
    : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5173', 'http://localhost:5174', 'http://127.0.0.1:3000', 'http://127.0.0.1:5173'];
  const allowed = new Set([...configured, ...development]);
  return (origin, callback) => {
    if (!origin || allowed.has(origin)) return callback(null, true);
    return callback(null, false);
  };
}

const initSocket = (server) => {
  io = socketIO(server, {
    cors: {
      origin: buildSocketCorsOrigin(),
      credentials: true
    },
    transports: ['websocket', 'polling']
  });

  io.use(async (socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) return next();
    try {
      const decoded = jwt.verify(token, JWT_SECRET, jwtOptions);
      const hydrated = await hydrateSocketPrincipal(decoded);
      if (!hydrated) return next(new Error('Unauthorized socket'));
      socket.user = { ...decoded, ...hydrated };
      return next();
    } catch (err) {
      return next(new Error('Unauthorized socket'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`🔌 New client connected: ${socket.id}`);

    // Join restaurant room
    socket.on('join:restaurant', (restaurantId) => {
      const allowedRestaurantId = socket.user?.restaurantId || socket.user?.id;
      if (!socket.user || String(allowedRestaurantId) !== String(restaurantId)) return;
      socket.join(`restaurant_${restaurantId}`);
      socket.join(String(restaurantId));
      console.log(`Socket ${socket.id} joined restaurant_${restaurantId}`);
    });

    socket.on('join:branch', ({ restaurantId, branchId }) => {
      const allowedRestaurantId = socket.user?.restaurantId || socket.user?.id;
      if (!socket.user || !branchId || String(allowedRestaurantId) !== String(restaurantId)) return;
      if (socket.user.scope === 'employee' && socket.user.branchId && String(socket.user.branchId) !== String(branchId)) return;
      if (socket.user.scope === 'branch_user' && String(socket.user.branchId) !== String(branchId)) return;
      socket.join(`branch_${branchId}`);
      socket.join(`${restaurantId}:${branchId}`);
    });

    // Join employee room
    socket.on('join:employee', (employeeId) => {
      if (!socket.user || String(socket.user.id) !== String(employeeId)) return;
      socket.join(`employee_${employeeId}`);
    });

    socket.on('join:platform', () => {
      const isPlatformUser =
        socket.user?.scope === 'platform' ||
        ['super_admin', 'admin', 'support'].includes(socket.user?.role);
      if (!socket.user || !isPlatformUser) return;
      socket.join('platform');
    });

    // Join user notification room
    socket.on('join:user', ({ recipientType, recipientId }) => {
      if (!recipientType || !recipientId) return;
      if (!socket.user) return;
      const isOwnEmployee =
        socket.user.scope === 'employee' &&
        recipientType === 'employee' &&
        String(socket.user.id) === String(recipientId);
      const isOwnRestaurant =
        (socket.user.role === 'restaurant' || socket.user.scope === 'branch_user') &&
        recipientType === 'restaurant' &&
        String(socket.user.restaurantId || socket.user.id) === String(recipientId);
      const isOwnPlatform =
        ['super_admin', 'admin'].includes(socket.user.role) &&
        recipientType === 'platform' &&
        String(socket.user.id) === String(recipientId);
      if (!isOwnEmployee && !isOwnRestaurant && !isOwnPlatform) return;
      socket.join(`user_${recipientType}_${recipientId}`);
    });

    // Join order room
    socket.on('join:order', async (payload) => {
      const orderId = typeof payload === 'object' ? payload?.orderId : payload;
      const orderToken = typeof payload === 'object' ? payload?.orderToken : null;
      if (!orderId) return;

      const allowedRestaurantId = socket.user?.restaurantId || socket.user?.id;
      const orderQuery = { _id: orderId };
      if (allowedRestaurantId) orderQuery.restaurant = allowedRestaurantId;
      if (socket.user?.branchId) orderQuery.branchId = socket.user.branchId;
      if (!allowedRestaurantId && orderToken) orderQuery.qrToken = orderToken;
      const order = await CustomerOrder.findOne(orderQuery)
        .select('restaurant branchId table qrToken')
        .lean()
        .catch(() => null);
      if (!order) return;

      const isStaff =
        socket.user &&
        allowedRestaurantId &&
        String(allowedRestaurantId) === String(order.restaurant) &&
        (!socket.user.branchId || !order.branchId || String(socket.user.branchId) === String(order.branchId));
      const isCustomer = orderToken && String(orderToken) === String(order.qrToken);
      if (!isStaff && !isCustomer) return;

      socket.join(`order_${orderId}`);
    });

    // Join table room
    socket.on('join:table', async (tableId) => {
      if (!socket.user || !tableId) return;
      const allowedRestaurantId = socket.user.restaurantId || socket.user.id;
      const table = await Table.findOne({
        _id: tableId,
        restaurant: allowedRestaurantId,
        ...(socket.user.branchId ? { branchId: socket.user.branchId } : {}),
      })
        .select('restaurant branchId')
        .lean()
        .catch(() => null);
      if (!table) return;
      if (String(allowedRestaurantId) !== String(table.restaurant)) return;
      if (socket.user.branchId && table.branchId && String(socket.user.branchId) !== String(table.branchId)) return;
      socket.join(`table_${tableId}`);
    });

    socket.on('disconnect', () => {
      console.log(`🔌 Client disconnected: ${socket.id}`);
    });
  });

  return io;
};

async function hydrateSocketPrincipal(decoded) {
  if (!decoded?.id) return null;

  if (decoded.scope === 'platform') {
    const admin = await Platform.findOne({ _id: decoded.id, isActive: true }).lean();
    if (!admin) return null;
    return { role: admin.role, permissions: admin.permissions || {}, name: admin.name };
  }

  if (decoded.scope === 'restaurant' || decoded.role === 'restaurant') {
    const restaurant = await Restaurant.findOne({
      _id: decoded.id,
      isActive: true,
      isDeleted: false,
    }).lean();
    if (!restaurant) return null;
    return { role: 'restaurant', scope: 'restaurant', name: restaurant.name };
  }

  if (decoded.scope === 'employee') {
    const employee = await Employee.findOne({ _id: decoded.id, isActive: true }).lean();
    if (!employee) return null;
    return {
      role: employee.role,
      restaurantId: String(employee.restaurantId || employee.restaurant),
      branchId: employee.branchId || null,
      employeeId: String(employee._id),
      name: employee.name,
    };
  }

  if (decoded.scope === 'branch_user') {
    const authRecord = await BranchAuth.findOne({ _id: decoded.id, activeStatus: true }).lean();
    if (!authRecord) return null;
    const session = decoded.sessionId
      ? await BranchSession.findOne({
          _id: decoded.sessionId,
          branchAuthId: authRecord._id,
          revokedAt: null,
          expiresAt: { $gt: new Date() },
        }).lean()
      : null;
    if (!session) return null;
    return {
      role: authRecord.role,
      restaurantId: String(authRecord.restaurantId),
      branchId: String(authRecord.branchId),
      permissions: authRecord.permissions || {},
      name: authRecord.username,
    };
  }

  return null;
}

const getIO = () => {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
};

const emitToRestaurant = (restaurantId, event, data) => {
  if (io) {
    io.to(`restaurant_${restaurantId}`).emit(event, data);
  }
};

const emitToBranch = (branchId, event, data) => {
  if (io && branchId) {
    io.to(`branch_${branchId}`).emit(event, data);
  }
};

const emitToOrder = (orderId, event, data) => {
  if (io) {
    io.to(`order_${orderId}`).emit(event, data);
  }
};

const emitToTable = (tableId, event, data) => {
  if (io) {
    io.to(`table_${tableId}`).emit(event, data);
  }
};

const emitNewOrder = (restaurantId, order) => {
  if (order?.branchId) emitToBranch(order.branchId, 'new_order', order);
  emitToRestaurant(restaurantId, 'new_order', order);
};

const emitOrderUpdate = (restaurantId, order) => {
  if (order?.branchId) {
    emitToBranch(order.branchId, 'order_updated', order);
    if (order?.status === 'ready') emitToBranch(order.branchId, 'order_ready', order);
    if (order?.status === 'cancelled') emitToBranch(order.branchId, 'order_cancelled', order);
  }
  emitToRestaurant(restaurantId, 'order_updated', order);
  if (order?.status === 'ready') emitToRestaurant(restaurantId, 'order_ready', order);
  if (order?.status === 'cancelled') emitToRestaurant(restaurantId, 'order_cancelled', order);
  emitToOrder(order._id, 'order_status', order);
  if (order.table) emitToTable(order.table, 'order_updated', order);
};

const emitPaymentUpdate = (restaurantId, payload) => {
  if (payload?.branchId) {
    emitToBranch(payload.branchId, 'payment_updated', payload);
    emitToBranch(payload.branchId, 'payment_received', payload);
  }
  emitToRestaurant(restaurantId, 'payment_updated', payload);
  emitToRestaurant(restaurantId, 'payment_received', payload);
};

const emitGuestTableRequest = (restaurantId, payload) => {
  if (payload?.branchId) {
    emitToBranch(payload.branchId, 'guest_table_request', payload);
    emitToBranch(payload.branchId, 'waiter_called', payload);
  }
  emitToRestaurant(restaurantId, 'guest_table_request', payload);
  emitToRestaurant(restaurantId, 'waiter_called', payload);
};

const emitNotification = (recipientType, recipientId, payload) => {
  if (!io || !recipientType || !recipientId) return;
  io.to(`user_${recipientType}_${recipientId}`).emit('notification:new', payload);
  io.to(`user_${recipientType}_${recipientId}`).emit('new_notification', payload);
};

const emitNotificationRead = (recipientType, recipientId, payload) => {
  if (!io || !recipientType || !recipientId) return;
  io.to(`user_${recipientType}_${recipientId}`).emit('notification:read', payload);
};

const emitNotificationAllRead = (recipientType, recipientId, payload) => {
  if (!io || !recipientType || !recipientId) return;
  io.to(`user_${recipientType}_${recipientId}`).emit('notification:all-read', payload);
};

/** POS-specific events (in addition to existing new_order / order_updated) */
const emitPosNewOrder = (restaurantId, payload) => {
  emitToRestaurant(restaurantId, 'pos:new_order', payload);
};

const emitPosPaymentSuccess = (restaurantId, payload) => {
  emitToRestaurant(restaurantId, 'pos:payment_success', payload);
};

const emitPosKitchenReady = (restaurantId, payload) => {
  emitToRestaurant(restaurantId, 'pos:kitchen_ready', payload);
};

const emitPosTableUpdated = (restaurantId, payload) => {
  if (payload?.branchId) emitToBranch(payload.branchId, 'pos:table_updated', payload);
  emitToRestaurant(restaurantId, 'pos:table_updated', payload);
};

const emitPosShiftClosed = (restaurantId, payload) => {
  emitToRestaurant(restaurantId, 'pos:shift_closed', payload);
};

const emitPosShiftOpened = (restaurantId, payload) => {
  emitToRestaurant(restaurantId, 'pos:shift_opened', payload);
};

module.exports = { 
  initSocket, 
  getIO, 
  emitToRestaurant, 
  emitToBranch,
  emitToOrder, 
  emitToTable,
  emitNewOrder, 
  emitOrderUpdate,
  emitPaymentUpdate,
  emitGuestTableRequest,
  emitNotification,
  emitNotificationRead,
  emitNotificationAllRead,
  emitPosNewOrder,
  emitPosPaymentSuccess,
  emitPosKitchenReady,
  emitPosTableUpdated,
  emitPosShiftOpened,
  emitPosShiftClosed,
};

