const requireRestaurantPlanFeatureUnlessBranch = require('./requireRestaurantPlanFeatureUnlessBranch');

function resolveFinanceFeatureKey(path) {
  const p = String(path || '');

  if (p.includes('/budgets')) return 'budget';
  if (p.includes('/expenses')) return 'expenses';
  if (p.includes('/profit-loss')) return 'profitLoss';
  if (p.includes('/tds')) return 'payroll';
  if (
    p.includes('/accounting') ||
    p.includes('/period-locks') ||
    p.includes('/tax')
  ) {
    return 'accounting';
  }
  if (
    p.startsWith('/sales') ||
    p.includes('/erp-dashboard') ||
    p.includes('/revenue-by-channel')
  ) {
    return 'financeOverview';
  }

  return 'financeOverview';
}

/**
 * Picks the correct plan feature key from finance API path segments.
 */
function requireFinancePlanFeature(req, res, next) {
  const key = resolveFinanceFeatureKey(req.path);
  return requireRestaurantPlanFeatureUnlessBranch(key)(req, res, next);
}

module.exports = requireFinancePlanFeature;
module.exports.resolveFinanceFeatureKey = resolveFinanceFeatureKey;
