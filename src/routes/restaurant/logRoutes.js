const express = require('express');
const router = express.Router();
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const { getEmployeeActivityLogs } = require('../../controllers/restaurant/logController');
const requireRestaurantSubscriptionAccess = require('../../middleware/restaurant/requireRestaurantSubscriptionAccess');
const requireRestaurantPlanFeature = require('../../middleware/restaurant/requireRestaurantPlanFeature');

router.use(verifyToken, requireRole('restaurant'));
router.use(requireRestaurantSubscriptionAccess);
router.use(requireRestaurantPlanFeature('activityLogs'));

router.get('/employee-activities', getEmployeeActivityLogs);

module.exports = router;
