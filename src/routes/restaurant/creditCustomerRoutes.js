const express = require('express');
const router = express.Router();
const {
  listCreditCustomers,
  getCreditSummary,
  getCreditCustomerLedger,
  payCreditCustomerOrder,
  patchCreditCustomer,
} = require('../../controllers/restaurant/creditCustomerController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const requireEmployeePasswordChanged = require('../../middleware/auth/requireEmployeePasswordChanged');
const requireRestaurantSubscriptionAccess = require('../../middleware/restaurant/requireRestaurantSubscriptionAccess');
const requireKYCVerifiedForWrites = require('../../middleware/restaurant/requireKYCVerifiedForWrites');
const requireRestaurantPlanFeatureUnlessBranch = require('../../middleware/restaurant/requireRestaurantPlanFeatureUnlessBranch');
const verifyBranchAccess = require('../../middleware/restaurant/verifyBranchAccess');
const verifyBranchModuleAccess = require('../../middleware/restaurant/verifyBranchModuleAccess');

const creditReadRoles = requireRole('restaurant', 'admin', 'manager', 'cashier', 'accountant', 'branch_admin', 'branch_manager', 'branch_cashier');
const creditApproveRoles = requireRole('restaurant', 'admin', 'manager', 'branch_admin', 'branch_manager');
const creditPayRoles = requireRole('restaurant', 'admin', 'manager', 'cashier', 'branch_admin', 'branch_manager', 'branch_cashier');

router.use(verifyToken);
router.use(requireEmployeePasswordChanged);
router.use(requireRestaurantSubscriptionAccess);
router.use(requireKYCVerifiedForWrites);
router.use(requireRestaurantPlanFeatureUnlessBranch('creditCustomers'));
router.use(verifyBranchAccess);
router.use(verifyBranchModuleAccess('creditCustomers'));

router.get('/', creditReadRoles, listCreditCustomers);
router.get('/summary', creditReadRoles, getCreditSummary);
router.get('/:id/ledger', creditReadRoles, getCreditCustomerLedger);
router.post('/:id/orders/:orderId/pay', creditPayRoles, payCreditCustomerOrder);
router.patch('/:id', creditApproveRoles, patchCreditCustomer);

module.exports = router;
