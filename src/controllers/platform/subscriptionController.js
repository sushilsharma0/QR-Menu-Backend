const asyncHandler = require('express-async-handler');
const Subscription = require('../../models/shared/Subscription');
const Restaurant = require('../../models/restaurant/Restaurant');
const PackageHistory = require('../../models/shared/PackageHistory');
const { success, error } = require('../../utils/apiResponse');
const AuditLog = require('../../models/platform/AuditLog');
const PlatformBillingSettings = require('../../models/platform/PlatformBillingSettings');
const subscriptionService = require('../../services/subscriptionService');
const {
  totalFromExVat,
  exVatFromTotal,
  attachPricingToPlans,
  breakdownFromPlan,
} = require('../../utils/planPricing');
const {
  PLAN_FEATURE_GROUPS,
  PLAN_FEATURE_UI_DEFINITIONS,
  PLAN_FEATURE_KEYS,
} = require('../../constants/planFeatures');
const { mergeFeatureFlags, featureLabelsFromFlags } = require('../../utils/planFeatureHelpers');
const {
  emitSubscriptionAccessUpdated,
  emitSubscriptionAccessUpdatedForRestaurants,
} = require('../../services/subscriptionRealtimeService');

const parseLimitValue = (value, fallback = 0) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed < 0) return fallback;
  return parsed;
};

/**
 * @desc    Get all subscription plans
 * @route   GET /api/platform/subscriptions/plans
 * @access  Public
 */
const getAllPlans = asyncHandler(async (req, res) => {
  const settings = await PlatformBillingSettings.getSingleton();
  const plans = await Subscription.find({ isActive: true }).sort({ sortOrder: 1, price: 1 }).lean();
  const data = attachPricingToPlans(plans, settings);
  return success(res, data, 'Plans retrieved');
});

/**
 * @desc    Get single plan by ID
 * @route   GET /api/platform/subscriptions/plans/:id
 * @access  Public
 */
const getPlanById = asyncHandler(async (req, res) => {
  const plan = await Subscription.findById(req.params.id).lean();
  if (!plan) {
    return error(res, 'Plan not found', 404);
  }
  const settings = await PlatformBillingSettings.getSingleton();
  const data = { ...plan, pricing: breakdownFromPlan(plan, settings) };
  return success(res, data, 'Plan retrieved');
});

/**
 * @desc    Create subscription plan
 * @route   POST /api/platform/subscriptions/plans
 * @access  Private (Admin)
 */
const createPlan = asyncHandler(async (req, res) => {
  const {
    name,
    planType,
    duration,
    durationLabel,
    priceExclVat,
    price,
    features,
    featureFlags,
    limits,
    isPopular,
    sortOrder,
  } =
    req.body;

  if (!name || !planType || !duration) {
    return error(res, 'Name, plan type and duration are required', 400);
  }

  const settings = await PlatformBillingSettings.getSingleton();
  let excl;
  let total;

  if (priceExclVat !== undefined && priceExclVat !== null && priceExclVat !== '') {
    excl = Number(priceExclVat);
    if (Number.isNaN(excl) || excl < 0) {
      return error(res, 'priceExclVat must be a non-negative number', 400);
    }
    total = totalFromExVat(excl, settings.vatRatePercent);
  } else if (price !== undefined && price !== null && price !== '') {
    total = Number(price);
    if (Number.isNaN(total) || total < 0) {
      return error(res, 'price must be a non-negative number', 400);
    }
    excl = exVatFromTotal(total, settings.vatRatePercent);
  } else {
    return error(res, 'priceExclVat (amount before VAT) is required', 400);
  }

  const existing = await Subscription.findOne({ name });
  if (existing) {
    return error(res, 'Plan with this name already exists', 409);
  }

  const mergedFlags = mergeFeatureFlags(featureFlags);
  const featureList = Array.isArray(features) && features.filter(Boolean).length
    ? features.filter(Boolean)
    : featureLabelsFromFlags(mergedFlags);

  const plan = await Subscription.create({
    name,
    planType,
    duration,
    durationLabel: durationLabel || (duration === 30 ? 'Monthly' : duration === 365 ? 'Yearly' : `${duration} days`),
    priceExclVat: excl,
    price: total,
    features: featureList,
    featureFlags: mergedFlags,
    limits: {
      maxTables: parseLimitValue(limits?.maxTables, 0),
      maxEmployees: parseLimitValue(limits?.maxEmployees, 0),
      maxCategories: parseLimitValue(limits?.maxCategories, 0),
      maxMenuItems: parseLimitValue(limits?.maxMenuItems, 0),
    },
    isPopular: isPopular || false,
    sortOrder: sortOrder || 0,
    isActive: true,
  });

  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'plan_create',
    resource: 'plan',
    resourceId: plan._id,
    details: { name, planType, priceExclVat: excl, price: total, featureFlags: mergeFeatureFlags(featureFlags) },
    ipAddress: req.ip,
  });

  const out = { ...plan.toObject(), pricing: breakdownFromPlan(plan, settings) };
  return success(res, out, 'Plan created successfully', 201);
});

