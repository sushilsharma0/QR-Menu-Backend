const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const AuditLog = require('../../models/platform/AuditLog');
const FraudAlert = require('../../models/platform/FraudAlert');
const FraudLock = require('../../models/platform/FraudLock');
const SecurityIpBlock = require('../../models/platform/SecurityIpBlock');
const Restaurant = require('../../models/restaurant/Restaurant');
const RestaurantSession = require('../../models/restaurant/RestaurantSession');
const POSPayment = require('../../models/restaurant/POSPayment');
const { success, error } = require('../../utils/apiResponse');
const { clearIpBlockCache, normalizeIp } = require('../../middleware/securityIpBlocker');
const {
  getFullLoginSecurityPolicy,
  updateLoginSecurityPolicy,
} = require('../../services/loginSecurityPolicyService');

const failedActions = ['login_failed', 'branch_login_failed'];
const blockedActions = ['forbidden_action', 'validation_failed', 'request_rejected'];
const attackAlertTypes = [
  'multiple_failed_login_attempts',
  'multiple_failed_payments',
  'suspicious_discount',
  'excessive_void_bills',
  'fake_refund',
];

function actorModel(req) {
  return req.user?.role === 'super_admin' ? 'Platform' : 'Admin';
}

function sinceHours(hours) {
  return new Date(Date.now() - Number(hours || 24) * 60 * 60 * 1000);
}

function oid(value) {
  return mongoose.Types.ObjectId.isValid(String(value || '')) ? new mongoose.Types.ObjectId(String(value)) : null;
}

