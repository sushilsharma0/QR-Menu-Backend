const crypto = require('crypto');
const asyncHandler = require('express-async-handler');
const Branch = require('../../models/restaurant/Branch');
const BranchAuth = require('../../models/restaurant/BranchAuth');
const BranchSession = require('../../models/restaurant/BranchSession');
const Restaurant = require('../../models/restaurant/Restaurant');
const AuditLog = require('../../models/platform/AuditLog');
const { success, error } = require('../../utils/apiResponse');
const validatePassword = require('../../utils/validatePassword');
const {
  verifyPassword,
  issueBranchToken,
  hashPassword,
} = require('../../services/branchAuthService');
const { mergeEnabledModules } = require('../../constants/branchModules');
const { normalizeObjectId, ensureBranchPortalKey } = require('../../services/branchService');
const { resolveRestaurantFromClientInput } = require('../../services/restaurantPublicIdService');
const { resolveEffectiveFeatureFlags } = require('../../services/subscriptionAccessService');

function safePortalKeyEquals(expected, provided) {
  const e = String(expected || '').toLowerCase();
  const p = String(provided || '').toLowerCase();
  if (!e || !p || e.length !== p.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(e, 'utf8'), Buffer.from(p, 'utf8'));
  } catch {
    return false;
  }
}

async function publicUserFromPayload(payload, branch, restaurant, branchAuth) {
  const planFeatureFlags = await resolveEffectiveFeatureFlags(restaurant);
  return {
    id: payload.id,
    userId: payload.userId || payload.id,
    scope: 'branch_user',
    role: payload.role,
    name: branchAuth.username,
    username: branchAuth.username,
    branchEmail: branchAuth.branchEmail || null,
    restaurantId: payload.restaurantId,
    branchId: payload.branchId,
    branchSlug: payload.branchSlug,
    branchPortalKey: payload.branchPortalKey || '',
    restaurantSlug: payload.restaurantSlug,
    permissions: payload.permissions || {},
    branchName: branch.name,
    publicBranchId: branch.publicBranchId,
    branchCode: branch.branchCode,
    enabledModules: mergeEnabledModules(branch.enabledModules),
    logo: branch.logo || restaurant.logo || '',
    needsPlanUpgrade: !restaurant.canUseRestaurantFeatures(),
    isKYCVerified: restaurant.isKYCVerified,
    planFeatureFlags,
    currency: restaurant.settings?.currency || branch.settings?.currency || 'Rs.',
    publicRestaurantId: restaurant.publicRestaurantId || null,
    branchOwnerEmail: branch.ownerEmail || null,
  };
}

async function writeBranchLoginFailureAudit(partial) {
  await AuditLog.create({
    ...partial,
    ipAddress: partial.ipAddress,
    userAgent: partial.userAgent,
  }).catch(() => {});
}

const branchEmailLogin = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const branchEmail = String(body.branchEmail || body.identifier || body.username || '')
    .trim()
    .toLowerCase();
  const { password, restaurantId: ridRaw } = body;

  if (!branchEmail || !branchEmail.includes('@branch.com')) {
    return error(
      res,
      'Branch login requires a branch username ending with @branch.com, your Restaurant ID, and password.',
      400,
      { code: 'BRANCH_EMAIL_REQUIRED' },
    );
  }
  if (!password) {
    return error(res, 'Password is required', 400);
  }
  if (!ridRaw || !String(ridRaw).trim()) {
    return error(res, 'Restaurant ID is required for branch login', 400, { code: 'RESTAURANT_ID_REQUIRED' });
  }

  const restaurant = await resolveRestaurantFromClientInput(ridRaw);
  if (!restaurant) {
    return error(res, 'Invalid restaurant ID', 400, { code: 'INVALID_RESTAURANT_ID' });
  }

  if (!restaurant.canUseRestaurantFeatures()) {
    return error(res, 'Subscription expired or inactive for this restaurant', 403, { code: 'TRIAL_OR_PLAN_EXPIRED' });
  }

  const authRecord = await BranchAuth.findOne({ branchEmail, restaurantId: restaurant._id }).select('+passwordHash');
  if (!authRecord) {
    await writeBranchLoginFailureAudit({
      user: restaurant._id,
      userModel: 'Restaurant',
      action: 'branch_login_failed',
      resource: 'branch_auth',
      details: { reason: 'unknown_branch_email', branchEmail },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });
    return error(res, 'Invalid credentials', 401, { code: 'BRANCH_AUTH_FAILED' });
  }

  if (String(authRecord.restaurantId) !== String(restaurant._id)) {
    await writeBranchLoginFailureAudit({
      user: authRecord._id,
      userModel: 'BranchAuth',
      action: 'branch_login_failed',
      resource: 'branch_auth',
      resourceId: authRecord._id,
      details: { reason: 'restaurant_mismatch', branchEmail },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });
    return error(res, 'Restaurant ID does not match this branch login', 400, { code: 'RESTAURANT_BRANCH_MISMATCH' });
  }

  if (!authRecord.activeStatus) {
    return error(res, 'Branch login is disabled for this account', 403, { code: 'BRANCH_LOGIN_DISABLED' });
  }

  const branch = await Branch.findOne({ _id: authRecord.branchId, restaurantId: restaurant._id, isDeleted: false });
  if (!branch) {
    return error(res, 'Invalid credentials', 401, { code: 'BRANCH_AUTH_FAILED' });
  }

  if (!verifyPassword(password, authRecord.passwordHash)) {
    await writeBranchLoginFailureAudit({
      user: authRecord._id,
      userModel: 'BranchAuth',
      action: 'branch_login_failed',
      resource: 'branch_auth',
      resourceId: authRecord._id,
      details: { branchId: String(branch._id), reason: 'bad_password' },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });
    return error(res, 'Invalid credentials', 401, { code: 'BRANCH_AUTH_FAILED' });
  }

  if (branch.status !== 'active') {
    const msg = branch.status === 'suspended' ? 'Branch is suspended' : `Branch is ${branch.status}`;
    return error(res, msg, 403, { code: 'BRANCH_INACTIVE' });
  }

  authRecord.lastLogin = new Date();
  await authRecord.save();

  const expectedKey = await ensureBranchPortalKey(restaurant._id);
  const { token, payload } = await issueBranchToken(
    authRecord,
    branch,
    restaurant,
    {
      userAgent: req.get('User-Agent'),
      ip: req.ip,
    },
    expectedKey,
  );

  await AuditLog.create({
    user: authRecord._id,
    userModel: 'BranchAuth',
    action: 'branch_login',
    resource: 'branch_auth',
    resourceId: authRecord._id,
    details: { branchId: String(branch._id), sessionId: payload.sessionId, method: 'branch_email' },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
  }).catch(() => {});

  const user = await publicUserFromPayload(payload, branch, restaurant, authRecord);
  return success(res, { token, user }, 'Branch login successful');
});

