const { forbidden, unauthorized } = require('../utils/apiResponse');

const authenticateEmployee = (req, res, next) => {
  if (!req.user) {
    return unauthorized(res, 'Authentication required');
  }

  if (req.user.scope !== 'employee') {
    return forbidden(res, 'Employee access required');
  }

  return next();
};

const allowEmployeeRoles = (...roles) => (req, res, next) => {
  if (!req.user) {
    return unauthorized(res, 'Authentication required');
  }

  if (req.user.scope !== 'employee') {
    return forbidden(res, 'Employee access required');
  }

  if (!roles.includes(req.user.role)) {
    return forbidden(res, 'Insufficient employee permissions');
  }

  return next();
};

module.exports = {
  authenticateEmployee,
  allowEmployeeRoles,
};
