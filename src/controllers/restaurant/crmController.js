const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const CustomerFeedback = require('../../models/customer/CustomerFeedback');
const CustomerIdentity = require('../../models/customer/CustomerIdentity');
const CustomerOrder = require('../../models/restaurant/CustomerOrder');
const GuestLoyalty = require('../../models/customer/GuestLoyalty');
const { success, error } = require('../../utils/apiResponse');
const resolveRestaurantId = require('../../middleware/restaurant/resolveRestaurantId');
const { escapeRegex } = require('../../utils/inputValidation');

const asObjectId = (id) => {
  if (!id) return null;
  const s = id.toString ? id.toString() : String(id);
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
};

const listFeedback = asyncHandler(async (req, res) => {
  const restaurantId = asObjectId(resolveRestaurantId(req));
  if (!restaurantId) return error(res, 'Unable to resolve restaurant', 403);

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(10, parseInt(req.query.limit, 10) || 20));
  const skip = (page - 1) * limit;
  const q = String(req.query.search || '').trim();
  const serviceRating = req.query.serviceRating;

  const filter = { restaurant: restaurantId, isActive: true };
  if (serviceRating && ['great', 'average', 'poor'].includes(serviceRating)) {
    filter.serviceRating = serviceRating;
  }
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ customerName: rx }, { comment: rx }];
  }

  const [rows, total] = await Promise.all([
    CustomerFeedback.find(filter)
      .populate('table', 'tableNumber')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    CustomerFeedback.countDocuments(filter),
  ]);

  const summary = await CustomerFeedback.aggregate([
    { $match: { restaurant: restaurantId, isActive: true } },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        avgSystem: { $avg: '$systemRating' },
        great: { $sum: { $cond: [{ $eq: ['$serviceRating', 'great'] }, 1, 0] } },
        average: { $sum: { $cond: [{ $eq: ['$serviceRating', 'average'] }, 1, 0] } },
        poor: { $sum: { $cond: [{ $eq: ['$serviceRating', 'poor'] }, 1, 0] } },
      },
    },
  ]);

  return success(
    res,
    {
      feedback: rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      summary: summary[0] || { count: 0, avgSystem: 0, great: 0, average: 0, poor: 0 },
    },
    'Feedback list',
  );
});

const patchFeedback = asyncHandler(async (req, res) => {
  const restaurantId = asObjectId(resolveRestaurantId(req));
  const { isPublic, isActive } = req.body;

  const doc = await CustomerFeedback.findOne({ _id: req.params.id, restaurant: restaurantId });
  if (!doc) return error(res, 'Feedback not found', 404);

  if (typeof isPublic === 'boolean') doc.isPublic = isPublic;
  if (typeof isActive === 'boolean') doc.isActive = isActive;
  await doc.save();

  return success(res, doc, 'Feedback updated');
});

const listCustomers = asyncHandler(async (req, res) => {
  const restaurantId = asObjectId(resolveRestaurantId(req));
  if (!restaurantId) return error(res, 'Unable to resolve restaurant', 403);

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(10, parseInt(req.query.limit, 10) || 20));
  const skip = (page - 1) * limit;
  const q = String(req.query.search || '').trim();

  const filter = { restaurant: restaurantId, isActive: true };
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ name: rx }, { email: rx }, { phone: rx }, { customerId: rx }];
  }

  const [identities, total] = await Promise.all([
    CustomerIdentity.find(filter)
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    CustomerIdentity.countDocuments(filter),
  ]);

  const guestIds = identities.flatMap((i) => [i.primaryGuestId, ...(i.linkedGuestIds || [])].filter(Boolean));

  const [orderStats, loyaltyRows] = await Promise.all([
    CustomerOrder.aggregate([
      {
        $match: {
          restaurant: restaurantId,
          guestId: { $in: guestIds },
          isActive: { $ne: false },
        },
      },
      {
        $group: {
          _id: '$guestId',
          orderCount: { $sum: 1 },
          totalSpent: { $sum: '$grandTotal' },
          lastOrderAt: { $max: '$createdAt' },
        },
      },
    ]),
    GuestLoyalty.find({ restaurant: restaurantId, guestId: { $in: guestIds } }).lean(),
  ]);

  const statsByGuest = new Map(orderStats.map((r) => [r._id, r]));
  const loyaltyByGuest = new Map(loyaltyRows.map((r) => [r.guestId, r]));

  const customers = identities.map((identity) => {
    const ids = [identity.primaryGuestId, ...(identity.linkedGuestIds || [])].filter(Boolean);
    let orderCount = 0;
    let totalSpent = 0;
    let lastOrderAt = null;
    let points = 0;
    ids.forEach((gid) => {
      const st = statsByGuest.get(gid);
      if (st) {
        orderCount += st.orderCount;
        totalSpent += st.totalSpent;
        if (!lastOrderAt || st.lastOrderAt > lastOrderAt) lastOrderAt = st.lastOrderAt;
      }
      const ly = loyaltyByGuest.get(gid);
      if (ly) points += Number(ly.points || 0);
    });
    return {
      customerId: identity.customerId,
      name: identity.name,
      email: identity.email,
      phone: identity.phone,
      orderCount,
      totalSpent: Number(totalSpent.toFixed(2)),
      lastOrderAt,
      loyaltyPoints: points,
      createdAt: identity.createdAt,
    };
  });

  return success(
    res,
    {
      customers,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    },
    'Customer directory',
  );
});

module.exports = {
  listFeedback,
  patchFeedback,
  listCustomers,
};
