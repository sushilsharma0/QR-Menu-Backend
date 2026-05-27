const express = require('express');
const router = express.Router();
const {
  getSetupChecklist,
  getFoodCostReport,
  compareBranches,
  listDeliveryDispatch,
  patchDeliveryDispatch,
} = require('../../controllers/restaurant/insightsController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const requireRestaurantSubscriptionAccess = require('../../middleware/restaurant/requireRestaurantSubscriptionAccess');
const requireKYCVerifiedForWrites = require('../../middleware/restaurant/requireKYCVerifiedForWrites');
const requireRestaurantPlanFeatureUnlessBranch = require('../../middleware/restaurant/requireRestaurantPlanFeatureUnlessBranch');
const verifyBranchAccess = require('../../middleware/restaurant/verifyBranchAccess');
const verifyBranchModuleAccess = require('../../middleware/restaurant/verifyBranchModuleAccess');

const readers = [
  'restaurant',
  'manager',
  'branch_admin',
  'branch_manager',
  'branch_cashier',
  'accountant',
];
const writers = ['restaurant', 'branch_admin', 'branch_manager', 'manager'];

router.use(verifyToken, requireRestaurantSubscriptionAccess, requireKYCVerifiedForWrites);
router.use(verifyBranchAccess);

router.get('/setup-checklist', requireRestaurantPlanFeatureUnlessBranch('dashboard'), verifyBranchModuleAccess('dashboard'), requireRole(...readers), getSetupChecklist);
router.get('/food-cost', requireRestaurantPlanFeatureUnlessBranch('salesReports'), verifyBranchModuleAccess('salesReports'), requireRole(...readers), getFoodCostReport);
router.get('/branch-comparison', requireRestaurantPlanFeatureUnlessBranch('branches'), verifyBranchModuleAccess('branches'), requireRole(...readers), compareBranches);
router.get('/delivery-dispatch', requireRestaurantPlanFeatureUnlessBranch('orders'), verifyBranchModuleAccess('orders'), requireRole(...readers), listDeliveryDispatch);
router.patch('/delivery-dispatch/:id', requireRestaurantPlanFeatureUnlessBranch('orders'), verifyBranchModuleAccess('orders'), requireRole(...writers), patchDeliveryDispatch);

module.exports = router;
