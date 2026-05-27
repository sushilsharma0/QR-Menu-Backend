const PlatformSecuritySettings = require('../models/platform/PlatformSecuritySettings');

let cachedPolicy = null;
let cacheExpiresAt = 0;
const CACHE_MS = 30 * 1000;

const envFallback = () => ({
  restaurant: {
    maxFailures: Number(process.env.RESTAURANT_LOGIN_MAX_FAILURES || 5),
    windowMinutes: Number(process.env.RESTAURANT_LOGIN_FAILURE_WINDOW_MINUTES || 15),
    lockMinutes: Number(process.env.RESTAURANT_LOGIN_LOCK_MINUTES || 30),
  },
  employee: {
    maxFailures: Number(process.env.RESTAURANT_LOGIN_MAX_FAILURES || 5),
    windowMinutes: Number(process.env.RESTAURANT_LOGIN_FAILURE_WINDOW_MINUTES || 15),
    lockMinutes: Number(process.env.RESTAURANT_LOGIN_LOCK_MINUTES || 30),
  },
});

function clamp(n, min, max, fallback) {
  const value = Number(n);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

async function loadPolicyFromDb() {
  const row = await PlatformSecuritySettings.getSingleton();
  const fallback = envFallback();
  return {
    restaurant: {
      maxFailures: clamp(row.restaurantLoginMaxFailures, 3, 20, fallback.restaurant.maxFailures),
      windowMinutes: clamp(row.restaurantLoginFailureWindowMinutes, 5, 120, fallback.restaurant.windowMinutes),
      lockMinutes: clamp(row.restaurantLoginLockMinutes, 5, 24 * 60, fallback.restaurant.lockMinutes),
    },
    employee: {
      maxFailures: clamp(row.employeeLoginMaxFailures, 3, 20, fallback.employee.maxFailures),
      windowMinutes: clamp(row.employeeLoginFailureWindowMinutes, 5, 120, fallback.employee.windowMinutes),
      lockMinutes: clamp(row.employeeLoginLockMinutes, 5, 24 * 60, fallback.employee.lockMinutes),
    },
    updatedAt: row.updatedAt,
  };
}

async function getLoginSecurityPolicy(scope = 'restaurant') {
  const now = Date.now();
  if (!cachedPolicy || cacheExpiresAt < now) {
    cachedPolicy = await loadPolicyFromDb();
    cacheExpiresAt = now + CACHE_MS;
  }
  return scope === 'employee' ? cachedPolicy.employee : cachedPolicy.restaurant;
}

async function getFullLoginSecurityPolicy() {
  const now = Date.now();
  if (!cachedPolicy || cacheExpiresAt < now) {
    cachedPolicy = await loadPolicyFromDb();
    cacheExpiresAt = now + CACHE_MS;
  }
  return cachedPolicy;
}

function invalidateLoginSecurityPolicyCache() {
  cachedPolicy = null;
  cacheExpiresAt = 0;
}

async function updateLoginSecurityPolicy(updates = {}, actorId) {
  const row = await PlatformSecuritySettings.getSingleton();
  const fields = [
    'restaurantLoginMaxFailures',
    'restaurantLoginFailureWindowMinutes',
    'restaurantLoginLockMinutes',
    'employeeLoginMaxFailures',
    'employeeLoginFailureWindowMinutes',
    'employeeLoginLockMinutes',
  ];
  fields.forEach((key) => {
    if (updates[key] !== undefined && updates[key] !== null && updates[key] !== '') {
      row[key] = Number(updates[key]);
    }
  });
  await row.save();
  invalidateLoginSecurityPolicyCache();
  return getFullLoginSecurityPolicy();
}

module.exports = {
  getLoginSecurityPolicy,
  getFullLoginSecurityPolicy,
  updateLoginSecurityPolicy,
  invalidateLoginSecurityPolicyCache,
};
