const asyncHandler = require('express-async-handler');
const Restaurant = require('../../models/restaurant/Restaurant');
const RestaurantReferral = require('../../models/restaurant/RestaurantReferral');
const Subscription = require('../../models/shared/Subscription');
const PackageHistory = require('../../models/shared/PackageHistory');
const PlatformBillingSettings = require('../../models/platform/PlatformBillingSettings');
const ManualPaymentSettings = require('../../models/platform/ManualPaymentSettings');
const { breakdownFromPlan } = require('../../utils/planPricing');
const { buildRestaurantAccessSnapshot } = require('../../services/subscriptionAccessService');
const { mergeFeatureFlags } = require('../../utils/planFeatureHelpers');
const { success, error } = require('../../utils/apiResponse');

/**
 * @desc    Get current package status
 * @route   GET /api/restaurant/package/status
 * @access  Private
 */
const getPackageStatus = asyncHandler(async (req, res) => {
  const restaurant = await Restaurant.findById(req.user.id)
    .populate('currentPlan', 'name planType price priceExclVat features featureFlags limits duration durationLabel')
    .populate('requestedPlan', 'name planType price priceExclVat features limits duration durationLabel');

  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }

  const settings = await PlatformBillingSettings.getSingleton();
  const withPricing = (doc) => {
    if (!doc) return null;
    const plain = doc.toObject ? doc.toObject() : doc;
    return { ...plain, pricing: breakdownFromPlan(plain, settings) };
  };

  const now = new Date();
  const manualPaymentSettings = await ManualPaymentSettings.getSingleton();
  const daysLeft = restaurant.planEndDate
    ? Math.max(0, Math.ceil((restaurant.planEndDate - now) / (1000 * 60 * 60 * 24)))
    : 0;

  const access = await buildRestaurantAccessSnapshot(restaurant);
  const pendingReferral = await RestaurantReferral.findOne({
    $or: [
      { status: 'pending', referrerRestaurant: restaurant._id },
      { status: 'pending', referredRestaurant: restaurant._id },
      { status: 'qualified', referrerRestaurant: restaurant._id },
    ],
  })
    .populate('referrerRestaurant', 'name')
    .populate('referredRestaurant', 'name')
    .sort({ createdAt: -1 })
    .lean();

  const referralRole =
    pendingReferral && String(pendingReferral.referrerRestaurant?._id) === String(restaurant._id)
      ? 'referrer'
      : 'referred';
  const referralBenefit = pendingReferral
    ? {
        status: pendingReferral.status,
        rewardDays: pendingReferral.rewardDays || 30,
        role: referralRole,
        referrerRestaurantName: pendingReferral.referrerRestaurant?.name || '',
        referredRestaurantName: pendingReferral.referredRestaurant?.name || '',
        message:
          referralRole === 'referrer' && pendingReferral.status === 'qualified'
            ? '1 month will be added when you activate your next plan.'
            : referralRole === 'referrer'
            ? '1 month will be added in your next plan after the referred restaurant activates their first plan.'
            : '1 month will be added when you activate your first plan.',
      }
    : null;

  const hadPaidSubscription =
    restaurant.planEndDate &&
    (restaurant.currentPlan || restaurant.planAssignmentSource === 'custom');
  const subscriptionExpired =
    hadPaidSubscription && !access.hasPaidPlanActive && !access.isTrialActive;

  let includedPlanFeatureFlags = access.planFeatureFlags;
  if (subscriptionExpired) {
    if (restaurant.planAssignmentSource === 'custom') {
      includedPlanFeatureFlags = mergeFeatureFlags(restaurant.planFeatureFlags);
    } else if (restaurant.currentPlan?.featureFlags) {
      includedPlanFeatureFlags = mergeFeatureFlags(restaurant.currentPlan.featureFlags);
    }
  }

  return success(res, {
    currentPlan: withPricing(restaurant.currentPlan),
    requestedPlan: withPricing(restaurant.requestedPlan),
    planStartDate: restaurant.planStartDate,
    planEndDate: restaurant.planEndDate,
    daysLeft,
    trialEndsAt: restaurant.trialEndsAt,
    trialDaysLeft: access.trialDaysLeft,
    trialDays: access.trialDays,
    isTrialActive: access.isTrialActive,
    hasPaidPlanActive: access.hasPaidPlanActive,
    canUseFeatures: access.canUseFeatures,
    accessTier: access.accessTier,
    isActive: restaurant.isActive,
    isExpired: restaurant.planEndDate ? restaurant.planEndDate < now : true,
    hasPendingRequest: !!restaurant.requestedPlan,
    planRequestStatus: restaurant.planRequestStatus,
    planPaymentProofUrl: restaurant.planPaymentProofPath || null,
    planPaymentReferenceId: restaurant.planPaymentReferenceId || null,
    planRequestRejectionReason: restaurant.planRequestRejectionReason || null,
    planLimits: access.planLimits,
    planFeatures: restaurant.planFeatures,
    planAssignmentSource: restaurant.planAssignmentSource,
    customPlanLabel: restaurant.customPlanLabel,
    planFeatureFlags: access.planFeatureFlags,
    includedPlanFeatureFlags,
    manualPaymentDetails: {
      accountName: manualPaymentSettings.accountName || '',
      accountNumber: manualPaymentSettings.accountNumber || '',
      branch: manualPaymentSettings.branch || '',
      qrCodeImage: manualPaymentSettings.qrCodeImage || '',
      notes: manualPaymentSettings.notes || '',
    },
    subscription: restaurant.subscription,
    autoRenew: restaurant.autoRenew,
    referralBenefit,
  }, 'Package status retrieved');
});

