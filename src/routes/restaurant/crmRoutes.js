const express = require('express');
const router = express.Router();
const {
  listFeedback,
  patchFeedback,
  listCustomers,
} = require('../../controllers/restaurant/crmController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const requireRestaurantSubscriptionAccess = require('../../middleware/restaurant/requireRestaurantSubscriptionAccess');
const requireKYCVerifiedForWrites = require('../../middleware/restaurant/requireKYCVerifiedForWrites');
const requireRestaurantPlanFeatureUnlessBranch = require('../../middleware/restaurant/requireRestaurantPlanFeatureUnlessBranch');
const verifyBranchAccess = require('../../middleware/restaurant/verifyBranchAccess');
const verifyBranchModuleAccess = require('../../middleware/restaurant/verifyBranchModuleAccess');

const readers = ['restaurant', 'manager', 'branch_admin', 'branch_manager', 'waiter', 'cashier'];
const writers = ['restaurant', 'branch_admin', 'branch_manager', 'manager'];

router.use(verifyToken, requireRestaurantSubscriptionAccess, requireKYCVerifiedForWrites, verifyBranchAccess);

router.get('/feedback', requireRestaurantPlanFeatureUnlessBranch('orders'), verifyBranchModuleAccess('orders'), requireRole(...readers), listFeedback);
router.patch('/feedback/:id', requireRestaurantPlanFeatureUnlessBranch('orders'), verifyBranchModuleAccess('orders'), requireRole(...writers), patchFeedback);
router.get('/customers', requireRestaurantPlanFeatureUnlessBranch('orders'), verifyBranchModuleAccess('orders'), requireRole(...readers), listCustomers);

module.exports = router;
