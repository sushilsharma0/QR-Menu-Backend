const { forbidden } = require('../../utils/apiResponse');
const { BILLING_GRANULAR_PERMISSION_KEYS, LEGACY_FULL_BILLING_KEY } = require('../../constants/platformPermissions');

/**
 * One billing slice (plans, invoices, …). Grants access if legacy
 * {@link LEGACY_FULL_BILLING_KEY} is still true or the slice key is true.
 */
function checkBillingPermission(requiredBillingKey) {
  return (req, res, next) => {
    if (!req.user) {
      return forbidden(res, 'Authentication required');
    }
    if (req.user.role === 'super_admin') {
      return next();
    }

    const p = req.user.permissions || {};
    if (p[LEGACY_FULL_BILLING_KEY] === true) {
      return next();
    }

    const key = typeof requiredBillingKey === 'string' ? requiredBillingKey : '';
    if (!key || !BILLING_GRANULAR_PERMISSION_KEYS.includes(key)) {
      return forbidden(res, `Permission denied: invalid billing permission (${key})`);
    }

    if (p[key] === true) {
      return next();
    }

    return forbidden(res, `Permission denied: ${key} required`);
  };
}

module.exports = checkBillingPermission;
