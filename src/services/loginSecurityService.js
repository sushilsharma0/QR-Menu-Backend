const FraudLock = require('../models/platform/FraudLock');
const AuditLog = require('../models/platform/AuditLog');
const { getLoginSecurityPolicy } = require('./loginSecurityPolicyService');

const normalizeEmail = (value) => String(value || '').toLowerCase().trim();

const getClientIp = (req) =>
  String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || '')
    .split(',')[0]
    .trim();

const activeLockQuery = (subjectType, subjectId) => ({
  subjectType,
  subjectId: String(subjectId || ''),
  active: true,
  lockedUntil: { $gt: new Date() },
});

async function findActiveLoginLock({ restaurantId, employeeId, ip } = {}) {
  const or = [];
  if (ip) or.push(activeLockQuery('ip', ip));
  if (restaurantId) or.push(activeLockQuery('Restaurant', restaurantId));
  if (employeeId) or.push(activeLockQuery('Employee', employeeId));
  if (!or.length) return null;
  return FraudLock.findOne({ $or: or }).sort({ lockedUntil: -1 }).lean();
}

async function countRecentFailedLogins({ action, restaurantId, email, ip, minutes }) {
  const windowStart = new Date(Date.now() - minutes * 60 * 1000);
  const clauses = [];
  if (ip) clauses.push({ ipAddress: ip });
  const normalized = normalizeEmail(email);
  if (normalized) clauses.push({ 'details.email': normalized });
  if (restaurantId) clauses.push({ 'details.restaurantId': String(restaurantId) });
  if (!clauses.length) return 0;

  return AuditLog.countDocuments({
    action,
    timestamp: { $gte: windowStart },
    $or: clauses,
  });
}

async function applyLoginSecurityLocks({
  restaurantId,
  employeeId,
  ip,
  reason,
  lockMinutes,
  alertId = null,
} = {}) {
  const lockedUntil = new Date(Date.now() + lockMinutes * 60 * 1000);
  const updates = [];

  if (restaurantId) {
    updates.push(
      FraudLock.findOneAndUpdate(
        activeLockQuery('Restaurant', restaurantId),
        {
          $set: {
            restaurantId,
            reason: reason || 'Too many failed login attempts',
            alert: alertId,
            lockedUntil,
            active: true,
          },
        },
        { upsert: true, new: true },
      ),
    );
  }

  if (employeeId) {
    updates.push(
      FraudLock.findOneAndUpdate(
        activeLockQuery('Employee', employeeId),
        {
          $set: {
            restaurantId: restaurantId || undefined,
            reason: reason || 'Too many failed login attempts',
            alert: alertId,
            lockedUntil,
            active: true,
          },
        },
        { upsert: true, new: true },
      ),
    );
  }

  if (ip) {
    updates.push(
      FraudLock.findOneAndUpdate(
        activeLockQuery('ip', ip),
        {
          $set: {
            restaurantId: restaurantId || undefined,
            reason: reason || 'Too many failed login attempts from this IP',
            alert: alertId,
            lockedUntil,
            active: true,
          },
        },
        { upsert: true, new: true },
      ),
    );
  }

  return Promise.all(updates);
}

function buildAttemptMeta(failedAttempts, maxFailures) {
  const remaining = Math.max(0, maxFailures - failedAttempts);
  return {
    failedAttempts,
    maxAttempts: maxFailures,
    attemptsRemaining: remaining,
  };
}

/**
 * After a failed restaurant owner login — may lock account when threshold reached.
 */
async function afterRestaurantLoginFailed(req, restaurant, email) {
  const policy = await getLoginSecurityPolicy('restaurant');
  const ip = getClientIp(req);
  const normalized = normalizeEmail(email);
  const restaurantId = restaurant?._id;

  const count = await countRecentFailedLogins({
    action: 'login_failed',
    restaurantId,
    email: normalized,
    ip,
    minutes: policy.windowMinutes,
  });

  const meta = buildAttemptMeta(count, policy.maxFailures);

  if (count < policy.maxFailures) {
    return { locked: false, ...meta };
  }

  const reason = `Account locked after ${count} failed login attempts in ${policy.windowMinutes} minutes. Contact platform administration to unlock.`;
  await applyLoginSecurityLocks({
    restaurantId,
    ip: null,
    reason,
    lockMinutes: policy.lockMinutes,
  });

  const lock = await findActiveLoginLock({ restaurantId });
  return {
    locked: true,
    lockedUntil: lock?.lockedUntil,
    reason: lock?.reason || reason,
    ...meta,
    attemptsRemaining: 0,
  };
}

/**
 * After a failed employee login.
 */
async function afterEmployeeLoginFailed(req, employee, restaurantId, username) {
  const policy = await getLoginSecurityPolicy('employee');
  const ip = getClientIp(req);
  const count = await countRecentFailedLogins({
    action: 'login_failed',
    restaurantId,
    email: username,
    ip,
    minutes: policy.windowMinutes,
  });

  const meta = buildAttemptMeta(count, policy.maxFailures);

  if (count < policy.maxFailures) {
    return { locked: false, ...meta };
  }

  const reason = `Staff login locked after ${count} failed attempts in ${policy.windowMinutes} minutes. Contact platform administration.`;
  await applyLoginSecurityLocks({
    restaurantId,
    employeeId: employee?._id,
    ip: null,
    reason,
    lockMinutes: policy.lockMinutes,
  });

  const lock = await findActiveLoginLock({ restaurantId, employeeId: employee?._id });
  return {
    locked: true,
    lockedUntil: lock?.lockedUntil,
    reason: lock?.reason || reason,
    ...meta,
    attemptsRemaining: 0,
  };
}

function lockedResponsePayload(lock, extra = {}) {
  return {
    code: 'ACCOUNT_LOCKED',
    lockedUntil: lock?.lockedUntil,
    reason: lock?.reason,
    ...extra,
  };
}

module.exports = {
  normalizeEmail,
  getClientIp,
  findActiveLoginLock,
  countRecentFailedLogins,
  applyLoginSecurityLocks,
  afterRestaurantLoginFailed,
  afterEmployeeLoginFailed,
  lockedResponsePayload,
  buildAttemptMeta,
};
