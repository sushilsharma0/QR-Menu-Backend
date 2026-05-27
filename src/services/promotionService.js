const Promotion = require('../models/restaurant/Promotion');

const toNumber = (value) => Number(value || 0);

const calculatePromoDiscount = ({ promo, items = [], subtotal = 0 }) => {
  let eligibleAmount = subtotal;
  const promoScope = promo.scope || 'order';

  if (promoScope === 'item') {
    const targetIds = (promo.targetMenuItems || []).map((id) => id.toString());
    eligibleAmount = items.reduce((sum, item) => {
      const itemId = (item.menuItemId || item.menuItem || item._id || '').toString();
      if (!targetIds.includes(itemId)) return sum;
      const price = toNumber(item.price);
      const quantity = toNumber(item.quantity) || 1;
      return sum + price * quantity;
    }, 0);
  }

  if (eligibleAmount <= 0) return 0;

  let discount = 0;
  if (promo.discountType === 'flat') {
    discount = Math.min(toNumber(promo.discountValue), eligibleAmount);
  } else {
    discount = (eligibleAmount * toNumber(promo.discountValue)) / 100;
  }

  if (promo.maxDiscountAmount) {
    discount = Math.min(discount, toNumber(promo.maxDiscountAmount));
  }

  return Math.max(0, Number(discount.toFixed(2)));
};

const validatePromo = async ({ restaurantId, branchId, code, subtotal, items = [] }) => {
  const normalizedCode = String(code || '').trim().toUpperCase();
  if (!normalizedCode) {
    return { valid: false, message: 'Promo code is required' };
  }

  const query = {
    restaurant: restaurantId,
    code: normalizedCode,
    isDeleted: false,
    isActive: true,
  };
  if (branchId) query.branchId = branchId;

  const promo = await Promotion.findOne(query);

  if (!promo) return { valid: false, message: 'Invalid promo code' };

  const now = new Date();
  if (promo.startAt > now) return { valid: false, message: 'Promo not started yet' };
  if (promo.endAt < now) return { valid: false, message: 'Promo expired' };
  if (promo.usageLimit && promo.usedCount >= promo.usageLimit) {
    return { valid: false, message: 'Promo usage limit reached' };
  }

  if (subtotal < toNumber(promo.minOrderAmount)) {
    return {
      valid: false,
      message: `Minimum order amount is ${promo.minOrderAmount}`,
    };
  }

  const discountAmount = calculatePromoDiscount({ promo, items, subtotal });
  if (discountAmount <= 0) {
    return { valid: false, message: 'Promo is not applicable to selected items' };
  }

  return { valid: true, promo, discountAmount };
};

module.exports = {
  validatePromo,
  calculatePromoDiscount,
};
