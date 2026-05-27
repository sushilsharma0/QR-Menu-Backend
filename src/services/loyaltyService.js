/**
 * Restaurant-configurable loyalty point calculation.
 */
function getLoyaltySettings(restaurant) {
  const loyalty = restaurant?.settings?.loyalty || {};
  return {
    enabled: loyalty.enabled !== false,
    pointsPerCurrencyUnit: Math.max(1, Number(loyalty.pointsPerCurrencyUnit || 50)),
    minPointsPerOrder: Math.max(0, Number(loyalty.minPointsPerOrder || 0)),
    minOrderAmount: Math.max(0, Number(loyalty.minOrderAmount || 0)),
    smsOnOrderReady: loyalty.smsOnOrderReady === true,
  };
}

function calculateLoyaltyPoints(grandTotal, restaurant) {
  const cfg = getLoyaltySettings(restaurant);
  if (!cfg.enabled) return 0;
  const total = Number(grandTotal || 0);
  if (total < cfg.minOrderAmount) return 0;
  const earned = Math.floor(total / cfg.pointsPerCurrencyUnit);
  return Math.max(cfg.minPointsPerOrder, earned);
}

module.exports = {
  getLoyaltySettings,
  calculateLoyaltyPoints,
};
