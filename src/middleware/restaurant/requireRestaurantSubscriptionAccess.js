const Restaurant = require('../../models/restaurant/Restaurant');
const { error } = require('../../utils/apiResponse');
const resolveRestaurantId = require('./resolveRestaurantId');

/**
 * Blocks restaurant routes when the 14-day trial has ended and there is no active paid plan.
 * Exempt by mounting only on routes that should be locked; package/kyc/auth profile stay open.
 */
const requireRestaurantSubscriptionAccess = async (req, res, next) => {
  try {
    const rid = resolveRestaurantId(req);
    if (!rid) {
      return error(res, 'Unable to resolve restaurant', 403);
    }

    const restaurant = await Restaurant.findById(rid).select(
      'trialEndsAt currentPlan planEndDate createdAt planAssignmentSource',
    );
    if (!restaurant) {
      return error(res, 'Restaurant not found', 404);
    }

    if (!restaurant.canUseRestaurantFeatures()) {
      const readOnlyMethod = ['GET', 'HEAD'].includes(String(req.method || '').toUpperCase());
      if (readOnlyMethod) {
        req.subscriptionReadOnly = true;
        return next();
      }
      const hadPaidPlan =
        restaurant.planEndDate &&
        (restaurant.currentPlan || restaurant.planAssignmentSource === 'custom');
      const subscriptionExpired =
        hadPaidPlan && new Date(restaurant.planEndDate) <= new Date();
      const message = subscriptionExpired
        ? 'Your subscription has expired. Renew your subscription to make changes.'
        : 'Your trial has expired. Choose a plan from Subscription to continue.';
      return error(res, message, 403, {
        code: subscriptionExpired ? 'SUBSCRIPTION_EXPIRED' : 'TRIAL_OR_PLAN_EXPIRED',
        readOnly: true,
      });
    }

    next();
  } catch (err) {
    next(err);
  }
};

module.exports = requireRestaurantSubscriptionAccess;
