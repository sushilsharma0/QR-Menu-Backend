const express = require('express');
const verifyToken = require('../middleware/auth/verifyToken');
const requireRole = require('../middleware/auth/requireRole');
const checkBillingPermission = require('../middleware/auth/checkBillingPermission');
const { strictLimiter } = require('../middleware/rateLimiter');
const upload = require('../config/multer');
const controller = require('../controllers/subscriptionPaymentController');

const router = express.Router();

// ----- Restaurant-side endpoints -----
const restaurantRouter = express.Router();

restaurantRouter.post(
  '/pay/esewa',
  verifyToken,
  requireRole('restaurant'),
  strictLimiter,
  controller.initiateEsewaPayment,
);
restaurantRouter.post(
  '/pay/khalti',
  verifyToken,
  requireRole('restaurant'),
  strictLimiter,
  controller.initiateKhaltiPayment,
);
restaurantRouter.post(
  '/pay/manual',
  verifyToken,
  requireRole('restaurant'),
  strictLimiter,
  upload.single('paymentProof'),
  controller.initiateManualPayment,
);

// Gateway callbacks: NOT protected by verifyToken.
// They are authenticated by HMAC signature (eSewa) or pidx lookup (Khalti).
restaurantRouter.post('/pay/esewa/verify', strictLimiter, controller.verifyEsewaPayment);
restaurantRouter.post('/pay/esewa/cancel', strictLimiter, controller.cancelEsewaPayment);
restaurantRouter.post('/pay/khalti/verify', strictLimiter, controller.verifyKhaltiPayment);

restaurantRouter.get(
  '/payments',
  verifyToken,
  requireRole('restaurant'),
  controller.getRestaurantPayments,
);

router.use('/restaurant/subscription', restaurantRouter);

// ----- Platform-side admin endpoints -----
const platformRouter = express.Router();

platformRouter.use(
  verifyToken,
  requireRole('super_admin', 'admin'),
  checkBillingPermission('manageSubscriptionPayments'),
);

platformRouter.get('/', controller.getPlatformPayments);
platformRouter.patch('/:id/approve', strictLimiter, controller.approvePayment);
platformRouter.patch('/:id/reject', strictLimiter, controller.rejectPayment);

router.use('/platform/subscription-payments', platformRouter);

module.exports = router;
