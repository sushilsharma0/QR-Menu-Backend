const express = require('express');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const { getFraudAlerts, updateFraudAlert } = require('../../controllers/platform/fraudController');

const router = express.Router();

const checkPermission = require('../../middleware/auth/checkPermission');

router.use(verifyToken, requireRole('super_admin', 'admin'), checkPermission('manageSecurity'));

router.get('/alerts', getFraudAlerts);
router.patch('/alerts/:id', updateFraudAlert);

module.exports = router;
