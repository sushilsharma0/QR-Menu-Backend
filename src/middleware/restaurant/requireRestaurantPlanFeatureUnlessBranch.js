const requireRestaurantPlanFeature = require('./requireRestaurantPlanFeature');

/**
 * Branch portal access is gated by Branch.enabledModules (owner-controlled), not catalog plan flags.
 */
function requireRestaurantPlanFeatureUnlessBranch(featureKey) {
  const inner = requireRestaurantPlanFeature(featureKey);
  return (req, res, next) => {
    if (req.user?.scope === 'branch_user') return next();
    return inner(req, res, next);
  };
}

module.exports = requireRestaurantPlanFeatureUnlessBranch;
