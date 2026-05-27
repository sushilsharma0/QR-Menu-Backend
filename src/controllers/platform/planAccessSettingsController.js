const asyncHandler = require('express-async-handler');
const PlanAccessSettings = require('../../models/platform/PlanAccessSettings');
const Restaurant = require('../../models/restaurant/Restaurant');
const { PLAN_FEATURE_UI_DEFINITIONS, PLAN_FEATURE_GROUPS } = require('../../constants/planFeatures');
const { mergeFeatureFlags, mergePlanLimits } = require('../../utils/planFeatureHelpers');
const { emitSubscriptionAccessUpdatedForRestaurants } = require('../../services/subscriptionRealtimeService');
const { success, error } = require('../../utils/apiResponse');

const getPlanAccessSettings = asyncHandler(async (req, res) => {
  const settings = await PlanAccessSettings.getSingleton();
  return success(
    res,
    {
      trialDays: settings.trialDays,
      trialFeatureFlags: mergeFeatureFlags(settings.trialFeatureFlags),
      trialLimits: mergePlanLimits(settings.trialLimits),
      featureOptions: PLAN_FEATURE_UI_DEFINITIONS,
      groups: PLAN_FEATURE_GROUPS,
    },
    'Trial settings retrieved',
  );
});

const updatePlanAccessSettings = asyncHandler(async (req, res) => {
  const { trialDays, trialFeatureFlags, trialLimits } = req.body || {};
  const settings = await PlanAccessSettings.getSingleton();

  if (trialDays !== undefined) {
    const days = Number(trialDays);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      return error(res, 'trialDays must be between 1 and 365', 400);
    }
    settings.trialDays = Math.floor(days);
  }

  if (trialFeatureFlags && typeof trialFeatureFlags === 'object') {
    settings.trialFeatureFlags = mergeFeatureFlags(trialFeatureFlags);
    settings.markModified('trialFeatureFlags');
  }

  if (trialLimits && typeof trialLimits === 'object') {
    settings.trialLimits = mergePlanLimits(trialLimits, settings.trialLimits);
    settings.markModified('trialLimits');
  }

  await settings.save();
  const trialRestaurantFilter = {
    $or: [{ currentPlan: null }, { currentPlan: { $exists: false } }],
    planAssignmentSource: { $ne: 'custom' },
  };
  await Restaurant.updateMany(trialRestaurantFilter, {
    $set: { planLimits: mergePlanLimits(settings.trialLimits) },
  });
  await emitSubscriptionAccessUpdatedForRestaurants({
    ...trialRestaurantFilter,
  });

  return success(
    res,
    {
      trialDays: settings.trialDays,
      trialFeatureFlags: mergeFeatureFlags(settings.trialFeatureFlags),
      trialLimits: mergePlanLimits(settings.trialLimits),
    },
    'Trial settings updated',
  );
});

module.exports = {
  getPlanAccessSettings,
  updatePlanAccessSettings,
};
