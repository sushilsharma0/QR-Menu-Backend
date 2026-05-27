const mongoose = require('mongoose');

/**
 * Expense rows are normally filtered by branch. Payroll payment used to create
 * expenses without branchId (null), so strict branchId equality hid them from
 * lists and P&L. Match current branch OR payroll-sourced rows with no branch.
 */
function expenseBranchMatch(branchId) {
  if (branchId == null) return {};
  const bid =
    branchId instanceof mongoose.Types.ObjectId
      ? branchId
      : new mongoose.Types.ObjectId(String(branchId));
  return {
    $or: [
      { branchId: bid },
      {
        branchId: null,
        sourcePayrollId: { $exists: true, $ne: null },
      },
      {
        branchId: null,
        sourceInventoryLogId: { $exists: true, $ne: null },
      },
    ],
  };
}

module.exports = { expenseBranchMatch };
