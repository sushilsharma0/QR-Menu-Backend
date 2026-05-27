const Platform = require('../models/platform/Platform');

/**
 * Next code: EMP001, EMP002, … (based on highest existing numeric suffix).
 */
async function generateNextEmployeeCode() {
  const rows = await Platform.find({ employeeCode: { $regex: /^EMP\d+$/i } })
    .select('employeeCode')
    .lean();

  let max = 0;
  for (const row of rows) {
    const match = String(row.employeeCode || '').match(/^EMP(\d+)$/i);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `EMP${String(max + 1).padStart(3, '0')}`;
}

module.exports = { generateNextEmployeeCode };
