const express = require('express');
const router = express.Router();
const {
  processPayment,
  processCreditPayment,
  getTransactions,
  getTransactionById,
  refundTransaction
} = require('../../controllers/restaurant/cashierController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const requireEmployeePasswordChanged = require('../../middleware/auth/requireEmployeePasswordChanged');
const requireRestaurantSubscriptionAccess = require('../../middleware/restaurant/requireRestaurantSubscriptionAccess');
const requireKYCVerifiedForWrites = require('../../middleware/restaurant/requireKYCVerifiedForWrites');
const requireRestaurantPlanFeatureUnlessBranch = require('../../middleware/restaurant/requireRestaurantPlanFeatureUnlessBranch');
const verifyBranchAccess = require('../../middleware/restaurant/verifyBranchAccess');
const verifyBranchModuleAccess = require('../../middleware/restaurant/verifyBranchModuleAccess');

router.use(
  verifyToken,
  requireEmployeePasswordChanged,
  requireRestaurantSubscriptionAccess,
  requireKYCVerifiedForWrites,
  requireRestaurantPlanFeatureUnlessBranch('cashier'),
  verifyBranchAccess,
  verifyBranchModuleAccess('customerOrders'),
  requireRole('restaurant', 'cashier', 'branch_admin', 'branch_manager', 'branch_cashier'),
);

router.post('/pay', processPayment);
router.post('/credit/pay', processCreditPayment);
router.get('/transactions', getTransactions);
router.get('/transactions/:id', getTransactionById);
router.post('/transactions/:id/refund', refundTransaction);

module.exports = router;