const portalLogin = asyncHandler(async (req, res) => {
  const {
    restaurantId: ridRaw,
    portalKey,
    branchSlug,
    username,
    password,
  } = req.body || {};
  if (!ridRaw || !portalKey || !branchSlug || !username || !password) {
    return error(res, 'restaurantId, portalKey, branchSlug, username, and password are required', 400);
  }

  const restaurant = await resolveRestaurantFromClientInput(ridRaw);
  if (!restaurant) {
    return error(res, 'Invalid restaurant id', 400, { code: 'INVALID_RESTAURANT_ID' });
  }

  const expectedKey = await ensureBranchPortalKey(restaurant._id);
  if (!expectedKey || !safePortalKeyEquals(expectedKey, portalKey)) {
    return error(res, 'Invalid credentials', 401, { code: 'BRANCH_AUTH_FAILED' });
  }

  const branch = await Branch.findOne({
    slug: String(branchSlug).toLowerCase().trim(),
    restaurantId: restaurant._id,
    isDeleted: false,
  });
  if (!branch) {
    return error(res, 'Invalid credentials', 401, { code: 'BRANCH_AUTH_FAILED' });
  }

  if (!restaurant.canUseRestaurantFeatures()) {
    return error(res, 'Subscription inactive for this restaurant', 403, { code: 'TRIAL_OR_PLAN_EXPIRED' });
  }

  const uRaw = String(username).toLowerCase().trim();
  const baseQuery = { restaurantId: branch.restaurantId, branchId: branch._id };
  let authRecord = await BranchAuth.findOne({
    ...baseQuery,
    username: uRaw,
  }).select('+passwordHash');
  if (!authRecord && uRaw.includes('@branch.com')) {
    authRecord = await BranchAuth.findOne({
      ...baseQuery,
      branchEmail: uRaw,
    }).select('+passwordHash');
  }

  if (!authRecord) {
    await writeBranchLoginFailureAudit({
      user: restaurant._id,
      userModel: 'Restaurant',
      action: 'branch_login_failed',
      resource: 'branch_auth',
      resourceId: null,
      details: { branchId: String(branch._id), username: String(username).toLowerCase() },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });
    return error(res, 'Invalid credentials', 401, { code: 'BRANCH_AUTH_FAILED' });
  }

  if (!authRecord.activeStatus) {
    await writeBranchLoginFailureAudit({
      user: restaurant._id,
      userModel: 'Restaurant',
      action: 'branch_login_failed',
      resource: 'branch_auth',
      resourceId: authRecord._id,
      details: { branchId: String(branch._id), username: String(username).toLowerCase() },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });
    return error(res, 'Invalid credentials', 401, { code: 'BRANCH_AUTH_FAILED' });
  }

  if (!verifyPassword(password, authRecord.passwordHash)) {
    await writeBranchLoginFailureAudit({
      user: authRecord._id,
      userModel: 'BranchAuth',
      action: 'branch_login_failed',
      resource: 'branch_auth',
      resourceId: authRecord._id,
      details: { branchId: String(branch._id), reason: 'bad_password' },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });
    return error(res, 'Invalid credentials', 401, { code: 'BRANCH_AUTH_FAILED' });
  }

  if (branch.status !== 'active') {
    return error(res, `Branch is ${branch.status}`, 403, { code: 'BRANCH_INACTIVE' });
  }

  authRecord.lastLogin = new Date();
  await authRecord.save();

  const { token, payload } = await issueBranchToken(
    authRecord,
    branch,
    restaurant,
    {
      userAgent: req.get('User-Agent'),
      ip: req.ip,
    },
    expectedKey,
  );

  await AuditLog.create({
    user: authRecord._id,
    userModel: 'BranchAuth',
    action: 'branch_login',
    resource: 'branch_auth',
    resourceId: authRecord._id,
    details: { branchId: String(branch._id), sessionId: payload.sessionId, method: 'portal_link' },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
  }).catch(() => {});

  const user = await publicUserFromPayload(payload, branch, restaurant, authRecord);
  return success(res, { token, user }, 'Branch login successful');
});

