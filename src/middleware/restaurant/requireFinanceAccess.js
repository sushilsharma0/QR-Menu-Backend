const { forbidden } = require('../../utils/apiResponse');
const { isBranchModuleDisabled, resolveFinanceModuleKey } = require('../../constants/branchModules');

const permissionMatrix = {
  restaurant: new Set(['all']),
  admin: new Set(['all']),
  manager: new Set(['reports', 'expenses', 'inventory', 'tax', 'payroll', 'sales', 'invoices']),
  accountant: new Set(['reports', 'expenses', 'inventory', 'tax', 'payroll', 'sales', 'invoices']),
  cashier: new Set(['reports', 'expenses', 'inventory', 'tax', 'payroll', 'sales', 'invoices']),
  waiter: new Set([]),
  kitchen: new Set([]),
};

/**
 * permission keys: sales, expenses, reports, inventory, tax, invoices, payroll
 */
const requireFinanceAccess = (...requiredPermissions) => {
  return (req, res, next) => {
    if (!req.user) {
      return forbidden(res, 'Authentication required');
    }

    if (req.user.role === 'restaurant') return next();

    if (req.user.scope === 'branch_user') {
      const permToModule = {
        payroll: 'payroll',
        expenses: 'expenses',
        reports: 'profitLoss',
        sales: 'financeOverview',
        tax: 'accounting',
        invoices: 'billing',
        inventory: 'inventory',
      };
      const modKey =
        requiredPermissions.map((p) => permToModule[p]).find(Boolean)
        || resolveFinanceModuleKey(req.path);
      if (isBranchModuleDisabled(req.branch?.enabledModules, modKey)) {
        return forbidden(res, `${modKey} is disabled for this branch`);
      }
      if (!['branch_admin', 'branch_manager'].includes(req.user.role)) {
        return forbidden(res, 'You do not have permission for accounting operations');
      }
      return next();
    }

    if (req.user.scope !== 'employee') {
      return forbidden(res, 'Only restaurant staff can access this module');
    }

    const rolePermissions = permissionMatrix[req.user.role] || new Set();
    const canAll = rolePermissions.has('all');
    const ok = requiredPermissions.every((p) => canAll || rolePermissions.has(p));
    if (!ok) {
      return forbidden(res, 'You do not have permission for accounting operations');
    }
    next();
  };
};

module.exports = requireFinanceAccess;
