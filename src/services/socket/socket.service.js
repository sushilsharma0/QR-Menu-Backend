const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../../config/env');
const { jwtOptions } = require('../../utils/generateToken');
const CustomerOrder = require('../../models/restaurant/CustomerOrder');
const Table = require('../../models/restaurant/Table');

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

  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) return next();
    try {
      socket.user = jwt.verify(token, JWT_SECRET, jwtOptions);
      return next();
    } catch {
      return next(new Error('Unauthorized socket'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`🔌 New client connected: ${socket.id}`);

    socket.on('join:restaurant', (restaurantId) => {
      socket.join(`restaurant_${restaurantId}`);
      console.log(`Socket ${socket.id} joined restaurant_${restaurantId}`);
    });

    socket.on('join:employee', (employeeId) => {
      socket.join(`employee_${employeeId}`);
    });

    socket.on('join:order', async (payload) => {
      const orderId = typeof payload === 'object' ? payload?.orderId : payload;
      const orderToken = typeof payload === 'object' ? payload?.orderToken : null;
      if (!orderId) return;
      const allowedRestaurantId = socket.user?.restaurantId || socket.user?.id;
      const orderQuery = { _id: orderId };
      if (allowedRestaurantId) orderQuery.restaurant = allowedRestaurantId;
      if (socket.user?.branchId) orderQuery.branchId = socket.user.branchId;
      if (!allowedRestaurantId && orderToken) orderQuery.qrToken = orderToken;
      const order = await CustomerOrder.findOne(orderQuery).select('restaurant branchId qrToken').lean().catch(() => null);
      if (!order) return;
      const isStaff = socket.user && allowedRestaurantId && String(allowedRestaurantId) === String(order.restaurant);
      const isCustomer = orderToken && String(orderToken) === String(order.qrToken);
      if (!isStaff && !isCustomer) return;
      socket.join(`order_${orderId}`);
    });

    socket.on('join:table', async (tableId) => {
      if (!socket.user || !tableId) return;
      const allowedRestaurantId = socket.user.restaurantId || socket.user.id;
      const table = await Table.findOne({
        _id: tableId,
        restaurant: allowedRestaurantId,
        ...(socket.user.branchId ? { branchId: socket.user.branchId } : {}),
      }).select('restaurant branchId').lean().catch(() => null);
      if (!table) return;
      if (String(allowedRestaurantId) !== String(table.restaurant)) return;
      socket.join(`table_${tableId}`);
    });

    socket.on('disconnect', () => {
      console.log(`🔌 Client disconnected: ${socket.id}`);
    });
  });

  return io;
};

const getIO = () => {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
};

const emitToRestaurant = (restaurantId, event, data) => {
  if (io) {
    io.to(`restaurant_${restaurantId}`).emit(event, data);
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
  emitToRestaurant(restaurantId, 'new_order', order);
};

const emitOrderUpdate = (restaurantId, order) => {
  emitToRestaurant(restaurantId, 'order_updated', order);
  emitToOrder(order._id, 'order_status', order);
  if (order.table) emitToTable(order.table, 'order_updated', order);
};

module.exports = { 
  initSocket, 
  getIO, 
  emitToRestaurant, 
  emitToOrder, 
  emitToTable,
  emitNewOrder, 
  emitOrderUpdate 
};
