/**
 * Previously deducted inventory from menu-item recipes when orders completed.
 * Recipe-based auto-deduction is disabled: use Finance → Inventory → Raw use
 * to record material usage (stock down + ingredients expense for P&L).
 *
 * Call sites remain so POS/cashier flows stay stable; this handler is a no-op.
 */
async function applyRecipeDeductionForCompletedOrder(order, { userId, userModel }) {
  void order;
  void userId;
  void userModel;
  return { skipped: true, reason: 'recipe_inventory_disabled' };
}

module.exports = { applyRecipeDeductionForCompletedOrder };
