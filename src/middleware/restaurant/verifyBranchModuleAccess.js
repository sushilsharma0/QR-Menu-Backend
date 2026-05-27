const { error } = require('../../utils/apiResponse');
const { ROLE_MODULE_ALLOW, isBranchModuleDisabled } = require('../../constants/branchModules');

function roleAllowsModule(role, moduleKey, permissions) {
  if (['branch_admin', 'branch_manager'].includes(role)) return true;
  if (permissions && typeof permissions === 'object' && permissions[moduleKey] === true) return true;
  const allow = ROLE_MODULE_ALLOW[role];
  if (allow == null) return true;
  return allow.has(moduleKey);
}

/**
 * @param {string} moduleKey — key on Branch.enabledModules (e.g. inventory, orders)
 */
function verifyBranchModuleAccess(moduleKey) {
  return (req, res, next) => {
    if (req.user?.scope !== 'branch_user') return next();
    if (req.branch?.isDefault) return next();

    const modules = req.branch?.enabledModules || {};
    if (isBranchModuleDisabled(modules, moduleKey)) {
      return error(res, 'This module is disabled for your branch', 403, {
        code: 'BRANCH_MODULE_DISABLED',
        module: moduleKey,
      });
    }

    const perms = req.user.permissions || {};
    if (!roleAllowsModule(req.user.role, moduleKey, perms)) {
      return error(res, 'Your branch role cannot access this module', 403, {
        code: 'BRANCH_ROLE_FORBIDDEN',
        module: moduleKey,
      });
    }

    return next();
  };
}

module.exports = verifyBranchModuleAccess;
