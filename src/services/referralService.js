const crypto = require('crypto');
const Restaurant = require('../models/restaurant/Restaurant');
const RestaurantReferral = require('../models/restaurant/RestaurantReferral');
const Platform = require('../models/platform/Platform');
const notificationService = require('./notificationService');
const { emitSubscriptionAccessUpdated } = require('./subscriptionRealtimeService');
const { logger } = require('../utils/logger');
const { mongoOrForBillingAdminsNotifications } = require('../constants/platformPermissions');

const REFERRAL_REWARD_DAYS = Number.parseInt(process.env.RESTAURANT_REFERRAL_REWARD_DAYS, 10) || 30;

const normalizeReferralCode = (value) =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

const addDaysFromBase = (date, days) => {
  const base = date && new Date(date) > new Date() ? new Date(date) : new Date();
  base.setDate(base.getDate() + days);
  return base;
};

async function generateUniqueReferralCode(name = '') {
  const prefix = normalizeReferralCode(name).slice(0, 4) || 'REST';

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = `${prefix}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const existing = await Restaurant.findOne({ referralCode: code }).select('_id').lean();
    if (!existing) return code;
  }

  throw new Error('Unable to generate referral code');
}

async function ensureRestaurantReferralCode(restaurant) {
  if (!restaurant) return '';
  if (restaurant.referralCode) return restaurant.referralCode;

  restaurant.referralCode = await generateUniqueReferralCode(restaurant.name);
  await restaurant.save();
  return restaurant.referralCode;
}

async function findReferrerByCode(rawCode) {
  const referralCode = normalizeReferralCode(rawCode);
  if (!referralCode) return null;
  return Restaurant.findOne({
    referralCode,
    isDeleted: { $ne: true },
    isActive: true,
    emailVerified: true,
  }).select('_id name referralCode planEndDate');
}

async function notifyPlatformAdmins({ title, message, referral, priority = 'medium' }) {
  const admins = await Platform.find({
    isActive: true,
    $or: mongoOrForBillingAdminsNotifications(),
  }).select('_id');

  return notificationService.sendBulkNotifications(
    admins.map((admin) => ({
      recipientType: 'platform',
      recipientId: admin._id,
      category: 'referral',
      type: 'restaurant_referral',
      priority,
      title,
      message,
      actionUrl: '/platform/restaurants',
      relatedEntity: { entityType: 'RestaurantReferral', entityId: referral._id },
      metadata: {
        referralId: String(referral._id),
        referrerRestaurantId: String(referral.referrerRestaurant),
        referredRestaurantId: String(referral.referredRestaurant),
      },
    })),
  );
}

async function notifyReferralCreated({ referral, referrer, referred }) {
  if (!referral || !referrer || !referred) return [];

  return Promise.all([
    notificationService.sendNotification({
      recipientType: 'restaurant',
      recipientId: referrer._id,
      category: 'referral',
      type: 'restaurant_referral_pending',
      priority: 'high',
      title: 'Referral code used',
      message: `${referred.name} used your referral code. Both restaurants will get 1 extra month after they activate their first plan.`,
      actionUrl: '/notifications',
      relatedEntity: { entityType: 'RestaurantReferral', entityId: referral._id },
    }),
    notificationService.sendNotification({
      recipientType: 'restaurant',
      recipientId: referred._id,
      category: 'referral',
      type: 'restaurant_referral_pending',
      priority: 'high',
      title: 'Referral code applied',
      message: `Referral from ${referrer.name} is saved. Both restaurants will get 1 extra month after your first plan is activated.`,
      actionUrl: '/notifications',
      relatedEntity: { entityType: 'RestaurantReferral', entityId: referral._id },
    }),
    notifyPlatformAdmins({
      referral,
      priority: 'medium',
      title: 'Restaurant referral created',
      message: `${referred.name} registered using ${referrer.name}'s referral code.`,
    }),
  ]);
}

