const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Promotion = require('../../models/restaurant/Promotion');
const MenuItem = require('../../models/restaurant/MenuItem');
const Restaurant = require('../../models/restaurant/Restaurant');
const { success, error } = require('../../utils/apiResponse');
const resolveRestaurantId = require('../../middleware/restaurant/resolveRestaurantId');
const { resolveCustomerMenuBranchId } = require('../../services/branchService');
const { readString } = require('../../utils/inputValidation');

const asObjectId = (id) => {
  if (!id) return null;
  const s = id.toString ? id.toString() : String(id);
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
};

function promoScope(req) {
  const restaurantId = asObjectId(resolveRestaurantId(req));
  const branchId = asObjectId(req.branchId);
  return { restaurantId, branchId };
}

const getPromotions = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = promoScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve promotion scope', 403);

  const promotions = await Promotion.find({
    restaurant: restaurantId,
    branchId,
    isDeleted: false,
  })
    .populate('targetMenuItems', 'name')
    .sort({ createdAt: -1 });

  return success(res, promotions, 'Promotions retrieved');
});

const createPromotion = asyncHandler(async (req, res) => {
  const {
    name,
    code,
    discountType,
    discountValue,
    scope = 'order',
    targetMenuItems = [],
    minOrderAmount = 0,
    maxDiscountAmount = null,
    startAt,
    endAt,
    usageLimit = null,
    bannerText = '',
    bannerColor = '#f97316',
    isActive = true,
  } = req.body;

  const { restaurantId, branchId } = promoScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve promotion scope', 403);

  if (!name || !code || !discountType || !discountValue || !startAt || !endAt) {
    return error(res, 'Required fields are missing', 400);
  }

  if (!['flat', 'percent'].includes(discountType)) {
    return error(res, 'Invalid discount type', 400);
  }

  if (!['order', 'item'].includes(scope)) {
    return error(res, 'Invalid promo scope', 400);
  }

  if (scope === 'item' && (!Array.isArray(targetMenuItems) || targetMenuItems.length === 0)) {
    return error(res, 'Please select menu items for item-level promo', 400);
  }

  if (scope === 'item') {
    const validItems = await MenuItem.countDocuments({
      _id: { $in: targetMenuItems },
      restaurant: restaurantId,
      branchId,
      isDeleted: false,
    });
    if (validItems !== targetMenuItems.length) {
      return error(res, 'Invalid menu items selected', 400);
    }
  }

  const promo = await Promotion.create({
    restaurant: restaurantId,
    branchId,
    name,
    code: String(code).trim().toUpperCase(),
    discountType,
    discountValue: Number(discountValue),
    scope,
    targetMenuItems: scope === 'item' ? targetMenuItems : [],
    minOrderAmount: Number(minOrderAmount) || 0,
    maxDiscountAmount: maxDiscountAmount ? Number(maxDiscountAmount) : null,
    startAt,
    endAt,
    usageLimit: usageLimit ? Number(usageLimit) : null,
    bannerText,
    bannerColor,
    isActive: Boolean(isActive),
  });

  return success(res, promo, 'Promotion created', 201);
});

const updatePromotion = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = promoScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve promotion scope', 403);

  const promo = await Promotion.findOne({
    _id: req.params.id,
    restaurant: restaurantId,
    branchId,
    isDeleted: false,
  });

  if (!promo) return error(res, 'Promotion not found', 404);

  const body = req.body || {};
  const allowedFields = [
    'name',
    'code',
    'discountType',
    'discountValue',
    'scope',
    'targetMenuItems',
    'minOrderAmount',
    'maxDiscountAmount',
    'startAt',
    'endAt',
    'usageLimit',
    'bannerText',
    'bannerColor',
    'isActive',
  ];
  const updates = {};
  allowedFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(body, field)) updates[field] = body[field];
  });

  if (updates.name !== undefined) {
    updates.name = readString(updates.name, { max: 120 });
    if (!updates.name) return error(res, 'Invalid promotion name', 400);
  }
  if (updates.code !== undefined) {
    updates.code = readString(updates.code, { max: 40 })?.toUpperCase();
    if (!updates.code) return error(res, 'Invalid promotion code', 400);
  }
  if (updates.bannerText !== undefined) updates.bannerText = String(updates.bannerText || '').slice(0, 240);
  if (updates.bannerColor !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(updates.bannerColor))) {
    return error(res, 'Invalid banner color', 400);
  }
  if (updates.discountType !== undefined && !['flat', 'percent'].includes(updates.discountType)) {
    return error(res, 'Invalid discount type', 400);
  }
  if (updates.scope !== undefined && !['order', 'item'].includes(updates.scope)) {
    return error(res, 'Invalid promo scope', 400);
  }
  ['discountValue', 'minOrderAmount', 'maxDiscountAmount', 'usageLimit'].forEach((field) => {
    if (updates[field] !== undefined && updates[field] !== null && updates[field] !== '') {
      updates[field] = Number(updates[field]);
    }
  });
  if (updates.discountValue !== undefined && !Number.isFinite(updates.discountValue)) {
    return error(res, 'Invalid discount value', 400);
  }
  if (updates.isActive !== undefined) updates.isActive = updates.isActive === true || updates.isActive === 'true';
  if (updates.startAt !== undefined) updates.startAt = new Date(updates.startAt);
  if (updates.endAt !== undefined) updates.endAt = new Date(updates.endAt);

  if (updates.scope === 'item') {
    if (!Array.isArray(updates.targetMenuItems) || updates.targetMenuItems.length === 0) {
      return error(res, 'Please select menu items for item-level promo', 400);
    }
    const validItems = await MenuItem.countDocuments({
      _id: { $in: updates.targetMenuItems },
      restaurant: restaurantId,
      branchId,
      isDeleted: false,
    });
    if (validItems !== updates.targetMenuItems.length) {
      return error(res, 'Invalid menu items selected', 400);
    }
  }

  Object.assign(promo, updates);
  await promo.save();
  return success(res, promo, 'Promotion updated');
});

const deletePromotion = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = promoScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve promotion scope', 403);

  const promo = await Promotion.findOne({
    _id: req.params.id,
    restaurant: restaurantId,
    branchId,
    isDeleted: false,
  });
  if (!promo) return error(res, 'Promotion not found', 404);

  promo.isDeleted = true;
  await promo.save();
  return success(res, null, 'Promotion deleted');
});

const getPublicPromotionBanners = asyncHandler(async (req, res) => {
  const { restaurantSlug } = req.params;
  const restaurant = await Restaurant.findOne({
    slug: restaurantSlug,
    isActive: true,
    isDeleted: false,
  });
  if (!restaurant) return error(res, 'Restaurant not found', 404);

  const branchId = await resolveCustomerMenuBranchId(restaurant._id, {
    qrToken: req.query.qrToken,
    branchId: req.query.branchId,
  });
  if (!branchId) return error(res, 'Unable to resolve branch for promotions', 400);

  const now = new Date();
  const promotions = await Promotion.find({
    restaurant: restaurant._id,
    branchId,
    isDeleted: false,
    isActive: true,
    startAt: { $lte: now },
    endAt: { $gte: now },
    bannerText: { $ne: '' },
  })
    .select('name code bannerText bannerColor discountType discountValue minOrderAmount endAt')
    .sort({ endAt: 1 });

  return success(res, promotions, 'Promotion banners retrieved');
});

module.exports = {
  getPromotions,
  createPromotion,
  updatePromotion,
  deletePromotion,
  getPublicPromotionBanners,
};
