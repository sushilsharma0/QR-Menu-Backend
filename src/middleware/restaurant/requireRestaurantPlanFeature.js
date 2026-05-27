const Restaurant = require('../../models/restaurant/Restaurant');
const { error } = require('../../utils/apiResponse');
const resolveRestaurantId = require('./resolveRestaurantId');
const { PLAN_FEATURE_KEYS } = require('../../constants/planFeatures');
const { resolveEffectiveFeatureFlags } = require('../../services/subscriptionAccessService');

/**
 * Blocks when Restaurant.planFeatureFlags[key] === false (catalog and custom plans).
 * Missing keys or empty flags → feature allowed (catalog / legacy).
 */
const requireRestaurantPlanFeature = (featureKey) => {
  if (!PLAN_FEATURE_KEYS.includes(featureKey)) {
    throw new Error(`Unknown plan feature key: ${featureKey}`);
  }

  return async (req, res, next) => {
    try {
      const rid = resolveRestaurantId(req);
      if (!rid) {
        return error(res, 'Unable to resolve restaurant', 403);
      }

      const restaurant = await Restaurant.findById(rid).select(
        'planFeatureFlags trialEndsAt planEndDate planAssignmentSource currentPlan preSubscriptionFeatureGrants',
      );
      if (!restaurant) {
        return error(res, 'Restaurant not found', 404);
      }

      const flags = await resolveEffectiveFeatureFlags(restaurant);
      if (flags[featureKey] === false) {
        return error(res, 'This feature is not included in your subscription.', 403, {
          code: 'PLAN_FEATURE_DISABLED',
          feature: featureKey,
        });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
};

module.exports = requireRestaurantPlanFeature;
