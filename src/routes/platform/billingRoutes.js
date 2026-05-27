const express = require('express');
const router = express.Router();
const {
  getBillingSettings,
  updateBillingSettings,
  listInvoices,
  getInvoiceById,
  statsByRestaurant,
  getSubscriptionActivityReport,
} = require('../../controllers/platform/billingController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const checkBillingPermission = require('../../middleware/auth/checkBillingPermission');

const guard = (...checks) => [verifyToken, requireRole('super_admin', 'admin'), ...checks];

router.get('/settings', ...guard(checkBillingPermission('managePlatformBillingSettings')), getBillingSettings);
router.patch('/settings', ...guard(checkBillingPermission('managePlatformBillingSettings')), updateBillingSettings);
router.get('/activity-report', ...guard(checkBillingPermission('manageSubscriptionActivity')), getSubscriptionActivityReport);
router.get('/invoices', ...guard(checkBillingPermission('manageSubscriptionInvoices')), listInvoices);
router.get('/invoices/:id', ...guard(checkBillingPermission('manageSubscriptionInvoices')), getInvoiceById);
router.get('/stats/by-restaurant', ...guard(checkBillingPermission('manageSubscriptionInvoices')), statsByRestaurant);

module.exports = router;