async function qualifyReferralReward({ referredRestaurantId, paymentId } = {}) {
  const referral = await RestaurantReferral.findOne({
    referredRestaurant: referredRestaurantId,
    status: 'pending',
  });
  if (!referral) return null;

  const [referrer, referred] = await Promise.all([
    Restaurant.findById(referral.referrerRestaurant),
    Restaurant.findById(referral.referredRestaurant),
  ]);

  if (!referrer || !referred || String(referrer._id) === String(referred._id)) {
    referral.status = 'cancelled';
    referral.notes = 'Referral reward cancelled because restaurant records were invalid.';
    await referral.save();
    return null;
  }

  const rewardDays = referral.rewardDays || REFERRAL_REWARD_DAYS;
  const referredPrevious = referred.planEndDate || null;
  const referredNewEnd = addDaysFromBase(referred.planEndDate, rewardDays);

  referred.planEndDate = referredNewEnd;
  referred.lastRenewedAt = new Date();
  referred.subscription = {
    ...(referred.subscription || {}),
    status: 'active',
    expiresAt: referredNewEnd,
    autoRenew: referred.autoRenew,
  };

  referral.status = 'qualified';
  referral.qualifiedAt = new Date();
  referral.referredAwardedAt = new Date();
  referral.activatedByPayment = paymentId || undefined;
  referral.referredPreviousPlanEndDate = referredPrevious || undefined;
  referral.referredNewPlanEndDate = referredNewEnd;

  await Promise.all([referred.save(), referral.save()]);

  await Promise.all([
    emitSubscriptionAccessUpdated(referred._id),
    notificationService.sendNotification({
      recipientType: 'restaurant',
      recipientId: referrer._id,
      category: 'subscription',
      type: 'referral_reward_qualified',
      priority: 'high',
      title: 'Referral reward ready',
      message: `${referred.name} activated their first plan. Your ${rewardDays}-day referral reward will be added when you activate your next plan.`,
      actionUrl: '/notifications',
      relatedEntity: { entityType: 'RestaurantReferral', entityId: referral._id },
    }),
    notificationService.sendNotification({
      recipientType: 'restaurant',
      recipientId: referred._id,
      category: 'subscription',
      type: 'referral_reward',
      priority: 'high',
      title: 'Referral reward added',
      message: `Your referral code reward is active. We added ${rewardDays} free days to your subscription.`,
      actionUrl: '/notifications',
      relatedEntity: { entityType: 'RestaurantReferral', entityId: referral._id },
    }),
    notifyPlatformAdmins({
      referral,
      priority: 'high',
      title: 'Referral reward qualified',
      message: `${referred.name} received ${rewardDays} free days. ${referrer.name}'s ${rewardDays}-day reward will apply on their next plan activation.`,
    }),
  ]);

  logger.info(
    'Referral reward qualified: referrer=%s referred=%s days=%s',
    referrer._id,
    referred._id,
    rewardDays,
  );

  return referral;
}

async function applyQualifiedReferralRewards({ restaurant, paymentId } = {}) {
  if (!restaurant?._id) return [];

  const referrals = await RestaurantReferral.find({
    referrerRestaurant: restaurant._id,
    status: 'qualified',
  }).populate('referredRestaurant', 'name');

  if (!referrals.length) return [];

  const totalRewardDays = referrals.reduce(
    (sum, referral) => sum + Number(referral.rewardDays || REFERRAL_REWARD_DAYS),
    0,
  );
  const previousEndDate = restaurant.planEndDate || null;
  const newEndDate = addDaysFromBase(restaurant.planEndDate, totalRewardDays);

  restaurant.planEndDate = newEndDate;
  restaurant.lastRenewedAt = new Date();
  restaurant.subscription = {
    ...(restaurant.subscription || {}),
    status: 'active',
    expiresAt: newEndDate,
    autoRenew: restaurant.autoRenew,
  };

  for (const referral of referrals) {
    referral.status = 'rewarded';
    referral.referrerAwardedAt = new Date();
    referral.awardedAt = new Date();
    referral.activatedByPayment = referral.activatedByPayment || paymentId || undefined;
    referral.referrerPreviousPlanEndDate = previousEndDate || undefined;
    referral.referrerNewPlanEndDate = newEndDate;
  }

  await Promise.all([restaurant.save(), ...referrals.map((referral) => referral.save())]);
  await emitSubscriptionAccessUpdated(restaurant._id);

  await Promise.all([
    notificationService.sendNotification({
      recipientType: 'restaurant',
      recipientId: restaurant._id,
      category: 'subscription',
      type: 'referral_reward',
      priority: 'high',
      title: 'Referral reward added',
      message: `We added ${totalRewardDays} free day${totalRewardDays === 1 ? '' : 's'} to your new plan from referral rewards.`,
      actionUrl: '/notifications',
      relatedEntity: { entityType: 'RestaurantReferral', entityId: referrals[0]._id },
    }),
    notifyPlatformAdmins({
      referral: referrals[0],
      priority: 'high',
      title: 'Referral reward applied',
      message: `${restaurant.name} received ${totalRewardDays} free day${totalRewardDays === 1 ? '' : 's'} on their newly activated plan.`,
    }),
  ]);

  logger.info(
    'Referral rewards applied: restaurant=%s days=%s count=%s',
    restaurant._id,
    totalRewardDays,
    referrals.length,
  );

  return referrals;
}

module.exports = {
  REFERRAL_REWARD_DAYS,
  normalizeReferralCode,
  generateUniqueReferralCode,
  ensureRestaurantReferralCode,
  findReferrerByCode,
  notifyReferralCreated,
  qualifyReferralReward,
  applyQualifiedReferralRewards,
};
