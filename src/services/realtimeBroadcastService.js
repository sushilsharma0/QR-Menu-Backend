const { REALTIME_TOPICS } = require('../constants/realtimeTopics');
const { emitToRestaurant, emitToBranch } = require('./socketService');
const { emitSubscriptionAccessUpdated } = require('./subscriptionRealtimeService');

let io = null;

function setSocketIO(socketIO) {
  io = socketIO;
}

function normalizeTopics(topics) {
  const list = Array.isArray(topics) ? topics : [topics];
  return list.filter(Boolean);
}

function emitPlatformDataChanged(topics, meta = {}) {
  if (!io) return;
  const normalized = normalizeTopics(topics);
  io.to('platform').emit('platform:data_changed', {
    topics: normalized,
    at: new Date().toISOString(),
    ...meta,
  });
}

async function emitRestaurantDataChanged(restaurantId, topics, meta = {}) {
  if (!restaurantId) return;
  const normalized = normalizeTopics(topics);
  const payload = {
    topics: normalized,
    at: new Date().toISOString(),
    ...meta,
  };

  emitToRestaurant(String(restaurantId), 'restaurant:data_changed', payload);

  emitPlatformDataChanged(normalized, {
    ...meta,
    restaurantId: String(restaurantId),
    source: 'restaurant',
  });

  if (normalized.includes(REALTIME_TOPICS.SUBSCRIPTION) || normalized.includes(REALTIME_TOPICS.ALL)) {
    await emitSubscriptionAccessUpdated(restaurantId).catch(() => undefined);
  }
}

function emitBranchDataChanged(branchId, topics, meta = {}) {
  if (!branchId) return;
  const normalized = normalizeTopics(topics);
  emitToBranch(String(branchId), 'branch:data_changed', {
    topics: normalized,
    at: new Date().toISOString(),
    ...meta,
  });
}

function resolveRestaurantIdFromRequest(req) {
  if (!req?.user) return null;
  if (req.user.restaurantId) return String(req.user.restaurantId);
  if (req.user.role === 'restaurant' || req.user.scope === 'restaurant') return String(req.user.id);
  return null;
}

function resolveBranchIdFromRequest(req) {
  if (!req?.user?.branchId) return null;
  return String(req.user.branchId);
}

function resolveTopicsFromPath(path = '', method = 'GET') {
  if (['GET', 'HEAD', 'OPTIONS'].includes(String(method).toUpperCase())) return [];

  const p = String(path).toLowerCase();

  if (p.includes('/menu') || p.includes('/recipes')) return [REALTIME_TOPICS.MENU];
  if (p.includes('/orders') || p.includes('/customer-orders') || p.includes('/pos') || p.includes('/cashier')) {
    return [REALTIME_TOPICS.ORDERS, REALTIME_TOPICS.DASHBOARD];
  }
  if (p.includes('/tables') || p.includes('/reservations')) return [REALTIME_TOPICS.TABLES];
  if (p.includes('/employees') || p.includes('/attendance')) return [REALTIME_TOPICS.STAFF];
  if (p.includes('/kyc')) return [REALTIME_TOPICS.KYC];
  if (p.includes('/package') || p.includes('/subscription')) return [REALTIME_TOPICS.SUBSCRIPTION];
  if (p.includes('/branches') || p.includes('/branch-auth')) return [REALTIME_TOPICS.BRANCHES];
  if (p.includes('/promotions')) return [REALTIME_TOPICS.PROMOTIONS];
  if (
    p.includes('/finance') ||
    p.includes('/billing') ||
    p.includes('/invoices') ||
    p.includes('/payroll') ||
    p.includes('/credit-customers')
  ) {
    return [REALTIME_TOPICS.FINANCE];
  }
  if (p.includes('/inventory')) return [REALTIME_TOPICS.INVENTORY];
  if (p.includes('/dashboard')) return [REALTIME_TOPICS.DASHBOARD];
  if (p.includes('/backup')) return [REALTIME_TOPICS.BACKUP];
  if (p.includes('/auth/profile') || p.includes('/settings')) return [REALTIME_TOPICS.SETTINGS];
  if (p.includes('/notifications')) return [REALTIME_TOPICS.NOTIFICATIONS];
  if (p.includes('/platform/restaurants') || p.includes('/restaurants/')) {
    return [REALTIME_TOPICS.ALL, REALTIME_TOPICS.KYC, REALTIME_TOPICS.SUBSCRIPTION];
  }
  if (p.includes('/platform/subscription') || p.includes('/subscription-payments')) {
    return [REALTIME_TOPICS.SUBSCRIPTION, REALTIME_TOPICS.FINANCE];
  }
  if (p.includes('/platform/kyc') || p.includes('/kyc/')) return [REALTIME_TOPICS.KYC];
  if (p.includes('/platform/dashboard')) return [REALTIME_TOPICS.DASHBOARD, REALTIME_TOPICS.ALL];
  if (p.includes('/platform/invoices') || p.includes('/platform/finance')) {
    return [REALTIME_TOPICS.FINANCE, REALTIME_TOPICS.ALL];
  }
  if (p.includes('/platform/tickets')) return [REALTIME_TOPICS.ALL];
  if (p.includes('/platform/cms') || p.includes('/platform/reviews')) return [REALTIME_TOPICS.ALL];
  if (p.includes('/platform/admins') || p.includes('/platform/settings')) return [REALTIME_TOPICS.SETTINGS];
  if (p.includes('/platform/subscriptions') || p.includes('/platform/plans')) {
    return [REALTIME_TOPICS.SUBSCRIPTION, REALTIME_TOPICS.ALL];
  }

  return [REALTIME_TOPICS.ALL];
}

function shouldSkipRealtimeBroadcast(path = '') {
  const p = String(path).toLowerCase();
  return (
    p.includes('/auth/login') ||
    p.includes('/auth/refresh') ||
    p.includes('/auth/logout') ||
    p.includes('/logs') ||
    p.includes('/socket')
  );
}

module.exports = {
  setSocketIO,
  REALTIME_TOPICS,
  emitRestaurantDataChanged,
  emitBranchDataChanged,
  emitPlatformDataChanged,
  resolveRestaurantIdFromRequest,
  resolveBranchIdFromRequest,
  resolveTopicsFromPath,
  shouldSkipRealtimeBroadcast,
};
