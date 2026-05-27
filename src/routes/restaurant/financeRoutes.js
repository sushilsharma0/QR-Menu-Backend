const express = require('express');
const router = express.Router();
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const requireEmployeePasswordChanged = require('../../middleware/auth/requireEmployeePasswordChanged');
const requireRestaurantSubscriptionAccess = require('../../middleware/restaurant/requireRestaurantSubscriptionAccess');
const requireFinancePlanFeature = require('../../middleware/restaurant/requireFinancePlanFeature');
const requireFinanceAccess = require('../../middleware/restaurant/requireFinanceAccess');
const verifyBranchAccess = require('../../middleware/restaurant/verifyBranchAccess');
const verifyBranchModuleAccess = require('../../middleware/restaurant/verifyBranchModuleAccess');
const { resolveFinanceModuleKey } = require('../../constants/branchModules');
const upload = require('../../config/multer');
const c = require('../../controllers/financeController');
const erp = require('../../controllers/erpController');

router.use(verifyToken);
router.use(requireEmployeePasswordChanged);
router.use(requireRole(
  'restaurant', 'manager', 'cashier', 'admin', 'accountant',
  'branch_admin', 'branch_manager',
));
router.use(requireRestaurantSubscriptionAccess);
router.use(requireFinancePlanFeature);
router.use(verifyBranchAccess);

function financeBranchModuleGate(req, res, next) {
  const modKey = resolveFinanceModuleKey(req.path || '');
  return verifyBranchModuleAccess(modKey)(req, res, next);
}
router.use(financeBranchModuleGate);

router.get('/sales', requireFinanceAccess('sales'), c.getSales);
router.get('/sales/analytics', requireFinanceAccess('sales'), c.getSalesAnalytics);
router.get('/sales/top-items', requireFinanceAccess('sales'), c.getSalesTopItems);
router.post('/sales/sync', requireFinanceAccess('sales'), c.syncSalesFromCompletedOrders);

router.post('/expenses', requireFinanceAccess('expenses'), upload.single('receiptImage'), c.createExpense);
router.get('/expenses', requireFinanceAccess('expenses'), c.getExpenses);
router.patch('/expenses/:id', requireFinanceAccess('expenses'), upload.single('receiptImage'), c.updateExpense);
router.delete('/expenses/:id', requireFinanceAccess('expenses'), c.deleteExpense);

router.get('/profit-loss', requireFinanceAccess('reports'), c.getProfitLoss);

router.get('/tax', requireFinanceAccess('tax'), c.getTaxSettings);
router.patch('/tax', requireFinanceAccess('tax'), c.updateTaxSettings);
router.get('/tax/report', requireFinanceAccess('tax'), c.getTaxReport);

router.get('/period-locks', requireFinanceAccess('reports'), c.listFinancialPeriodLocks);
router.post('/period-locks', requireFinanceAccess('reports'), c.lockFinancialPeriod);
router.patch('/period-locks/:id/unlock', requireFinanceAccess('reports'), c.unlockFinancialPeriod);

router.get('/erp-dashboard', requireFinanceAccess('reports'), erp.getErpDashboard);
router.get('/revenue-by-channel', requireFinanceAccess('reports'), erp.getRevenueByChannel);

router.get('/budgets', requireFinanceAccess('expenses'), erp.listBudgets);
router.post('/budgets', requireFinanceAccess('expenses'), erp.upsertBudget);
router.get('/budgets/variance', requireFinanceAccess('expenses'), erp.getBudgetVariance);

router.get('/tds/settings', requireFinanceAccess('payroll'), erp.getTdsSettings);
router.patch('/tds/settings', requireFinanceAccess('payroll'), erp.updateTdsSettings);
router.get('/tds/summary', requireFinanceAccess('payroll'), erp.getTdsSummary);

router.get('/accounting/accounts', requireFinanceAccess('reports'), erp.listChartOfAccounts);
router.post('/accounting/journal-entries', requireFinanceAccess('reports'), erp.postJournalEntry);
router.get('/accounting/trial-balance', requireFinanceAccess('reports'), erp.getTrialBalance);

module.exports = router;
