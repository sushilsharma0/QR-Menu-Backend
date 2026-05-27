const express = require('express');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const checkPermission = require('../../middleware/auth/checkPermission');
const c = require('../../controllers/platform/platformPayrollController');

const router = express.Router();

router.use(verifyToken, requireRole('super_admin', 'admin'), checkPermission('managePayroll'));

router.get('/employees', c.listPayrollEmployees);
router.get('/employees/:id', c.getPayrollEmployee);
router.get('/settings', c.getPayrollSettings);
router.patch('/settings', c.updatePayrollSettings);
router.post('/generate', c.generatePayroll);
router.get('/employee-summary', c.getPayrollEmployeeSummary);
router.get('/', c.getPayrolls);
router.patch('/pay/:id', c.payPayroll);
router.delete('/:id', c.deletePayroll);
router.patch('/:id', c.updatePayroll);

module.exports = router;
