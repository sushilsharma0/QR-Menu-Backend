const { forbidden } = require('../../utils/apiResponse');
const POSShift = require('../../models/restaurant/POSShift');

function restaurantIdFromUser(req) {
  return req.user?.restaurantId || req.user?.id;
}

function shiftOperatorFromUser(req) {
  if (req.user?.scope === 'branch_user') {
    return { operatorType: 'BranchAuth', operator: req.user.id };
  }
  const isEmployee = req.user?.scope === 'employee' || Boolean(req.user?.employeeId);
  return {
    operatorType: isEmployee ? 'Employee' : 'Restaurant',
    operator: isEmployee ? (req.user.employeeId || req.user.id) : req.user?.id,
  };
}

function openShiftQueryFromUser(req) {
  const restaurant = restaurantIdFromUser(req);
  const q = {
    restaurant,
    status: 'open',
  };
  if (req.branchId) {
    if (req.user?.scope === 'branch_user') {
      q.branchId = req.branchId;
    } else {
      q.$or = [{ branchId: req.branchId }, { branchId: null }, { branchId: { $exists: false } }];
    }
  }
  return q;
}

function isRestaurantOwner(req) {
  return req.user?.role === 'restaurant' && req.user?.scope !== 'employee';
}

/** Full POS (admin owner) */
function requirePosFullAccess(req, res, next) {
  if (!req.user) return forbidden(res, 'Authentication required');
  if (isRestaurantOwner(req)) return next();
  if (
    req.user.scope === 'branch_user' &&
    ['branch_admin', 'branch_manager', 'branch_cashier', 'branch_waiter'].includes(req.user.role)
  ) {
    return next();
  }
  if (req.user.scope === 'employee' && ['manager', 'cashier', 'waiter'].includes(req.user.role)) {
    return next();
  }
  return forbidden(res, 'POS access denied');
}

/** Billing, payments, shift (not waiter-only screens) */
function requirePosBillingAccess(req, res, next) {
  if (!req.user) return forbidden(res, 'Authentication required');
  if (isRestaurantOwner(req)) return next();
  if (
    req.user.scope === 'branch_user' &&
    ['branch_admin', 'branch_manager', 'branch_cashier'].includes(req.user.role)
  ) {
    return next();
  }
  if (req.user.scope === 'employee' && ['manager', 'cashier'].includes(req.user.role)) {
    return next();
  }
  return forbidden(res, 'Billing access denied');
}

/** Manager + owner: refunds, reports export */
function requirePosManagerAccess(req, res, next) {
  if (!req.user) return forbidden(res, 'Authentication required');
  if (isRestaurantOwner(req)) return next();
  if (req.user.scope === 'branch_user' && ['branch_admin', 'branch_manager'].includes(req.user.role)) {
    return next();
  }
  if (req.user.scope === 'employee' && req.user.role === 'manager') return next();
  return forbidden(res, 'Manager access required');
}

/** Kitchen-style status updates — block waiter */
function requirePosStatusUpdate(req, res, next) {
  if (!req.user) return forbidden(res, 'Authentication required');
  if (isRestaurantOwner(req)) return next();
  if (
    req.user.scope === 'branch_user' &&
    ['branch_kitchen', 'branch_cashier', 'branch_manager', 'branch_admin'].includes(req.user.role)
  ) {
    return next();
  }
  if (req.user.scope === 'employee' && ['kitchen', 'cashier', 'manager'].includes(req.user.role)) {
    return next();
  }
  return forbidden(res, 'Cannot update kitchen status');
}

async function requireOpenPosShift(req, res, next) {
  try {
    const shift = await POSShift.findOne(openShiftQueryFromUser(req)).select('_id');
    if (!shift) {
      return forbidden(res, 'Open a POS shift before using this function');
    }
    req.posShiftId = shift._id;
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  restaurantIdFromUser,
  shiftOperatorFromUser,
  openShiftQueryFromUser,
  requirePosFullAccess,
  requirePosBillingAccess,
  requirePosManagerAccess,
  requirePosStatusUpdate,
  requireOpenPosShift,
};
