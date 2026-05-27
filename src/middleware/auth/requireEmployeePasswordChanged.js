const Employee = require('../../models/restaurant/Employee');
const { error } = require('../../utils/apiResponse');

/**
 * Blocks employee JWTs until they change the temporary password.
 * Restaurant-owner tokens (scope !== employee) pass through.
 */
const requireEmployeePasswordChanged = async (req, res, next) => {
  if (req.user?.scope === 'branch_user') return next();
  if (req.user?.scope !== 'employee') return next();

  try {
    const employee = await Employee.findById(req.user.id).select('isPasswordChanged');
    if (!employee) {
      return error(res, 'Employee not found', 404);
    }
    if (!employee.isPasswordChanged) {
      return error(res, 'You must change your temporary password before continuing.', 403, {
        code: 'MUST_CHANGE_PASSWORD'
      });
    }
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = requireEmployeePasswordChanged;
