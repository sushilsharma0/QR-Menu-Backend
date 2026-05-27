const Restaurant = require('../models/restaurant/Restaurant');
const { emitToRestaurant } = require('./socketService');
const { buildRestaurantAccessSnapshot } = require('./subscriptionAccessService');

async function emitSubscriptionAccessUpdated(restaurantId) {
  const restaurant = await Restaurant.findById(restaurantId).populate('currentPlan', 'name');
  if (!restaurant) return;

  const access = await buildRestaurantAccessSnapshot(restaurant);
  const planName =
    access.assignedPlanName || restaurant.currentPlan?.name || null;

  emitToRestaurant(String(restaurantId), 'subscription:access_updated', {
    ...access,
    currentPlan: restaurant.currentPlan
      ? {
          _id: restaurant.currentPlan._id,
          name: restaurant.currentPlan.name,
        }
      : null,
    planName,
  });
}

async function emitSubscriptionAccessUpdatedForRestaurants(filter = {}) {
  const restaurants = await Restaurant.find({
    isDeleted: { $ne: true },
    ...filter,
  }).select('_id');

  await Promise.all(
    restaurants.map((restaurant) => emitSubscriptionAccessUpdated(restaurant._id)),
  );

  return restaurants.length;
}

module.exports = {
  emitSubscriptionAccessUpdated,
  emitSubscriptionAccessUpdatedForRestaurants,
};
