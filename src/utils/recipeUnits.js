const InventoryItem = require('../models/restaurant/InventoryItem');

const UNITS = InventoryItem.INVENTORY_UNITS;

/**
 * @param {string} fromUnit
 * @param {string} toUnit
 */
function canConvert(fromUnit, toUnit) {
  if (fromUnit === toUnit) return true;
  // mass family: kilograms ↔ grams
  const mass = new Set(['kg', 'gram']);
  if (mass.has(fromUnit) && mass.has(toUnit)) return true;
  // volume family: liter ↔ ml
  const volume = new Set(['liter', 'ml']);
  if (volume.has(fromUnit) && volume.has(toUnit)) return true;
  return false;
}

/**
 * Convert quantity from fromUnit to toUnit (both must be compatible).
 * @param {number} qty
 * @param {string} fromUnit
 * @param {string} toUnit
 */
function convertQuantity(qty, fromUnit, toUnit) {
  if (fromUnit === toUnit) return qty;
  if (fromUnit === 'kg' && toUnit === 'gram') return qty * 1000;
  if (fromUnit === 'gram' && toUnit === 'kg') return qty / 1000;
  if (fromUnit === 'liter' && toUnit === 'ml') return qty * 1000;
  if (fromUnit === 'ml' && toUnit === 'liter') return qty / 1000;
  throw new Error('incompatible_units');
}

/**
 * Express recipe line quantity in the inventory item's native unit for stock deduction.
 * @param {number} quantity
 * @param {string} lineUnit
 * @param {string} inventoryUnit
 * @returns {{ ok: true, value: number } | { ok: false, code: string, message?: string }}
 */
function quantityInInventoryNativeUnit(quantity, lineUnit, inventoryUnit) {
  const lu = String(lineUnit || '').trim();
  const iu = String(inventoryUnit || '').trim();
  if (!UNITS.includes(lu)) {
    return { ok: false, code: 'invalid_line_unit', message: `Invalid unit: ${lu}` };
  }
  if (!UNITS.includes(iu)) {
    return { ok: false, code: 'invalid_inventory_unit' };
  }
  if (iu === 'other' && lu !== 'other') {
    return {
      ok: false,
      code: 'unit_must_match_inventory',
      message: 'For inventory items with unit "other", recipe unit must also be "other"',
    };
  }
  if (!canConvert(lu, iu)) {
    return {
      ok: false,
      code: 'unit_mismatch',
      message: `Recipe unit "${lu}" cannot be used with inventory stored in "${iu}"`,
    };
  }
  let native;
  try {
    native = convertQuantity(Number(quantity), lu, iu);
  } catch {
    return { ok: false, code: 'convert_failed' };
  }
  if (!Number.isFinite(native) || native <= 0) {
    return { ok: false, code: 'invalid_quantity', message: 'Quantity must be a positive number' };
  }
  return { ok: true, value: native };
}

module.exports = {
  UNITS,
  quantityInInventoryNativeUnit,
};
