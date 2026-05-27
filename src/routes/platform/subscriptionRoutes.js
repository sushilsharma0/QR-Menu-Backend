const express = require('express');
const router = express.Router();
const {
  getAllPlans,
  getPlanById,
  createPlan,
  updatePlan,
  deletePlan,
  assignPlanToRestaurant,
  getPlanFeatureOptions,
  assignCustomPlanToRestaurant,
  getPendingPlanRequests,
  approvePlanRequest,
  rejectPlanRequest,
  updatePreSubscriptionFeatureGrants,
} = require('../../controllers/platform/subscriptionController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');

const checkBillingPermission = require('../../middleware/auth/checkBillingPermission');

router.get('/plans', getAllPlans);
router.get('/plans/:id', getPlanById);

router.get(
  '/plan-feature-options',
  verifyToken,
  requireRole('super_admin', 'admin'),
  checkBillingPermission('manageSubscriptionPlans'),
  getPlanFeatureOptions,
);

router.post(
  '/assign-custom',
  verifyToken,
  requireRole('super_admin'),
  assignCustomPlanToRestaurant,
);

router.use(verifyToken, requireRole('super_admin', 'admin'), checkBillingPermission('manageSubscriptionPlans'));

router.post('/plans', createPlan);
router.put('/plans/:id', updatePlan);
router.delete('/plans/:id', deletePlan);
router.post('/assign', assignPlanToRestaurant);
router.patch(
  '/restaurants/:restaurantId/feature-grants',
  updatePreSubscriptionFeatureGrants,
);
router.get('/requests/pending', getPendingPlanRequests);
router.post('/requests/:restaurantId/approve', approvePlanRequest);
router.post('/requests/:restaurantId/reject', rejectPlanRequest);

module.exports = router;