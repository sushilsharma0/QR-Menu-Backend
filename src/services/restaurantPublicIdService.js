const crypto = require('crypto');
const mongoose = require('mongoose');

/**
 * Assigns a stable public restaurant id (e.g. REST-2041) for branch/staff login UX.
 * Persists when missing; safe to call on hot paths (idempotent).
 */
async function ensurePublicRestaurantId(restaurantDoc) {
  if (!restaurantDoc) return null;
  if (restaurantDoc.publicRestaurantId) return restaurantDoc;

  const Model = restaurantDoc.constructor;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const n = 1000 + crypto.randomInt(9000);
    const candidate = `REST-${n}`;
    const exists = await Model.exists({
      publicRestaurantId: candidate,
      _id: { $ne: restaurantDoc._id },
    });
    if (!exists) {
      restaurantDoc.publicRestaurantId = candidate;
      await restaurantDoc.save();
      return restaurantDoc;
    }
  }
  const fallback = `REST-${Date.now().toString(36).toUpperCase()}`;
  restaurantDoc.publicRestaurantId = fallback;
  await restaurantDoc.save();
  return restaurantDoc;
}

/**
 * Resolve restaurant from client "Restaurant ID": Mongo ObjectId or REST-xxxx.
 */
async function resolveRestaurantFromClientInput(raw, RestaurantModel = require('../models/restaurant/Restaurant')) {
  const s = String(raw || '').trim();
  if (!s) return null;

  if (mongoose.Types.ObjectId.isValid(s)) {
    let byId;
    try {
      byId = await RestaurantModel.findOne({ _id: new mongoose.Types.ObjectId(s), isDeleted: false });
    } catch {
      return null;
    }
    if (byId) return ensurePublicRestaurantId(byId);
    return null;
  }

  if (/^REST-[A-Z0-9-]+$/i.test(s)) {
    const upper = s.toUpperCase();
    const r = await RestaurantModel.findOne({ publicRestaurantId: upper, isDeleted: false });
    if (r) return ensurePublicRestaurantId(r);
    return null;
  }

  return null;
}

module.exports = {
  ensurePublicRestaurantId,
  resolveRestaurantFromClientInput,
};