/**
 * @desc    Update subscription plan
 * @route   PUT /api/platform/subscriptions/plans/:id
 * @access  Private (Admin)
 */
const updatePlan = asyncHandler(async (req, res) => {
  const {
    name,
    planType,
    duration,
    durationLabel,
    priceExclVat,
    price,
    features,
    featureFlags,
    limits,
    isPopular,
    sortOrder,
    isActive,
  } = req.body;

  const plan = await Subscription.findById(req.params.id);
  if (!plan) {
    return error(res, 'Plan not found', 404);
  }

  const settings = await PlatformBillingSettings.getSingleton();

  if (name) plan.name = name;
  if (planType) plan.planType = planType;
  if (duration) plan.duration = duration;
  if (durationLabel) plan.durationLabel = durationLabel;

  if (priceExclVat !== undefined && priceExclVat !== null && priceExclVat !== '') {
    const excl = Number(priceExclVat);
    if (Number.isNaN(excl) || excl < 0) {
      return error(res, 'priceExclVat must be a non-negative number', 400);
    }
    plan.priceExclVat = excl;
    plan.price = totalFromExVat(excl, settings.vatRatePercent);
  } else if (price !== undefined && price !== null && price !== '') {
    const total = Number(price);
    if (Number.isNaN(total) || total < 0) {
      return error(res, 'price must be a non-negative number', 400);
    }
    plan.price = total;
    plan.priceExclVat = exVatFromTotal(total, settings.vatRatePercent);
  }

  let nextFeatureFlags = null;
  if (featureFlags && typeof featureFlags === 'object') {
    nextFeatureFlags = mergeFeatureFlags(featureFlags);
    plan.featureFlags = nextFeatureFlags;
  }
  if (Array.isArray(features) && features.length) {
    plan.features = features.filter(Boolean);
  } else if (featureFlags && typeof featureFlags === 'object') {
    plan.features = featureLabelsFromFlags(plan.featureFlags);
  } else if (features) {
    plan.features = features;
  }
  if (limits) {
    plan.limits = {
      maxTables: parseLimitValue(limits.maxTables, plan.limits.maxTables ?? 0),
      maxEmployees: parseLimitValue(limits.maxEmployees, plan.limits.maxEmployees ?? 0),
      maxCategories: parseLimitValue(limits.maxCategories, plan.limits.maxCategories ?? 0),
      maxMenuItems: parseLimitValue(limits.maxMenuItems, plan.limits.maxMenuItems ?? 0)
    };
  }
  if (typeof isPopular === 'boolean') plan.isPopular = isPopular;
  if (sortOrder) plan.sortOrder = sortOrder;
  if (typeof isActive === 'boolean') plan.isActive = isActive;
  
  await plan.save();

  if (nextFeatureFlags || features || limits) {
    const effectiveFlags = nextFeatureFlags || mergeFeatureFlags(plan.featureFlags);
    const labels = featureLabelsFromFlags(effectiveFlags);
    const restaurantUpdate = {
      planFeatureFlags: effectiveFlags,
      planFeatures: Array.from(
        new Set([...(Array.isArray(plan.features) ? plan.features : []), ...labels]),
      ),
    };
    if (limits) restaurantUpdate.planLimits = plan.limits;

    await Restaurant.updateMany(
      {
        currentPlan: plan._id,
        planAssignmentSource: { $ne: 'custom' },
        isDeleted: { $ne: true },
      },
      { $set: restaurantUpdate },
    );
    await emitSubscriptionAccessUpdatedForRestaurants({
      currentPlan: plan._id,
      planAssignmentSource: { $ne: 'custom' },
    });
  }

  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'plan_update',
    resource: 'plan',
    resourceId: plan._id,
    details: req.body,
    ipAddress: req.ip,
  });

  const out = { ...plan.toObject(), pricing: breakdownFromPlan(plan, settings) };
  return success(res, out, 'Plan updated');
});

