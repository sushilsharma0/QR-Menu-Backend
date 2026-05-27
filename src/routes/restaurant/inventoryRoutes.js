const express = require('express');
const router = express.Router();
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const requireEmployeePasswordChanged = require('../../middleware/auth/requireEmployeePasswordChanged');
const requireRestaurantSubscriptionAccess = require('../../middleware/restaurant/requireRestaurantSubscriptionAccess');
const requireRestaurantPlanFeatureUnlessBranch = require('../../middleware/restaurant/requireRestaurantPlanFeatureUnlessBranch');
const requireFinanceAccess = require('../../middleware/restaurant/requireFinanceAccess');
const verifyBranchAccess = require('../../middleware/restaurant/verifyBranchAccess');
const verifyBranchModuleAccess = require('../../middleware/restaurant/verifyBranchModuleAccess');
const c = require('../../controllers/financeController');
const erp = require('../../controllers/erpController');

router.use(verifyToken);
router.use(requireEmployeePasswordChanged);
router.use(requireRole(
  'restaurant', 'manager', 'cashier', 'admin', 'accountant',
  'branch_admin', 'branch_manager',
));
router.use(requireRestaurantSubscriptionAccess);
router.use(requireRestaurantPlanFeatureUnlessBranch('inventory'));
router.use(verifyBranchAccess);
router.use(verifyBranchModuleAccess('inventory'));

router.get('/suppliers', requireFinanceAccess('inventory'), erp.listSuppliers);
router.post('/suppliers', requireFinanceAccess('inventory'), erp.createSupplier);
router.patch('/suppliers/:id', requireFinanceAccess('inventory'), erp.updateSupplier);
router.patch('/suppliers/:id/verify', requireFinanceAccess('inventory'), erp.verifySupplier);
router.delete('/suppliers/:id', requireFinanceAccess('inventory'), erp.deleteSupplier);

router.get('/reports/summary', requireFinanceAccess('inventory'), erp.getInventoryReportSummary);
router.get('/transactions', requireFinanceAccess('inventory'), erp.listInventoryLogs);
router.post('/movements', requireFinanceAccess('inventory'), erp.postInventoryWastageOrAdjustment);
router.patch('/movements/:id', requireFinanceAccess('inventory'), erp.updateInventoryMovement);
router.delete('/movements/:id', requireFinanceAccess('inventory'), erp.deleteInventoryMovement);

router.get('/purchases', requireFinanceAccess('inventory'), erp.listInventoryPurchases);
router.post('/purchases', requireFinanceAccess('inventory'), c.addInventoryPurchase);
router.patch('/purchases/:id', requireFinanceAccess('inventory'), c.updateInventoryPurchase);
router.delete('/purchases/:id', requireFinanceAccess('inventory'), c.deleteInventoryPurchase);

router.get('/cash-book', requireFinanceAccess('inventory'), c.getCashBookBalances);
router.patch('/cash-book', requireFinanceAccess('inventory'), c.patchCashBookBalances);

router.post('/', requireFinanceAccess('inventory'), c.createInventoryItem);
router.get('/', requireFinanceAccess('inventory'), c.getInventoryItems);
router.patch('/:id', requireFinanceAccess('inventory'), c.updateInventoryItem);
router.delete('/:id', requireFinanceAccess('inventory'), c.deleteInventoryItem);

module.exports = router;