const getSecurityOverview = asyncHandler(async (req, res) => {
  const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours || 24)));
  const since = sinceHours(hours);
  const restaurantId = oid(req.query.restaurantId);
  const logMatch = { timestamp: { $gte: since } };
  if (restaurantId) logMatch['details.restaurantId'] = String(restaurantId);

  const fraudMatch = { createdAt: { $gte: since } };
  if (restaurantId) fraudMatch.restaurantId = restaurantId;

  const paymentMatch = { createdAt: { $gte: since }, status: 'failed' };
  if (restaurantId) paymentMatch.restaurant = restaurantId;

  const [
    failedLoginCount,
    blockedRequestCount,
    openCriticalAlerts,
    failedPaymentCount,
    activeSessionCount,
    activeIpBlocks,
    topSuspiciousIps,
    blockedByPath,
    failedLoginsByHour,
    alertsByType,
    recentAlerts,
    recentAudit,
    failedPaymentsByRestaurant,
  ] = await Promise.all([
    AuditLog.countDocuments({ ...logMatch, action: { $in: failedActions } }),
    AuditLog.countDocuments({ ...logMatch, action: { $in: blockedActions } }),
    FraudAlert.countDocuments({
      ...fraudMatch,
      status: { $in: ['open', 'investigating'] },
      severity: { $in: ['high', 'critical'] },
    }),
    POSPayment.countDocuments(paymentMatch),
    RestaurantSession.countDocuments({
      revokedAt: null,
      expiresAt: { $gt: new Date() },
      ...(restaurantId ? { restaurantId } : {}),
    }),
    SecurityIpBlock.countDocuments({
      active: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    }),
    AuditLog.aggregate([
      { $match: { ...logMatch, action: { $in: [...failedActions, ...blockedActions] }, ipAddress: { $nin: [null, ''] } } },
      { $group: { _id: '$ipAddress', count: { $sum: 1 }, lastSeen: { $max: '$timestamp' }, actions: { $addToSet: '$action' } } },
      { $sort: { count: -1, lastSeen: -1 } },
      { $limit: 10 },
    ]),
    AuditLog.aggregate([
      { $match: { ...logMatch, action: { $in: blockedActions } } },
      { $group: { _id: { $ifNull: ['$details.path', 'unknown'] }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 8 },
    ]),
    AuditLog.aggregate([
      { $match: { ...logMatch, action: { $in: failedActions } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d %H:00', date: '$timestamp' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    FraudAlert.aggregate([
      { $match: fraudMatch },
      { $group: { _id: '$type', count: { $sum: 1 }, critical: { $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] } } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
    FraudAlert.find({ ...fraudMatch, status: { $in: ['open', 'investigating'] } })
      .populate('restaurantId', 'name email isActive')
      .sort({ severity: -1, createdAt: -1 })
      .limit(12),
    AuditLog.find({ ...logMatch, action: { $in: [...failedActions, ...blockedActions] } })
      .sort({ timestamp: -1 })
      .limit(20),
    POSPayment.aggregate([
      { $match: paymentMatch },
      { $group: { _id: '$restaurant', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
      { $sort: { count: -1 } },
      { $limit: 8 },
      { $lookup: { from: 'restaurants', localField: '_id', foreignField: '_id', as: 'restaurant' } },
      { $unwind: { path: '$restaurant', preserveNullAndEmptyArrays: true } },
      { $project: { count: 1, amount: 1, restaurantName: '$restaurant.name', restaurantEmail: '$restaurant.email' } },
    ]),
  ]);

  const activeAttacks = recentAlerts
    .filter((alert) => attackAlertTypes.includes(alert.type) || ['high', 'critical'].includes(alert.severity))
    .slice(0, 8);

  return success(res, {
    windowHours: hours,
    metrics: {
      failedLoginCount,
      blockedRequestCount,
      openCriticalAlerts,
      failedPaymentCount,
      activeSessionCount,
      activeIpBlocks,
    },
    topSuspiciousIps,
    blockedByPath,
    failedLoginsByHour,
    alertsByType,
    activeAttacks,
    recentAlerts,
    recentAudit,
    failedPaymentsByRestaurant,
  }, 'Security overview retrieved');
});

const listIpBlocks = asyncHandler(async (req, res) => {
  const rows = await SecurityIpBlock.find({ active: req.query.active === 'false' ? false : true })
    .populate('restaurantId', 'name email')
    .sort({ createdAt: -1 })
    .limit(100);
  return success(res, rows, 'Blocked IPs retrieved');
});

const blockIp = asyncHandler(async (req, res) => {
  const ipAddress = normalizeIp(req.body.ipAddress);
  if (!ipAddress) return error(res, 'ipAddress is required', 400);
  const expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
  const row = await SecurityIpBlock.findOneAndUpdate(
    { ipAddress, scope: 'global' },
    {
      ipAddress,
      scope: 'global',
      reason: req.body.reason || 'Blocked by security operations',
      active: true,
      expiresAt,
      blockedBy: req.user.id,
      blockedByModel: actorModel(req),
      unblockedAt: null,
      unblockedBy: null,
      unblockedByModel: null,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  clearIpBlockCache(ipAddress);
  await AuditLog.create({
    user: req.user.id,
    userModel: actorModel(req),
    action: 'security_ip_block',
    resource: 'system',
    resourceId: row._id,
    details: { ipAddress, reason: row.reason },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
  });
  return success(res, row, 'IP blocked', 201);
});

const unblockIp = asyncHandler(async (req, res) => {
  const row = await SecurityIpBlock.findById(req.params.id);
  if (!row) return error(res, 'IP block not found', 404);
  row.active = false;
  row.unblockedAt = new Date();
  row.unblockedBy = req.user.id;
  row.unblockedByModel = actorModel(req);
  await row.save();
  clearIpBlockCache(row.ipAddress);
  await AuditLog.create({
    user: req.user.id,
    userModel: actorModel(req),
    action: 'security_ip_unblock',
    resource: 'system',
    resourceId: row._id,
    details: { ipAddress: row.ipAddress },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
  });
  return success(res, row, 'IP unblocked');
});

const listActiveLocks = asyncHandler(async (req, res) => {
  const rows = await FraudLock.find({
    active: true,
    lockedUntil: { $gt: new Date() },
  })
    .populate('restaurantId', 'name email')
    .populate('alert', 'title type severity status')
    .sort({ lockedUntil: -1 })
    .limit(100)
    .lean();

  const restaurantIds = rows
    .filter((row) => row.subjectType === 'Restaurant' && row.subjectId)
    .map((row) => row.subjectId)
    .filter((id) => mongoose.Types.ObjectId.isValid(id));

  const restaurantMap = new Map();
  if (restaurantIds.length) {
    const restaurants = await Restaurant.find({ _id: { $in: restaurantIds } }).select('name email').lean();
    restaurants.forEach((r) => restaurantMap.set(String(r._id), r));
  }

  const enriched = rows.map((row) => {
    const subjectRestaurant =
      row.subjectType === 'Restaurant' ? restaurantMap.get(String(row.subjectId)) : null;
    return {
      ...row,
      restaurantDisplay: row.restaurantId?.name
        ? { name: row.restaurantId.name, email: row.restaurantId.email }
        : subjectRestaurant
          ? { name: subjectRestaurant.name, email: subjectRestaurant.email }
          : null,
    };
  });

  return success(res, enriched, 'Active security locks retrieved');
});

const createSecurityLock = asyncHandler(async (req, res) => {
  const allowedTypes = ['ip', 'Restaurant', 'Employee', 'BranchAuth'];
  const { subjectType, subjectId, restaurantId, reason, lockMinutes = 30, blockIpAlso = false } = req.body;
  if (!allowedTypes.includes(subjectType)) return error(res, 'Invalid subjectType', 400);
  if (!subjectId) return error(res, 'subjectId is required', 400);

  const minutes = Math.min(24 * 60, Math.max(5, Number(lockMinutes) || 30));
  const lockedUntil = new Date(Date.now() + minutes * 60 * 1000);
  const row = await FraudLock.findOneAndUpdate(
    {
      subjectType,
      subjectId: String(subjectId),
      active: true,
      lockedUntil: { $gt: new Date() },
    },
    {
      $set: {
        restaurantId: oid(restaurantId),
        reason: reason || 'Locked by platform security admin',
        lockedUntil,
        active: true,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  if (subjectType === 'ip' || blockIpAlso) {
    const ipAddress = normalizeIp(subjectType === 'ip' ? subjectId : req.body.ipAddress);
    if (ipAddress) {
      await SecurityIpBlock.findOneAndUpdate(
        { ipAddress, scope: 'global' },
        {
          ipAddress,
          scope: 'global',
          reason: reason || 'Blocked with security lock',
          active: true,
          blockedBy: req.user.id,
          blockedByModel: actorModel(req),
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      clearIpBlockCache(ipAddress);
    }
  }

  await AuditLog.create({
    user: req.user.id,
    userModel: actorModel(req),
    action: 'security_manual_lock',
    resource: 'system',
    resourceId: row._id,
    details: { subjectType, subjectId: String(subjectId), lockedUntil, reason: row.reason },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
  });
  return success(res, row, 'Security lock created', 201);
});

const releaseSecurityLock = asyncHandler(async (req, res) => {
  const row = await FraudLock.findById(req.params.id);
  if (!row) return error(res, 'Security lock not found', 404);

  if (['Restaurant', 'Employee'].includes(row.subjectType) && req.user?.role !== 'super_admin') {
    return error(res, 'Only super admin can unlock restaurant or staff accounts', 403);
  }

  row.active = false;
  await row.save();
  await AuditLog.create({
    user: req.user.id,
    userModel: actorModel(req),
    action: 'security_lock_release',
    resource: 'system',
    resourceId: row._id,
    details: { subjectType: row.subjectType, subjectId: row.subjectId },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
  });
  return success(res, row, 'Security lock released');
});

const listActiveSessions = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 50,
    restaurantId,
    suspiciousOnly,
  } = req.query;

  const query = {
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  };

  const parsedRestaurantId = oid(restaurantId);
  if (parsedRestaurantId) query.restaurantId = parsedRestaurantId;

  if (suspiciousOnly === 'true') {
    query.$or = [
      { 'loginAlerts.unknownDevice': true },
      { 'loginAlerts.impossibleTravel': true },
      { 'loginAlerts.suspiciousConcurrentSessions': true },
    ];
  }

  const parsedPage = Math.max(1, parseInt(page, 10) || 1);
  const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  const skip = (parsedPage - 1) * parsedLimit;

  const [sessions, total] = await Promise.all([
    RestaurantSession.find(query)
      .populate('restaurantId', 'name email isActive')
      .sort({ lastActiveAt: -1 })
      .skip(skip)
      .limit(parsedLimit)
      .lean(),
    RestaurantSession.countDocuments(query),
  ]);

  return success(res, {
    sessions: sessions.map((session) => ({
      id: session._id,
      restaurantId: session.restaurantId?._id || session.restaurantId,
      restaurantName: session.restaurantId?.name || 'Unknown restaurant',
      restaurantEmail: session.restaurantId?.email || '',
      restaurantActive: session.restaurantId?.isActive !== false,
      deviceId: session.deviceId,
      browser: session.browser,
      operatingSystem: session.operatingSystem,
      deviceType: session.deviceType,
      timezone: session.timezone,
      screenResolution: session.screenResolution,
      ipAddress: session.ipAddress,
      loginLocation: session.loginLocation || {},
      lastActiveAt: session.lastActiveAt,
      expiresAt: session.expiresAt,
      createdAt: session.createdAt,
      alerts: session.loginAlerts || {},
      hasAlerts: Boolean(
        session.loginAlerts?.unknownDevice
        || session.loginAlerts?.impossibleTravel
        || session.loginAlerts?.suspiciousConcurrentSessions,
      ),
    })),
    pagination: {
      page: parsedPage,
      limit: parsedLimit,
      total,
      pages: Math.ceil(total / parsedLimit) || 1,
    },
  }, 'Active login sessions retrieved');
});

const revokeActiveSession = asyncHandler(async (req, res) => {
  const sessionId = oid(req.params.sessionId);
  if (!sessionId) return error(res, 'Valid session id is required', 400);

  const session = await RestaurantSession.findOne({
    _id: sessionId,
    revokedAt: null,
  });
  if (!session) return error(res, 'Active session not found', 404);

  session.revokedAt = new Date();
  session.revokedReason = req.body.reason || 'revoked_by_platform_admin';
  session.refreshTokenBlacklistedAt = new Date();
  session.tokenVersion += 1;
  await session.save();

  await AuditLog.create({
    user: req.user.id,
    userModel: actorModel(req),
    action: 'security_session_revoke',
    resource: 'restaurant',
    resourceId: session.restaurantId,
    details: {
      sessionId: String(session._id),
      restaurantId: String(session.restaurantId),
      ipAddress: session.ipAddress,
      deviceId: session.deviceId,
    },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
  });

  return success(res, { sessionId: session._id }, 'Login session revoked');
});

const forceLogoutRestaurant = asyncHandler(async (req, res) => {
  const restaurantId = oid(req.body.restaurantId);
  if (!restaurantId) return error(res, 'restaurantId is required', 400);
  const result = await RestaurantSession.updateMany(
    { restaurantId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: req.body.reason || 'forced_by_superadmin' }, $inc: { tokenVersion: 1 } },
  );
  await AuditLog.create({
    user: req.user.id,
    userModel: actorModel(req),
    action: 'security_force_logout',
    resource: 'restaurant',
    resourceId: restaurantId,
    details: { restaurantId: String(restaurantId), modifiedCount: result.modifiedCount || 0 },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
  });
  return success(res, { modifiedCount: result.modifiedCount || 0 }, 'Restaurant sessions revoked');
});

const suspendRestaurant = asyncHandler(async (req, res) => {
  const restaurantId = oid(req.params.restaurantId || req.body.restaurantId);
  if (!restaurantId) return error(res, 'restaurantId is required', 400);
  const restaurant = await Restaurant.findById(restaurantId);
  if (!restaurant) return error(res, 'Restaurant not found', 404);
  restaurant.isActive = false;
  restaurant.subscription.status = 'inactive';
  restaurant.markModified('subscription');
  await restaurant.save();
  await RestaurantSession.updateMany(
    { restaurantId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'restaurant_suspended_by_superadmin' }, $inc: { tokenVersion: 1 } },
  );
  await AuditLog.create({
    user: req.user.id,
    userModel: actorModel(req),
    action: 'security_restaurant_suspend',
    resource: 'restaurant',
    resourceId: restaurant._id,
    details: { restaurantId: String(restaurant._id), reason: req.body.reason || '' },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
  });
  return success(res, restaurant, 'Restaurant suspended');
});

const getLoginPolicy = asyncHandler(async (req, res) => {
  const policy = await getFullLoginSecurityPolicy();
  return success(res, policy, 'Vendor login policy retrieved');
});

const updateLoginPolicy = asyncHandler(async (req, res) => {
  if (req.user?.role !== 'super_admin') {
    return error(res, 'Only super admin can update vendor login policy', 403);
  }
  const policy = await updateLoginSecurityPolicy(req.body || {}, req.user.id);
  await AuditLog.create({
    user: req.user.id,
    userModel: actorModel(req),
    action: 'security_login_policy_update',
    resource: 'system',
    details: { policy },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
  });
  return success(res, policy, 'Vendor login policy updated');
});

const releaseLocksBySubject = asyncHandler(async (req, res) => {
  const allowedTypes = ['Restaurant', 'Employee', 'ip'];
  const { subjectType, subjectId } = req.body || {};
  if (!allowedTypes.includes(subjectType)) return error(res, 'Invalid subjectType', 400);
  if (!subjectId) return error(res, 'subjectId is required', 400);

  if (['Restaurant', 'Employee'].includes(subjectType) && req.user?.role !== 'super_admin') {
    return error(res, 'Only super admin can unlock restaurant or staff accounts', 403);
  }

  const normalizedId = String(subjectId).trim();
  const locks = await FraudLock.find({
    subjectType,
    subjectId: normalizedId,
    active: true,
    lockedUntil: { $gt: new Date() },
  });

  if (!locks.length) {
    return error(res, 'No active lock found for this subject', 404);
  }

  const now = new Date();
  await FraudLock.updateMany(
    { _id: { $in: locks.map((row) => row._id) } },
    { $set: { active: false } },
  );

  if (subjectType === 'ip') {
    const ipAddress = normalizeIp(normalizedId);
    if (ipAddress) {
      await SecurityIpBlock.updateMany(
        { ipAddress, active: true },
        {
          $set: {
            active: false,
            unblockedAt: now,
            unblockedBy: req.user.id,
            unblockedByModel: actorModel(req),
          },
        },
      );
      clearIpBlockCache(ipAddress);
    }
  }

  await AuditLog.create({
    user: req.user.id,
    userModel: actorModel(req),
    action: 'security_lock_release',
    resource: 'system',
    details: { subjectType, subjectId: normalizedId, releasedCount: locks.length },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
  });

  return success(
    res,
    { releasedCount: locks.length, subjectType, subjectId: normalizedId },
    subjectType === 'Restaurant' ? 'Restaurant account unlocked' : 'Security lock released',
  );
});

module.exports = {
  getSecurityOverview,
  listIpBlocks,
  blockIp,
  unblockIp,
  forceLogoutRestaurant,
  suspendRestaurant,
  listActiveLocks,
  createSecurityLock,
  releaseSecurityLock,
  releaseLocksBySubject,
  getLoginPolicy,
  updateLoginPolicy,
  listActiveSessions,
  revokeActiveSession,
};
