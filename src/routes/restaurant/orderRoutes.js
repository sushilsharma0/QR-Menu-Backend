const express = require('express');
const router = express.Router();
const {
  placeOrder,
  updateOrderStatus,
  getRestaurantOrders,
  getOrderDetails,
  cancelOrder,
  getOrderStatistics
} = require('../../controllers/restaurant/orderController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const requireEmployeePasswordChanged = require('../../middleware/auth/requireEmployeePasswordChanged');
const requireRestaurantSubscriptionAccess = require('../../middleware/restaurant/requireRestaurantSubscriptionAccess');
const requireKYCVerifiedForWrites = require('../../middleware/restaurant/requireKYCVerifiedForWrites');
const requireRestaurantPlanFeatureUnlessBranch = require('../../middleware/restaurant/requireRestaurantPlanFeatureUnlessBranch');
const verifyBranchAccess = require('../../middleware/restaurant/verifyBranchAccess');
const verifyBranchModuleAccess = require('../../middleware/restaurant/verifyBranchModuleAccess');
const { strictLimiter } = require('../../middleware/rateLimiter');

// Public: place order via QR (no auth)
router.post('/place', strictLimiter, placeOrder);

// Protected routes
router.use(verifyToken);
router.use(requireEmployeePasswordChanged);
router.use(requireRestaurantSubscriptionAccess);
router.use(requireKYCVerifiedForWrites);
router.use(requireRestaurantPlanFeatureUnlessBranch('orders'));
router.use(verifyBranchAccess);
router.use(verifyBranchModuleAccess('orders'));

const orderReaders = ['restaurant', 'kitchen', 'cashier', 'branch_admin', 'branch_manager', 'branch_cashier', 'branch_kitchen'];

// Order statistics
router.get('/stats', requireRole('restaurant', 'branch_admin', 'branch_manager'), getOrderStatistics);

// Update order status (kitchen or restaurant admin)
router.patch('/:id/status', requireRole('kitchen', 'restaurant', 'branch_kitchen', 'branch_admin', 'branch_manager'), updateOrderStatus);

// Cancel order
router.patch('/:id/cancel', requireRole('restaurant', 'branch_admin', 'branch_manager'), cancelOrder);

// Get orders (restaurant admin, kitchen, cashier)
router.get('/', requireRole(...orderReaders), getRestaurantOrders);

// Get single order
router.get('/:id', requireRole(...orderReaders), getOrderDetails);

module.exports = router;
