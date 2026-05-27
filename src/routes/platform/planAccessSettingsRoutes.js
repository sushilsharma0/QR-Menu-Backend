const express = require('express');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const checkBillingPermission = require('../../middleware/auth/checkBillingPermission');
const {
  getPlanAccessSettings,
  updatePlanAccessSettings,
} = require('../../controllers/platform/planAccessSettingsController');

const router = express.Router();

const guard = (...checks) => [verifyToken, requireRole('super_admin', 'admin'), ...checks];

router.get('/', ...guard(checkBillingPermission('manageTrialAccess')), getPlanAccessSettings);
router.put('/', ...guard(checkBillingPermission('manageTrialAccess')), updatePlanAccessSettings);

module.exports = router;
