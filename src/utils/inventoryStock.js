/**
 * Shared inventory stock & cost helpers.
 */

function roundQty(n) {
  return Number(Number(n || 0).toFixed(6));
}

function roundCost(n) {
  return Number(Number(n || 0).toFixed(4));
}

/** Weighted average cost when adding a purchase batch. */
function computeWeightedAverageCost(oldQty, oldCost, addQty, addCost) {
  const oq = Math.max(0, Number(oldQty) || 0);
  const oc = Math.max(0, Number(oldCost) || 0);
  const aq = Math.max(0, Number(addQty) || 0);
  const ac = Math.max(0, Number(addCost) || 0);
  if (aq <= 0) return roundCost(oc);
  if (oq <= 0) return roundCost(ac);
  return roundCost((oq * oc + aq * ac) / (oq + aq));
}

/** Replace one purchase line's contribution in the running average. */
function replacePurchaseInAverage(currentQty, currentAvg, oldQty, oldCost, newQty, newCost) {
  const cq = Math.max(0, Number(currentQty) || 0);
  const ca = Math.max(0, Number(currentAvg) || 0);
  const oq = Math.max(0, Number(oldQty) || 0);
  const oc = Math.max(0, Number(oldCost) || 0);
  const nq = Math.max(0, Number(newQty) || 0);
  const nc = Math.max(0, Number(newCost) || 0);
  const newTotalQty = roundQty(cq - oq + nq);
  if (newTotalQty <= 0) return roundCost(nc || ca);
  const currentVal = cq * ca;
  const newVal = currentVal - oq * oc + nq * nc;
  return roundCost(newVal / newTotalQty);
}

/** Remove a purchase batch from the running average (on delete). */
function removePurchaseFromAverage(currentQty, currentAvg, removeQty, removeCost) {
  return replacePurchaseInAverage(currentQty, currentAvg, removeQty, removeCost, 0, 0);
}

function validatePositiveQuantity(q, label = 'quantity') {
  const n = Number(q);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, message: `${label} must be a positive number` };
  }
  return { ok: true, value: roundQty(n) };
}

function validateNonNegativeQuantity(q, label = 'quantity') {
  const n = Number(q);
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, message: `${label} must be zero or greater` };
  }
  return { ok: true, value: roundQty(n) };
}

function insufficientStockError(available, requested, unit = '') {
  const u = unit ? ` ${unit}` : '';
  return `Insufficient stock: only ${roundQty(available)}${u} available, requested ${roundQty(requested)}${u}`;
}

module.exports = {
  roundQty,
  roundCost,
  computeWeightedAverageCost,
  replacePurchaseInAverage,
  removePurchaseFromAverage,
  validatePositiveQuantity,
  validateNonNegativeQuantity,
  insufficientStockError,
};
