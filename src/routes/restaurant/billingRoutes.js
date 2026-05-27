const express = require('express');
const router = express.Router();
const { listMyInvoices, getMyInvoiceById } = require('../../controllers/restaurant/billingController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const requireRestaurantSubscriptionAccess = require('../../middleware/restaurant/requireRestaurantSubscriptionAccess');
const requireRestaurantPlanFeature = require('../../middleware/restaurant/requireRestaurantPlanFeature');

router.use(verifyToken, requireRole('restaurant'));
router.use(requireRestaurantSubscriptionAccess);
router.use(requireRestaurantPlanFeature('billing'));

router.get('/invoices', listMyInvoices);
router.get('/invoices/:id', getMyInvoiceById);

module.exports = router;