const login = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const hint = String(body.branchEmail || body.identifier || body.username || '').trim().toLowerCase();
  if (hint.includes('@branch.com')) {
    return branchEmailLogin(req, res);
  }
  return portalLogin(req, res);
});

const me = asyncHandler(async (req, res) => {
  if (req.user?.scope !== 'branch_user') {
    return error(res, 'Not a branch session', 400);
  }
  const branch = await Branch.findOne({
    _id: req.user.branchId,
    restaurantId: req.user.restaurantId,
    isDeleted: false,
  });
  if (!branch) return error(res, 'Branch not found', 404);
  const restaurant = await Restaurant.findOne({ _id: req.user.restaurantId, isActive: true, isDeleted: false });
  if (!restaurant) return error(res, 'Restaurant not found', 404);
  const authRecord = await BranchAuth.findOne({
    _id: req.user.id,
    restaurantId: req.user.restaurantId,
    branchId: req.user.branchId,
    activeStatus: true,
  });
  if (!authRecord) return error(res, 'Branch user not found', 404);

  const branchPortalKey = await ensureBranchPortalKey(branch.restaurantId);
  const payload = {
    id: String(authRecord._id),
    userId: String(authRecord._id),
    scope: 'branch_user',
    role: authRecord.role,
    restaurantId: String(branch.restaurantId),
    branchId: String(branch._id),
    branchSlug: branch.slug,
    branchPortalKey: branchPortalKey || '',
    restaurantSlug: restaurant.slug,
    permissions: authRecord.permissions || {},
    sessionId: req.user.sessionId,
    name: authRecord.username,
  };
  const user = await publicUserFromPayload(payload, branch, restaurant, authRecord);
  return success(res, { user }, 'OK');
});

const changePassword = asyncHandler(async (req, res) => {
  if (req.user?.scope !== 'branch_user') return error(res, 'Forbidden', 403);
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return error(res, 'Current and new password required', 400);
  const passwordValidation = validatePassword(newPassword);
  if (!passwordValidation.valid) return error(res, passwordValidation.message, 400);
  const authRecord = await BranchAuth.findOne({
    _id: req.user.id,
    restaurantId: req.user.restaurantId,
    branchId: req.user.branchId,
    activeStatus: true,
  }).select('+passwordHash');
  if (!authRecord) return error(res, 'Not found', 404);
  if (!verifyPassword(currentPassword, authRecord.passwordHash)) {
    return error(res, 'Current password is incorrect', 400);
  }
  authRecord.passwordHash = hashPassword(newPassword);
  await authRecord.save();
  await BranchSession.updateMany(
    { branchAuthId: authRecord._id, restaurantId: req.user.restaurantId, branchId: req.user.branchId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'password_changed' } },
  );
  await AuditLog.create({
    user: authRecord._id,
    userModel: 'BranchAuth',
    action: 'branch_password_change_self',
    resource: 'branch_auth',
    resourceId: authRecord._id,
    details: { branchId: String(authRecord.branchId) },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
  }).catch(() => {});
  return success(res, null, 'Password updated. Please sign in again.');
});

const logout = asyncHandler(async (req, res) => {
  if (req.user?.scope !== 'branch_user' || !req.user.sessionId) {
    return success(res, null, 'Logged out');
  }
  await BranchSession.updateOne(
    { _id: req.user.sessionId, restaurantId: req.user.restaurantId, branchId: req.user.branchId, branchAuthId: req.user.id, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'logout' } },
  );
  return success(res, null, 'Logged out');
});

const listMySessions = asyncHandler(async (req, res) => {
  if (req.user?.scope !== 'branch_user') {
    return error(res, 'Branch session required', 403);
  }
  const branchAuthId = normalizeObjectId(req.user.id);
  const items = await BranchSession.find({
    branchAuthId,
    restaurantId: req.user.restaurantId,
    branchId: req.user.branchId,
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .select('userAgent ipAddress deviceLabel lastActivityAt expiresAt revokedAt createdAt')
    .lean();

  return success(res, { items }, 'Sessions');
});

module.exports = { login, branchEmailLogin, portalLogin, me, changePassword, logout, listMySessions };
