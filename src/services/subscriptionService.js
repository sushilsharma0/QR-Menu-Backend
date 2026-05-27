const Subscription = require('../models/shared/Subscription');
const Restaurant = require('../models/restaurant/Restaurant');
const PackageHistory = require('../models/shared/PackageHistory');
const notificationService = require('./notificationService');
const { InvoiceService } = require('./invoiceService');
const { logger } = require('../utils/logger');
const {
  mergeFeatureFlags,
  featureLabelsFromFlags,
  parseCustomLimits,
} = require('../utils/planFeatureHelpers');
const { emitSubscriptionAccessUpdated } = require('./subscriptionRealtimeService');
const {
  applyQualifiedReferralRewards,
  qualifyReferralReward,
} = require('./referralService');

class SubscriptionService {
  async assignPlan(restaurantId, planId, approvedBy, notes = '', options = {}) {
    const restaurant = await Restaurant.findById(restaurantId);
    const plan = await Subscription.findById(planId);
    
    if (!restaurant || !plan) {
      throw new Error('Restaurant or Plan not found');
    }

    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + plan.duration);

    const historyDoc = await PackageHistory.create({
      restaurant: restaurantId,
      assignmentKind: 'catalog',
      package: planId,
      action: restaurant.currentPlan ? 'upgraded' : 'assigned',
      previousPackage: restaurant.currentPlan,
      startDate,
      endDate,
      amount: plan.price,
      paymentMethod: options.paymentMethod || 'offline',
      approvedBy,
      notes
    });

    try {
      await InvoiceService.issueForPackageHistory({
        history: historyDoc,
        restaurant,
        plan,
        approvedBy,
      });
    } catch (err) {
      await PackageHistory.deleteOne({ _id: historyDoc._id });
      logger.error('Failed to issue subscription invoice: %s', err.message);
      throw err;
    }

    const catalogFeatureFlags = mergeFeatureFlags(plan.featureFlags);
    const catalogFeatureLabels = featureLabelsFromFlags(catalogFeatureFlags);

    restaurant.planAssignmentSource = 'catalog';
    restaurant.customPlanLabel = undefined;
    restaurant.planFeatureFlags = catalogFeatureFlags;
    restaurant.markModified('planFeatureFlags');
    restaurant.preSubscriptionFeatureGrants = undefined;
    restaurant.currentPlan = planId;
    restaurant.planStartDate = startDate;
    restaurant.planEndDate = endDate;
    restaurant.lastRenewedAt = startDate;
    restaurant.planLimits = plan.limits;
    restaurant.planFeatures = Array.from(
      new Set([...(Array.isArray(plan.features) ? plan.features : []), ...catalogFeatureLabels]),
    );
    restaurant.subscription = {
      activePlan: planId,
      status: 'active',
      activatedAt: startDate,
      expiresAt: endDate,
      autoRenew: restaurant.autoRenew,
    };
    restaurant.requestedPlan = null;
    restaurant.planRequestDate = null;
    restaurant.planRequestStatus = 'none';
    restaurant.planPaymentProofPath = undefined;
    restaurant.planPaymentReferenceId = undefined;
    restaurant.planRequestRejectionReason = undefined;
    restaurant.isActive = true;
    
    await restaurant.save();
    await emitSubscriptionAccessUpdated(restaurantId);
    await qualifyReferralReward({
      referredRestaurantId: restaurantId,
      paymentId: options.paymentId,
    });
    const refreshedRestaurant = await Restaurant.findById(restaurantId);
    await applyQualifiedReferralRewards({
      restaurant: refreshedRestaurant,
      paymentId: options.paymentId,
    });

    await notificationService.create({
      recipient: restaurantId,
      recipientModel: 'Restaurant',
      type: 'plan_approved',
      title: 'Plan Updated',
      message: `Your plan has been updated to ${plan.name}`,
      priority: 'high'
    });

