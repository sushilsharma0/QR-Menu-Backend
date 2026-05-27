const express = require('express');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const checkPermission = require('../../middleware/auth/checkPermission');
const c = require('../../controllers/platform/platformFinanceController');

const router = express.Router();

router.use(verifyToken, requireRole('super_admin', 'admin'), checkPermission('manageFinance'));

router.post('/expenses', c.createExpense);
router.get('/expenses', c.getExpenses);
router.delete('/expenses/:id', c.deleteExpense);
router.get('/profit-loss', c.getProfitLoss);

module.exports = router;