/**
 * @desc    Delete subscription plan
 * @route   DELETE /api/platform/subscriptions/plans/:id
 * @access  Private (Admin)
 */
const deletePlan = asyncHandler(async (req, res) => {
  const plan = await Subscription.findById(req.params.id);
  if (!plan) {
    return error(res, 'Plan not found', 404);
  }
  
  // Check if plan is in use
  const inUse = await Restaurant.findOne({ $or: [{ currentPlan: plan._id }, { requestedPlan: plan._id }] });
  if (inUse) {
    return error(res, 'Cannot delete plan that is assigned to restaurants', 400);
  }
  
  await plan.deleteOne();
  
  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'plan_delete',
    resource: 'plan',
    resourceId: plan._id,
    details: { name: plan.name },
    ipAddress: req.ip
  });
  
  return success(res, null, 'Plan deleted');
});

/**
 * @desc    Assign plan to restaurant
 * @route   POST /api/platform/subscriptions/assign
 * @access  Private (Admin)
 */
const assignPlanToRestaurant = asyncHandler(async (req, res) => {
  const { restaurantId, planId, notes } = req.body;
  
  if (!restaurantId || !planId) {
    return error(res, 'Restaurant ID and Plan ID are required', 400);
  }
  
  const restaurant = await Restaurant.findById(restaurantId);
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }
  
  const result = await subscriptionService.assignPlan(restaurantId, planId, req.user.id, notes);
  
  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'plan_assign',
    resource: 'restaurant',
    resourceId: restaurantId,
    details: { planId, notes },
    ipAddress: req.ip
  });
  
  return success(res, { expiresAt: result.planEndDate }, 'Plan assigned successfully');
});

/**
 * @desc    Feature toggles + labels for custom plan assignment UI
 * @route   GET /api/platform/subscriptions/plan-feature-options
 */
const getPlanFeatureOptions = asyncHandler(async (req, res) =>
  success(
    res,
    { groups: PLAN_FEATURE_GROUPS, features: PLAN_FEATURE_UI_DEFINITIONS },
    'Plan feature options',
  ),
);

/**
 * @desc    Assign a custom duration + limits + feature set (super admin only)
 * @route   POST /api/platform/subscriptions/assign-custom
 */
const assignCustomPlanToRestaurant = asyncHandler(async (req, res) => {
  const { restaurantId, planLabel, durationDays, limits, features, notes } = req.body;

  if (!restaurantId) {
    return error(res, 'restaurantId is required', 400);
  }

  const restaurant = await Restaurant.findById(restaurantId);
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }

  try {
    const result = await subscriptionService.assignCustomPlan(
      restaurantId,
      { planLabel, durationDays, limits, features },
      req.user.id,
      notes,
    );

    await AuditLog.create({
      user: req.user.id,
      userModel: 'Platform',
      action: 'custom_plan_assign',
      resource: 'restaurant',
      resourceId: restaurantId,
      details: { planLabel, durationDays, limits, features, notes },
      ipAddress: req.ip,
    });

    return success(
      res,
      {
        expiresAt: result.planEndDate,
        planAssignmentSource: result.planAssignmentSource,
        customPlanLabel: result.customPlanLabel,
        planFeatureFlags: result.planFeatureFlags,
        planLimits: result.planLimits,
      },
      'Custom plan assigned successfully',
    );
  } catch (err) {
    const msg = err.message || 'Failed to assign custom plan';
    const status = /active subscription/i.test(msg) ? 409 : 400;
    return error(res, msg, status);
  }
});

/**
 * @desc    Get pending plan requests
 * @route   GET /api/platform/subscriptions/requests/pending
 * @access  Private (Admin)
 */
const getPendingPlanRequests = asyncHandler(async (req, res) => {
  const settings = await PlatformBillingSettings.getSingleton();
  const pendingRequests = await Restaurant.find({
    requestedPlan: { $ne: null },
    planRequestStatus: { $ne: 'awaiting_proof' },
  })
    .populate('currentPlan', 'name price priceExclVat')
    .populate('requestedPlan', 'name price priceExclVat duration durationLabel')
    .select(
      'name email requestedPlan currentPlan planRequestDate planRequestStatus planPaymentProofPath planPaymentReferenceId planRequestRejectionReason trialEndsAt'
    )
    .sort({ planRequestDate: -1 })
    .lean();

  const data = pendingRequests.map((row) => ({
    ...row,
    requestedPlan: row.requestedPlan
      ? { ...row.requestedPlan, pricing: breakdownFromPlan(row.requestedPlan, settings) }
      : row.requestedPlan,
    currentPlan: row.currentPlan
      ? { ...row.currentPlan, pricing: breakdownFromPlan(row.currentPlan, settings) }
      : row.currentPlan,
  }));

  return success(res, data, 'Pending plan requests retrieved');
});

