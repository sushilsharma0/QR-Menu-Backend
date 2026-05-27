const express = require('express');
const router = express.Router();
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const checkPermission = require('../../middleware/auth/checkPermission');
const { getRestaurantActivityLogs } = require('../../controllers/platform/logController');

router.use(verifyToken, requireRole('super_admin', 'admin'), checkPermission('manageLogs'));

router.get('/restaurant-activities', getRestaurantActivityLogs);

module.exports = router;
