const mongoose = require('mongoose');

/**
 * Inventory items are scoped by branch. Older rows may have branchId null.
 * Include those when listing / resolving items for the current branch so they
 * still appear in Finance → Inventory after branch rollout.
 */
function inventoryBranchItemFilter(branchId) {
  if (branchId == null) return {};
  const bid =
    branchId instanceof mongoose.Types.ObjectId
      ? branchId
      : new mongoose.Types.ObjectId(String(branchId));
  return {
    $or: [{ branchId: bid }, { branchId: null }],
  };
}

module.exports = { inventoryBranchItemFilter };
