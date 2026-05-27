const ChartOfAccount = require('../models/restaurant/ChartOfAccount');

const DEFAULT_COA = [
  { code: '1000', name: 'Cash', type: 'asset' },
  { code: '1200', name: 'Inventory', type: 'asset' },
  { code: '1300', name: 'Accounts Receivable', type: 'asset' },
  { code: '2000', name: 'Accounts Payable', type: 'liability' },
  { code: '2100', name: 'TDS Payable', type: 'liability' },
  { code: '3000', name: 'Owner Equity', type: 'equity' },
  { code: '4000', name: 'Sales Revenue', type: 'revenue' },
  { code: '5000', name: 'Cost of Goods Sold', type: 'expense' },
  { code: '5100', name: 'Payroll Expense', type: 'expense' },
  { code: '5200', name: 'Operating Expenses', type: 'expense' },
];

async function ensureDefaultCoa(restaurantId) {
  const count = await ChartOfAccount.countDocuments({ restaurantId, isDeleted: false });
  if (count > 0) return;
  await ChartOfAccount.insertMany(
    DEFAULT_COA.map((row) => ({
      ...row,
      restaurantId,
      isSystem: true,
    })),
  );
}

module.exports = { ensureDefaultCoa, DEFAULT_COA };
