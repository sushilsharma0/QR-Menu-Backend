const express = require('express');
const router = express.Router();
const {
  getDashboardStats,
  getRevenueAnalytics,
  getRestaurantGrowth,
  getSubscriptionAnalytics,
  getSevenDayTrend,
} = require('../../controllers/platform/dashboardController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const checkPermission = require('../../middleware/auth/checkPermission');

// All routes require authentication
router.use(verifyToken);
router.use(requireRole('super_admin', 'admin'));
router.use(checkPermission('viewAnalytics'));

// Dashboard statistics
router.get('/stats', getDashboardStats);

// Analytics endpoints
router.get('/analytics/revenue', getRevenueAnalytics);
router.get('/analytics/restaurants', getRestaurantGrowth);
router.get('/analytics/subscriptions', getSubscriptionAnalytics);
router.get('/analytics/trend-7d', getSevenDayTrend);

module.exports = router;