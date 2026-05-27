const express = require('express');
const router = express.Router();
const {
  createOrder,
  getOrderByQRToken,
  getRestaurantOrders,
  getOrderDetails,
  updateOrderStatus,
  updateOrderItemKitchenStatus,
  cancelOrder,
  getOrderStatistics,
  getOrderActivityReport,
} = require('../../controllers/restaurant/customerOrderController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const requireEmployeePasswordChanged = require('../../middleware/auth/requireEmployeePasswordChanged');
const requireRestaurantSubscriptionAccess = require('../../middleware/restaurant/requireRestaurantSubscriptionAccess');
const requireKYCVerifiedForWrites = require('../../middleware/restaurant/requireKYCVerifiedForWrites');
const requireRestaurantPlanFeatureUnlessBranch = require('../../middleware/restaurant/requireRestaurantPlanFeatureUnlessBranch');
const verifyBranchAccess = require('../../middleware/restaurant/verifyBranchAccess');
const verifyBranchModuleAccess = require('../../middleware/restaurant/verifyBranchModuleAccess');
const { authenticateEmployee, allowEmployeeRoles } = require('../../middleware/authEmployee');

router.get('/track/:token', getOrderByQRToken);

router.use(verifyToken);
router.use(requireEmployeePasswordChanged);
router.use(requireRestaurantSubscriptionAccess);
router.use(requireKYCVerifiedForWrites);
router.use(verifyBranchAccess);
router.use(verifyBranchModuleAccess('orders'));

const orderMgmt = requireRestaurantPlanFeatureUnlessBranch('orders');
const posOrders = requireRestaurantPlanFeatureUnlessBranch('customerOrders');

const coReaders = ['restaurant', 'kitchen', 'cashier', 'waiter', 'manager', 'admin', 'branch_admin', 'branch_manager', 'branch_cashier', 'branch_waiter', 'branch_kitchen'];
const coStats = ['restaurant', 'manager', 'admin', 'branch_admin', 'branch_manager'];

router.get('/stats', requireRole(...coStats), orderMgmt, getOrderStatistics);
router.get(
  '/activity-report',
  requireRole(...coStats),
  requireRestaurantPlanFeatureUnlessBranch('salesReports'),
  getOrderActivityReport,
);
router.get('/', requireRole(...coReaders), orderMgmt, getRestaurantOrders);
router.get('/:id', requireRole(...coReaders), orderMgmt, getOrderDetails);
router.post(
  '/',
  posOrders,
  (req, res, next) => {
    if (req.user?.scope === 'employee') {
      return authenticateEmployee(req, res, next);
    }
    return next();
  },
  (req, res, next) => {
    if (req.user?.scope === 'employee') {
      return allowEmployeeRoles('waiter')(req, res, next);
    }
    return requireRole('restaurant', 'branch_admin', 'branch_manager', 'branch_waiter')(req, res, next);
  },
  createOrder
);
router.patch('/:id/status', requireRole('restaurant', 'kitchen', 'branch_kitchen', 'branch_admin', 'branch_manager'), orderMgmt, updateOrderStatus);
router.patch('/:id/items/:itemId/kitchen', requireRole('restaurant', 'kitchen', 'branch_kitchen', 'branch_admin', 'branch_manager'), orderMgmt, updateOrderItemKitchenStatus);
router.patch('/:id/cancel', requireRole('restaurant', 'branch_admin', 'branch_manager'), orderMgmt, cancelOrder);

module.exports = router;
