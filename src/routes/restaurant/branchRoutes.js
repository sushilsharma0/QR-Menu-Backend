const express = require('express');
const router = express.Router();
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const requireEmployeePasswordChanged = require('../../middleware/auth/requireEmployeePasswordChanged');
const requireRestaurantSubscriptionAccess = require('../../middleware/restaurant/requireRestaurantSubscriptionAccess');
const requireRestaurantPlanFeature = require('../../middleware/restaurant/requireRestaurantPlanFeature');
const upload = require('../../config/multer');
const { authLimiter } = require('../../middleware/rateLimiter');
const c = require('../../controllers/restaurant/branchController');

router.use(verifyToken);
router.use(requireEmployeePasswordChanged);

const branchPortalRoles = ['branch_admin', 'branch_manager', 'branch_cashier', 'branch_waiter', 'branch_kitchen'];
router.get('/me/settings', requireRole(...branchPortalRoles), c.getMyBranchSettings);
router.put(
  '/me/settings',
  requireRole(...branchPortalRoles),
  upload.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'banner', maxCount: 1 },
  ]),
  c.updateMyBranchSettings,
);
router.get('/me/public-profile', requireRole(...branchPortalRoles), c.getMyBranchPublicProfile);
router.put('/me/public-profile', requireRole(...branchPortalRoles), c.updateMyBranchPublicProfile);

router.use(requireRole('restaurant', 'admin', 'manager', 'accountant'));
router.use(requireRestaurantSubscriptionAccess);
router.use(requireRestaurantPlanFeature('branches'));

router.post('/owner-email/request-otp', requireRole('restaurant', 'admin'), authLimiter, c.requestBranchOwnerOtp);
router.post('/owner-email/verify-otp', requireRole('restaurant', 'admin'), authLimiter, c.verifyBranchOwnerOtp);
router.get('/', c.listBranches);
router.post('/', requireRole('restaurant', 'admin'), c.createBranch);
router.get('/:id', c.getBranch);
router.patch('/:id', requireRole('restaurant', 'admin'), c.updateBranch);
router.delete('/:id', requireRole('restaurant', 'admin'), c.deleteBranch);
router.patch('/:id/manager', requireRole('restaurant', 'admin'), c.assignManager);
router.get('/:id/analytics', c.getBranchAnalytics);
router.get('/:id/activity', c.getBranchActivityTimeline);
router.patch('/:id/branch-auth/:authId/reset-password', requireRole('restaurant', 'admin'), c.resetBranchPortalPassword);
router.patch('/:id/branch-auth/:authId', requireRole('restaurant', 'admin'), c.updateBranchAuth);
router.get('/:id/branch-auth/:authId/sessions', requireRole('restaurant', 'admin'), c.listBranchPortalSessions);
router.post('/:id/branch-auth/:authId/sessions/:sessionId/revoke', requireRole('restaurant', 'admin'), c.revokeBranchPortalSession);

module.exports = router;
