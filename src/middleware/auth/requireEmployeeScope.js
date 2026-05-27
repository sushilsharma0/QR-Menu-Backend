const { forbidden } = require('../../utils/apiResponse');

/** JWT employee tokens use scope: 'employee' and role: kitchen|cashier|... */
const requireEmployeeScope = (req, res, next) => {
  if (req.user?.scope === 'employee') return next();
  return forbidden(res, 'Employee access only');
};

module.exports = requireEmployeeScope;
