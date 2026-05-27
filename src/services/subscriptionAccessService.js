const PlanAccessSettings = require('../models/platform/PlanAccessSettings');
const Subscription = require('../models/shared/Subscription');
const { PLAN_FEATURE_KEYS } = require('../constants/planFeatures');
const { mergeFeatureFlags, mergePlanLimits } = require('../utils/planFeatureHelpers');

function allFalseFlags() {
  const out = {};
  for (const key of PLAN_FEATURE_KEYS) {
    out[key] = false;
  }
  return out;
}

function applyFeatureGrants(flags, grants) {
  if (!grants || typeof grants !== 'object') {
    return flags;
  }
  const next = { ...flags };
  for (const key of PLAN_FEATURE_KEYS) {
    if (grants[key] === true) {
      next[key] = true;
    }
  }
  return next;
}

/**
 * Effective feature flags for API + restaurant portal.
 * - Active paid plan: catalog/custom flags only (no pre-subscription grants).
 * - Active trial: platform trial profile (+ optional admin grants).
 * - Expired (no trial, no paid): all locked.
 */
async function resolveEffectiveFeatureFlags(restaurant, platformSettings = null) {
  const settings = platformSettings || (await PlanAccessSettings.getSingleton());

  if (restaurant.hasPaidPlanActive()) {
    if (restaurant.planAssignmentSource === 'custom') {
      return mergeFeatureFlags(restaurant.planFeatureFlags);
    }
    if (restaurant.currentPlan) {
      const plan = await Subscription.findById(restaurant.currentPlan).select('featureFlags').lean();
      if (plan?.featureFlags) {
        return mergeFeatureFlags(plan.featureFlags);
      }
    }
    return mergeFeatureFlags(restaurant.planFeatureFlags);
  }

  if (restaurant.isTrialActive()) {
    const trialFlags = mergeFeatureFlags(settings.trialFeatureFlags);
    return applyFeatureGrants(trialFlags, restaurant.preSubscriptionFeatureGrants);
  }

  return allFalseFlags();
}

async function buildRestaurantAccessSnapshot(restaurant) {
  const settings = await PlanAccessSettings.getSingleton();
  const planFeatureFlags = await resolveEffectiveFeatureFlags(restaurant, settings);
  const trialDaysLeft = restaurant.trialEndsAt
    ? Math.max(0, Math.ceil((new Date(restaurant.trialEndsAt) - Date.now()) / (1000 * 60 * 60 * 24)))
    : 0;

  const isTrialActive = restaurant.isTrialActive();
  const hasPaidPlanActive = restaurant.hasPaidPlanActive();
  const canUseFeatures = restaurant.canUseRestaurantFeatures();
  const needsPlanUpgrade = !canUseFeatures;

  let accessTier = 'expired';
  if (hasPaidPlanActive) accessTier = 'paid';
  else if (isTrialActive) accessTier = 'trial';

  const assignedPlanName =
    restaurant.planAssignmentSource === 'custom'
      ? restaurant.customPlanLabel || 'Custom plan'
      : undefined;
  const planLimits = isTrialActive && !hasPaidPlanActive
    ? mergePlanLimits(settings.trialLimits)
    : mergePlanLimits(restaurant.planLimits || restaurant.currentPlan?.limits);

  return {
    trialEndsAt: restaurant.trialEndsAt,
    trialDays: settings.trialDays,
    trialDaysLeft,
    isTrialActive,
    hasPaidPlanActive,
    needsPlanUpgrade,
    canUseFeatures,
    accessTier,
    planEndDate: restaurant.planEndDate,
    planFeatureFlags,
    planLimits,
    planAssignmentSource: restaurant.planAssignmentSource,
    customPlanLabel: restaurant.customPlanLabel,
    assignedPlanName,
    showTrialWelcome: Boolean(isTrialActive && !hasPaidPlanActive && !restaurant.hasSeenTrialWelcome),
    preSubscriptionFeatureGrants: restaurant.preSubscriptionFeatureGrants || {},
  };
}

async function getTrialDays() {
  const settings = await PlanAccessSettings.getSingleton();
  return settings.trialDays;
}

async function getTrialLimits() {
  const settings = await PlanAccessSettings.getSingleton();
  return mergePlanLimits(settings.trialLimits);
}

module.exports = {
  resolveEffectiveFeatureFlags,
  buildRestaurantAccessSnapshot,
  getTrialDays,
  getTrialLimits,
  applyFeatureGrants,
  allFalseFlags,
};
