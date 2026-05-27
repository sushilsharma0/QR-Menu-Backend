const { DEFAULT_CURRENCY_SYMBOL } = require('../config/currencyDefaults');

const roundMoney = (n) => Math.round(Number(n) * 100) / 100;

function totalFromExVat(priceExclVat, vatPct) {
  const sub = roundMoney(priceExclVat);
  const rate = Number(vatPct) || 0;
  const vat = roundMoney((sub * rate) / 100);
  return roundMoney(sub + vat);
}

function exVatFromTotal(totalInclVat, vatPct) {
  const t = roundMoney(totalInclVat);
  const rate = Number(vatPct) || 0;
  if (rate <= 0) return t;
  return roundMoney(t / (1 + rate / 100));
}

/**
 * Public/display breakdown for a plan doc + current billing settings.
 */
function breakdownFromPlan(plan, settings) {
  const vatRate = Number(settings?.vatRatePercent) || 0;
  const sym = settings?.currencySymbol || DEFAULT_CURRENCY_SYMBOL;

  const hasEx = plan.priceExclVat != null && plan.priceExclVat !== '';
  const hasTotal = plan.price != null && plan.price !== '';

  if (hasEx && hasTotal) {
    const priceExclVat = roundMoney(plan.priceExclVat);
    const totalInclVat = roundMoney(plan.price);
    const vatAmount = roundMoney(totalInclVat - priceExclVat);
    return {
      priceExclVat,
      vatRatePercent: vatRate,
      vatAmount,
      totalInclVat,
      currencySymbol: sym,
    };
  }

  if (hasTotal) {
    const totalInclVat = roundMoney(plan.price);
    const priceExclVat = exVatFromTotal(totalInclVat, vatRate);
    const vatAmount = roundMoney(totalInclVat - priceExclVat);
    return {
      priceExclVat,
      vatRatePercent: vatRate,
      vatAmount,
      totalInclVat,
      currencySymbol: sym,
    };
  }

  if (hasEx) {
    const priceExclVat = roundMoney(plan.priceExclVat);
    const totalInclVat = totalFromExVat(priceExclVat, vatRate);
    const vatAmount = roundMoney(totalInclVat - priceExclVat);
    return {
      priceExclVat,
      vatRatePercent: vatRate,
      vatAmount,
      totalInclVat,
      currencySymbol: sym,
    };
  }

  return {
    priceExclVat: 0,
    vatRatePercent: vatRate,
    vatAmount: 0,
    totalInclVat: 0,
    currencySymbol: sym,
  };
}

function attachPricingToPlans(plans, settings) {
  return plans.map((p) => {
    const plain = p.toObject ? p.toObject() : { ...p };
    return {
      ...plain,
      pricing: breakdownFromPlan(plain, settings),
    };
  });
}

module.exports = {
  roundMoney,
  totalFromExVat,
  exVatFromTotal,
  breakdownFromPlan,
  attachPricingToPlans,
};
