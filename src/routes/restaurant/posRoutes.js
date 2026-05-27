const express = require('express');
const router = express.Router();
const verifyToken = require('../../middleware/auth/verifyToken');
const requireEmployeePasswordChanged = require('../../middleware/auth/requireEmployeePasswordChanged');
const requireRestaurantSubscriptionAccess = require('../../middleware/restaurant/requireRestaurantSubscriptionAccess');
const requireKYCVerifiedForWrites = require('../../middleware/restaurant/requireKYCVerifiedForWrites');
const requireRestaurantPlanFeatureUnlessBranch = require('../../middleware/restaurant/requireRestaurantPlanFeatureUnlessBranch');
const verifyBranchAccess = require('../../middleware/restaurant/verifyBranchAccess');
const verifyBranchModuleAccess = require('../../middleware/restaurant/verifyBranchModuleAccess');
const { unauthorized, forbidden } = require('../../utils/apiResponse');
const {
  requirePosBillingAccess,
  requirePosManagerAccess,
  requireOpenPosShift,
  requirePosStatusUpdate,
} = require('../../middleware/restaurant/requirePosAccess');
const { updateOrderStatus } = require('../../controllers/restaurant/customerOrderController');
const pos = require('../../controllers/restaurant/posController');

function requirePosUser(req, res, next) {
  if (!req.user) return unauthorized(res, 'Authentication required');
  if (req.user.scope === 'restaurant' && req.user.role === 'restaurant') return next();
  if (
    req.user.scope === 'branch_user' &&
    ['branch_admin', 'branch_manager', 'branch_cashier', 'branch_waiter'].includes(req.user.role)
  ) {
    return next();
  }
  if (
    req.user.scope === 'employee' &&
    ['waiter', 'cashier', 'manager', 'kitchen'].includes(req.user.role)
  ) {
    return next();
  }
  return forbidden(res, 'POS access denied');
}

router.use(
  verifyToken,
  requireEmployeePasswordChanged,
  requireRestaurantSubscriptionAccess,
  requireKYCVerifiedForWrites,
  requireRestaurantPlanFeatureUnlessBranch('customerOrders'),
  verifyBranchAccess,
  verifyBranchModuleAccess('customerOrders'),
  requirePosUser
);

router.get('/meta', pos.getPosMeta);
router.get('/shift', pos.getShift);
router.post('/shift/open', requirePosBillingAccess, pos.openShift);
router.post('/shift/close', requirePosBillingAccess, pos.closeShift);
router.get('/orders', requireOpenPosShift, pos.listPosOrders);
router.post('/order', requireOpenPosShift, pos.createPosOrder);
router.patch('/order/:id/status', requireOpenPosShift, requirePosStatusUpdate, updateOrderStatus);
router.post('/payment', requireOpenPosShift, requirePosBillingAccess, pos.postPosPayment);
router.post('/refund', requireOpenPosShift, requirePosManagerAccess, pos.postPosRefund);
router.post('/void', requireOpenPosShift, requirePosBillingAccess, pos.voidBill);
router.post('/drawer/adjust', requireOpenPosShift, requirePosBillingAccess, pos.adjustDrawer);
router.post('/sync/offline', requireOpenPosShift, pos.syncOfflineActions);
router.get('/reports', requireOpenPosShift, requirePosManagerAccess, pos.getPosReports);
router.post('/cart', requireOpenPosShift, pos.saveCartDraft);
router.get('/cart', requireOpenPosShift, pos.loadCartDraft);

module.exports = router;
