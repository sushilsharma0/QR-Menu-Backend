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
const c = require('../../controllers/payrollController');

router.use(verifyToken);
router.use(requireEmployeePasswordChanged);
router.use(requireRole('restaurant', 'manager', 'cashier', 'admin', 'accountant', 'branch_admin', 'branch_manager'));
router.use(requireRestaurantSubscriptionAccess);
router.use(requireRestaurantPlanFeatureUnlessBranch('payroll'));
router.use(verifyBranchAccess);
router.use(verifyBranchModuleAccess('payroll'));

router.post('/generate', requireFinanceAccess('payroll'), c.generatePayroll);
router.get('/employee-summary', requireFinanceAccess('payroll'), c.getPayrollEmployeeSummary);
router.get('/', requireFinanceAccess('payroll'), c.getPayrolls);
router.patch('/pay/:id', requireFinanceAccess('payroll'), c.payPayroll);
router.delete('/:id', requireFinanceAccess('payroll'), c.deletePayroll);
router.patch('/:id', requireFinanceAccess('payroll'), c.updatePayroll);

module.exports = router;