/**
 * @desc    Request a new package
 * @route   POST /api/restaurant/package/request
 * @access  Private
 */
const requestPackage = asyncHandler(async (req, res) => {
  const { packageId } = req.body;
  
  if (!packageId) {
    return error(res, 'Package ID is required', 400);
  }
  
  const restaurant = await Restaurant.findById(req.user.id);
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }
  
  const plan = await Subscription.findById(packageId);
  if (!plan || !plan.isActive) {
    return error(res, 'Invalid package', 400);
  }
  
  if (!restaurant.isKYCVerified) {
    return error(
      res,
      'KYC verification is required before selecting a subscription plan.',
      403
    );
  }

  if (restaurant.planRequestStatus === 'pending_review') {
    return error(res, 'A plan request is already awaiting platform review.', 400);
  }

  // Prevent duplicate request (same plan while waiting for proof)
  if (
    restaurant.requestedPlan &&
    restaurant.requestedPlan.toString() === packageId &&
    restaurant.planRequestStatus === 'awaiting_proof'
  ) {
    return error(res, 'Upload your payment proof to submit this request for review.', 400);
  }
  
  // Prevent requesting same active plan (allow renewal when subscription has expired)
  if (
    restaurant.currentPlan &&
    restaurant.currentPlan.toString() === packageId &&
    restaurant.hasPaidPlanActive()
  ) {
    return error(res, 'You are already using this plan', 400);
  }
  
  restaurant.requestedPlan = packageId;
  restaurant.planRequestDate = new Date();
  restaurant.planRequestStatus = 'awaiting_proof';
  restaurant.planPaymentProofPath = undefined;
  restaurant.planPaymentReferenceId = undefined;
  restaurant.planRequestRejectionReason = undefined;
  await restaurant.save();
  
  return success(res, {
    requestedPlan: plan.name,
    planRequestStatus: restaurant.planRequestStatus,
    message: 'Plan selected. Upload your payment statement to submit for verification.'
  }, 'Package request submitted');
});

/**
 * @desc    Upload payment proof for pending plan request
 * @route   POST /api/restaurant/package/payment-proof
 * @access  Private
 */
const submitPaymentProof = asyncHandler(async (req, res) => {
  if (!req.file?.path) {
    return error(res, 'Payment proof file is required', 400);
  }
  const statementReferenceId = String(req.body?.statementReferenceId || '').trim();
  if (!statementReferenceId) {
    return error(res, 'Statement reference ID is required', 400);
  }

  const restaurant = await Restaurant.findById(req.user.id);
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }
  if (!restaurant.requestedPlan) {
    return error(res, 'No plan request in progress', 400);
  }
  if (restaurant.planRequestStatus !== 'awaiting_proof') {
    return error(
      res,
      'Payment proof can only be uploaded while your request is awaiting payment proof.',
      400
    );
  }

  restaurant.planPaymentProofPath = req.file.path;
  restaurant.planPaymentReferenceId = statementReferenceId;
  restaurant.planRequestStatus = 'pending_review';
  await restaurant.save();

  const plan = await Subscription.findById(restaurant.requestedPlan).select('name');

  return success(res, {
    planRequestStatus: restaurant.planRequestStatus,
    planPaymentProofUrl: restaurant.planPaymentProofPath,
    planPaymentReferenceId: restaurant.planPaymentReferenceId,
    requestedPlanName: plan?.name
  }, 'Payment proof submitted. We will verify and activate your plan.');
});

/**
 * @desc    Get package history
 * @route   GET /api/restaurant/package/history
 * @access  Private
 */
const getPackageHistory = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const skip = (page - 1) * limit;
  
  const history = await PackageHistory.find({ restaurant: req.user.id })
    .populate('package', 'name price durationLabel')
    .populate('previousPackage', 'name')
    .populate('approvedBy', 'name email')
    .populate('invoice', 'invoiceNumber totalInclVat issuedAt transactionType vatAmount subtotalExclVat')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(parseInt(limit));
  
  const total = await PackageHistory.countDocuments({ restaurant: req.user.id });
  
  return success(res, {
    history,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / limit)
    }
  }, 'Package history retrieved');
});

/**
 * @desc    Toggle auto-renew
 * @route   PATCH /api/restaurant/package/auto-renew
 * @access  Private
 */
const toggleAutoRenew = asyncHandler(async (req, res) => {
  const { autoRenew } = req.body;
  
  if (typeof autoRenew !== 'boolean') {
    return error(res, 'autoRenew must be a boolean', 400);
  }
  
  const restaurant = await Restaurant.findById(req.user.id);
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }
  
  restaurant.autoRenew = autoRenew;
  if (!restaurant.subscription) restaurant.subscription = {};
  restaurant.subscription.autoRenew = autoRenew;
  await restaurant.save();
  
  return success(res, { autoRenew: restaurant.autoRenew }, `Auto-renew ${autoRenew ? 'enabled' : 'disabled'}`);
});

module.exports = {
  getPackageStatus,
  requestPackage,
  submitPaymentProof,
  getPackageHistory,
  toggleAutoRenew
};
