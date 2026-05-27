const { forbidden } = require('../../utils/apiResponse');

const BRANCH_ROLES = new Set([
  'branch_admin',
  'branch_manager',
  'branch_cashier',
  'branch_waiter',
  'branch_kitchen',
]);

const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return forbidden(res, 'Authentication required');
    }

    if (req.user.scope === 'branch_user') {
      if (!BRANCH_ROLES.has(req.user.role)) {
        return forbidden(res, 'Insufficient permissions');
      }
      if (!roles.includes(req.user.role)) {
        return forbidden(res, 'Insufficient permissions');
      }
      return next();
    }

    if (!roles.includes(req.user.role)) {
      return forbidden(res, 'Insufficient permissions');
    }

    next();
  };
};

module.exports = requireRole;