/**
 * @desc    Approve plan request
 * @route   POST /api/platform/subscriptions/requests/:restaurantId/approve
 * @access  Private (Admin)
 */
const approvePlanRequest = asyncHandler(async (req, res) => {
  const { restaurantId } = req.params;
  const { notes } = req.body;
  
  const restaurant = await Restaurant.findById(restaurantId);
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }
  
  if (!restaurant.requestedPlan) {
    return error(res, 'No pending plan request', 400);
  }

  if (restaurant.planRequestStatus === 'awaiting_proof') {
    return error(res, 'Restaurant has not uploaded payment proof yet.', 400);
  }
  
  const result = await subscriptionService.assignPlan(restaurantId, restaurant.requestedPlan, req.user.id, notes);
  
  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'plan_request_approve',
    resource: 'restaurant',
    resourceId: restaurantId,
    details: { planId: restaurant.requestedPlan, notes },
    ipAddress: req.ip
  });
  
  return success(res, { expiresAt: result.planEndDate }, 'Plan request approved');
});

/**
 * @desc    Reject plan request
 * @route   POST /api/platform/subscriptions/requests/:restaurantId/reject
 * @access  Private (Admin)
 */
const rejectPlanRequest = asyncHandler(async (req, res) => {
  const { restaurantId } = req.params;
  const { reason } = req.body;
  
  const restaurant = await Restaurant.findById(restaurantId);
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }
  
  if (!restaurant.requestedPlan) {
    return error(res, 'No pending plan request', 400);
  }
  
  restaurant.planRequestRejectionReason = reason || 'Request rejected';
  restaurant.requestedPlan = null;
  restaurant.planRequestDate = null;
  restaurant.planRequestStatus = 'none';
  restaurant.planPaymentProofPath = undefined;
  restaurant.planPaymentReferenceId = undefined;
  await restaurant.save();
  
  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'plan_request_reject',
    resource: 'restaurant',
    resourceId: restaurantId,
    details: { reason },
    ipAddress: req.ip
  });
  
  return success(res, null, 'Plan request rejected');
});

/**
 * @desc    Grant specific features before subscription (ignored while a paid plan is active).
 * @route   PATCH /api/platform/subscriptions/restaurants/:restaurantId/feature-grants
 */
const updatePreSubscriptionFeatureGrants = asyncHandler(async (req, res) => {
  const { restaurantId } = req.params;
  const { grants } = req.body || {};

  const restaurant = await Restaurant.findById(restaurantId);
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }

  if (restaurant.hasPaidPlanActive()) {
    return error(
      res,
      'Cannot change feature grants while an active paid subscription is in effect. Use plan assignment instead.',
      400,
    );
  }

  if (!grants || typeof grants !== 'object') {
    return error(res, 'grants object is required', 400);
  }

  const next = {};
  for (const key of PLAN_FEATURE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(grants, key)) {
      next[key] = Boolean(grants[key]);
    }
  }

  restaurant.preSubscriptionFeatureGrants = next;
  restaurant.markModified('preSubscriptionFeatureGrants');
  await restaurant.save();
  await emitSubscriptionAccessUpdated(restaurantId);

  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'pre_subscription_feature_grants',
    resource: 'restaurant',
    resourceId: restaurantId,
    details: { grants: next },
    ipAddress: req.ip,
  });

  return success(
    res,
    { preSubscriptionFeatureGrants: restaurant.preSubscriptionFeatureGrants },
    'Pre-subscription feature grants updated',
  );
});

module.exports = {
  getAllPlans,
  getPlanById,
  createPlan,
  updatePlan,
  deletePlan,
  assignPlanToRestaurant,
  getPlanFeatureOptions,
  assignCustomPlanToRestaurant,
  getPendingPlanRequests,
  approvePlanRequest,
  rejectPlanRequest,
  updatePreSubscriptionFeatureGrants,
};
