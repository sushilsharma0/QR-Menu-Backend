const express = require('express');
const router = express.Router();
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const requireEmployeePasswordChanged = require('../../middleware/auth/requireEmployeePasswordChanged');
const requireRestaurantSubscriptionAccess = require('../../middleware/restaurant/requireRestaurantSubscriptionAccess');
const requireRestaurantPlanFeature = require('../../middleware/restaurant/requireRestaurantPlanFeature');
const requireFinanceAccess = require('../../middleware/restaurant/requireFinanceAccess');
const c = require('../../controllers/invoiceController');

router.use(verifyToken);
router.use(requireEmployeePasswordChanged);
router.use(requireRole('restaurant', 'cashier', 'manager', 'admin', 'accountant'));
router.use(requireRestaurantSubscriptionAccess);
router.use(requireRestaurantPlanFeature('billing'));

router.post('/', requireFinanceAccess('invoices'), c.createInvoiceFromOrder);
router.get('/', requireFinanceAccess('invoices'), c.listInvoices);
router.get('/download/:id', requireFinanceAccess('invoices'), c.downloadInvoice);
router.get('/:id', requireFinanceAccess('invoices'), c.getInvoiceById);

module.exports = router;
