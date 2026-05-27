const express = require('express');
const router = express.Router();
const {
  getDashboardStats,
  getSalesAnalytics,
  getPopularItems,
  getOrderStatusStats
} = require('../../controllers/restaurant/dashboardController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const requireRestaurantSubscriptionAccess = require('../../middleware/restaurant/requireRestaurantSubscriptionAccess');
const requireKYCVerifiedForWrites = require('../../middleware/restaurant/requireKYCVerifiedForWrites');
const requireRestaurantPlanFeatureUnlessBranch = require('../../middleware/restaurant/requireRestaurantPlanFeatureUnlessBranch');
const verifyBranchAccess = require('../../middleware/restaurant/verifyBranchAccess');
const verifyBranchModuleAccess = require('../../middleware/restaurant/verifyBranchModuleAccess');

const branchDashboardRoles = [
  'restaurant',
  'branch_admin',
  'branch_manager',
  'branch_cashier',
  'branch_waiter',
  'branch_kitchen',
  'manager',
  'admin',
  'accountant',
];

router.use(verifyToken, requireRole(...branchDashboardRoles));
router.use(requireRestaurantSubscriptionAccess);
router.use(requireKYCVerifiedForWrites);
router.use(requireRestaurantPlanFeatureUnlessBranch('dashboard'));
router.use(verifyBranchAccess);

router.get('/stats', verifyBranchModuleAccess('dashboard'), getDashboardStats);
router.get('/analytics/sales', verifyBranchModuleAccess('salesReports'), getSalesAnalytics);
router.get('/analytics/popular-items', verifyBranchModuleAccess('salesReports'), getPopularItems);
router.get('/analytics/order-status', verifyBranchModuleAccess('salesReports'), getOrderStatusStats);

module.exports = router;