    return Restaurant.findById(restaurantId);
  }

  /**
   * Super-admin custom assignment: duration, limits, and per-feature toggles (no catalog Subscription, no invoice).
   */
  async assignCustomPlan(restaurantId, payload, approvedBy, notes = '') {
    const restaurant = await Restaurant.findById(restaurantId).populate('currentPlan', 'name');
    if (!restaurant) {
      throw new Error('Restaurant not found');
    }

    if (!restaurant.canAssignCustomPlan()) {
      const planName = restaurant.currentPlan?.name || 'catalog plan';
      const ends = restaurant.planEndDate
        ? new Date(restaurant.planEndDate).toLocaleDateString('en-IN', { dateStyle: 'medium' })
        : 'unknown date';
      throw new Error(
        `This restaurant has an active subscription (${planName}) until ${ends}. Wait for it to expire or change their catalog plan from Subscriptions before assigning a custom plan.`,
      );
    }

    const durationDays = Number(payload.durationDays);
    if (!Number.isFinite(durationDays) || durationDays < 1 || durationDays > 3650) {
      throw new Error('durationDays must be between 1 and 3650');
    }

    const parsedLimits = parseCustomLimits(payload.limits);
    if (parsedLimits.error) {
      throw new Error(parsedLimits.error);
    }
    const mergedLimits = parsedLimits.limits;

    const planLabel =
      typeof payload.planLabel === 'string' && payload.planLabel.trim()
        ? payload.planLabel.trim().slice(0, 120)
        : 'Custom plan';

    const featureFlags = mergeFeatureFlags(payload.features);
    const labels = featureLabelsFromFlags(featureFlags);

    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + Math.floor(durationDays));

    const hadPriorAccess =
      Boolean(restaurant.currentPlan) || restaurant.planAssignmentSource === 'custom';

    await PackageHistory.create({
      restaurant: restaurantId,
      assignmentKind: 'custom',
      action: hadPriorAccess ? 'upgraded' : 'assigned',
      previousPackage: restaurant.planAssignmentSource === 'catalog' ? restaurant.currentPlan : undefined,
      startDate,
      endDate,
      amount: 0,
      paymentMethod: 'free',
      approvedBy,
      notes: notes || undefined,
      customSnapshot: {
        planLabel,
        durationDays: Math.floor(durationDays),
        limits: mergedLimits,
        featureFlags,
      },
    });

    restaurant.planAssignmentSource = 'custom';
    restaurant.customPlanLabel = planLabel;
    restaurant.currentPlan = null;
    restaurant.planStartDate = startDate;
    restaurant.planEndDate = endDate;
    restaurant.lastRenewedAt = startDate;
    restaurant.planLimits = mergedLimits;
    restaurant.planFeatureFlags = featureFlags;
    restaurant.markModified('planFeatureFlags');
    restaurant.planFeatures = labels;
    restaurant.preSubscriptionFeatureGrants = undefined;
    restaurant.subscription = {
      activePlan: null,
      status: 'active',
      activatedAt: startDate,
      expiresAt: endDate,
      autoRenew: restaurant.autoRenew,
    };
    restaurant.requestedPlan = null;
    restaurant.planRequestDate = null;
    restaurant.planRequestStatus = 'none';
    restaurant.planPaymentProofPath = undefined;
    restaurant.planPaymentReferenceId = undefined;
    restaurant.planRequestRejectionReason = undefined;
    restaurant.isActive = true;

    await restaurant.save();
    await emitSubscriptionAccessUpdated(restaurantId);

    await notificationService.create({
      recipient: restaurantId,
      recipientModel: 'Restaurant',
      type: 'plan_approved',
      title: 'Plan Updated',
      message: `Your restaurant has been assigned a custom plan: ${planLabel} (${Math.floor(durationDays)} days).`,
      priority: 'high',
    });

    return restaurant;
  }

  /**
   * Placeholder for scheduled renewals (extend when auto-renew is implemented).
   */
  async autoRenewExpiringSubscriptions() {
    const now = new Date();
    const restaurants = await Restaurant.find({
      planEndDate: { $exists: true, $ne: null },
      isDeleted: { $ne: true },
    }).select('_id planEndDate isActive');

    let processed = 0;
    for (const restaurant of restaurants) {
      const end = new Date(restaurant.planEndDate);
      const diffDays = Math.ceil((end.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

      if ([7, 3, 1].includes(diffDays)) {
        await notificationService.sendNotification({
          recipientType: 'restaurant',
          recipientId: restaurant._id,
          category: 'subscription',
          type: 'subscription_expiring',
          priority: diffDays === 1 ? 'urgent' : 'high',
          title: 'Subscription expiring soon',
          message: `Your subscription will expire in ${diffDays} day${diffDays > 1 ? 's' : ''}.`,
          actionUrl: '/notifications',
          metadata: { daysRemaining: diffDays },
          dedupeKey: `subscription-expiring-${diffDays}-${end.toISOString().slice(0, 10)}`,
        });
        processed += 1;
      } else if (diffDays <= 0 && restaurant.isActive) {
        await Restaurant.updateOne(
          { _id: restaurant._id },
          {
            $set: {
              'subscription.status': 'expired',
              isActive: true,
            },
          },
        );
        await notificationService.sendNotification({
          recipientType: 'restaurant',
          recipientId: restaurant._id,
          category: 'subscription',
          type: 'subscription_expired',
          priority: 'urgent',
          title: 'Subscription expired',
          message: 'Your subscription has expired. Renew now to continue full access.',
          actionUrl: '/notifications',
          dedupeKey: `subscription-expired-${end.toISOString().slice(0, 10)}`,
        });
        await emitSubscriptionAccessUpdated(restaurant._id);
        processed += 1;
      }
    }

    return { processed };
  }

  async requestPlanChange(restaurantId, requestedPlanId) {
    const restaurant = await Restaurant.findById(restaurantId);
    const requestedPlan = await Subscription.findById(requestedPlanId);
    
    if (!restaurant || !requestedPlan) {
      throw new Error('Invalid request');
    }

    restaurant.requestedPlan = requestedPlanId;
    restaurant.planRequestDate = new Date();
    await restaurant.save();

    return { message: 'Plan change request submitted' };
  }
}

module.exports = new SubscriptionService();
