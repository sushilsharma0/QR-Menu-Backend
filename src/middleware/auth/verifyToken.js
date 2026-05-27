const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../../config/env');
const { error, unauthorized } = require('../../utils/apiResponse');
const { jwtOptions } = require('../../utils/generateToken');
const Platform = require('../../models/platform/Platform');
const Restaurant = require('../../models/restaurant/Restaurant');
const Employee = require('../../models/restaurant/Employee');
const BranchAuth = require('../../models/restaurant/BranchAuth');
const BranchSession = require('../../models/restaurant/BranchSession');
const FraudLock = require('../../models/platform/FraudLock');
const { validateRestaurantSession } = require('../../services/restaurantSessionService');
const { buildPasswordChangeRecommendation } = require('../../services/restaurantPasswordPolicyService');

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return unauthorized(res, 'No token provided');
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET, jwtOptions);
    const hydrated = await hydratePrincipal(decoded, req);
    if (!hydrated) {
      return unauthorized(res, 'Account disabled or token invalid');
    }
    if (hydrated.sessionInvalid) {
      return unauthorized(res, 'Session expired or revoked');
    }
    Object.assign(decoded, hydrated.claims);
    const lock = await findActiveFraudLock(decoded, req);
    if (lock) {
      return res.status(423).json({
        success: false,
        message: 'Account temporarily locked due to suspicious activity',
        lockedUntil: lock.lockedUntil,
        reason: lock.reason,
      });
    }
    if (shouldBlockRestaurantForPasswordChange(hydrated.claims, req)) {
      return error(res, 'You must change your restaurant password before continuing.', 403, {
        code: 'MUST_CHANGE_RESTAURANT_PASSWORD',
        passwordChangeRecommendation: hydrated.claims.passwordChangeRecommendation,
      });
    }
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError') {
      return unauthorized(res, 'Invalid token');
    }
    if (err.name === 'TokenExpiredError') {
      return unauthorized(res, 'Token expired');
    }
    return error(res, 'Authentication failed', 401);
  }
};

async function hydratePrincipal(decoded, req) {
  if (!decoded?.id) return null;

  if (decoded.scope === 'platform') {
    const admin = await Platform.findOne({ _id: decoded.id, isActive: true }).lean();
    if (!admin) return null;
    return {
      claims: {
        role: admin.role,
        permissions: admin.permissions || {},
        email: admin.email,
        name: admin.name,
      },
    };
  }

  if (decoded.scope === 'restaurant' || decoded.role === 'restaurant') {
    const restaurant = await Restaurant.findOne({
      _id: decoded.id,
      isActive: true,
      isDeleted: false,
    }).lean();
    if (!restaurant) return null;
    const sessionValidation = await validateRestaurantSession(decoded, req);
    if (!sessionValidation.valid) return { sessionInvalid: true };
    return {
      claims: {
        role: 'restaurant',
        scope: 'restaurant',
        email: restaurant.email,
        name: restaurant.name,
        sessionId: decoded.sessionId,
        deviceId: decoded.deviceId,
        tokenVersion: decoded.tokenVersion,
        passwordChangeRecommendation: buildPasswordChangeRecommendation(restaurant),
      },
    };
  }

  if (decoded.scope === 'employee') {
    const employee = await Employee.findOne({ _id: decoded.id, isActive: true }).lean();
    if (!employee) return null;
    return {
      claims: {
        role: employee.role,
        restaurantId: String(employee.restaurantId || employee.restaurant),
        branchId: employee.branchId || null,
        employeeId: String(employee._id),
        name: employee.name,
      },
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

    if (!session) return { sessionInvalid: true };

    return {
      claims: {
        role: authRecord.role,
        restaurantId: String(authRecord.restaurantId),
        branchId: String(authRecord.branchId),
        permissions: authRecord.permissions || {},
        name: authRecord.username,
      },
    };
  }

  return null;
}

async function findActiveFraudLock(decoded, req) {
  const subjects = [];
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || '')
    .split(',')[0]
    .trim();
  if (ip) subjects.push({ subjectType: 'ip', subjectId: ip });
  if (decoded.scope === 'restaurant') subjects.push({ subjectType: 'Restaurant', subjectId: String(decoded.id) });
  if (decoded.scope === 'employee') subjects.push({ subjectType: 'Employee', subjectId: String(decoded.employeeId || decoded.id) });
  if (decoded.scope === 'branch_user') subjects.push({ subjectType: 'BranchAuth', subjectId: String(decoded.id) });
  if (!subjects.length) return null;
  return FraudLock.findOne({
    active: true,
    lockedUntil: { $gt: new Date() },
    $or: subjects,
  }).lean();
}

function shouldBlockRestaurantForPasswordChange(claims, req) {
  if (claims?.scope !== 'restaurant' || claims?.role !== 'restaurant') return false;
  if (!claims.passwordChangeRecommendation?.required) return false;

  const path = String(req.originalUrl || req.url || '').split('?')[0];
  const allowedPaths = new Set([
    '/api/restaurant/auth/change-password',
    '/api/restaurant/auth/logout',
    '/api/restaurant/auth/profile',
    '/api/restaurant/auth/access',
  ]);
  return !allowedPaths.has(path);
}

module.exports = verifyToken;
