const express = require('express');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const c = require('../../controllers/platform/securityController');

const router = express.Router();

const checkPermission = require('../../middleware/auth/checkPermission');

router.use(verifyToken, requireRole('super_admin', 'admin'), checkPermission('manageSecurity'));

router.get('/overview', c.getSecurityOverview);
router.get('/ip-blocks', c.listIpBlocks);
router.post('/ip-blocks', c.blockIp);
router.patch('/ip-blocks/:id/unblock', c.unblockIp);
router.get('/locks', c.listActiveLocks);
router.post('/locks', c.createSecurityLock);
router.post('/locks/release-by-subject', c.releaseLocksBySubject);
router.patch('/locks/:id/release', c.releaseSecurityLock);
router.get('/login-policy', c.getLoginPolicy);
router.patch('/login-policy', c.updateLoginPolicy);
router.get('/active-sessions', c.listActiveSessions);
router.post('/sessions/:sessionId/revoke', c.revokeActiveSession);
router.post('/force-logout', c.forceLogoutRestaurant);
router.post('/restaurants/:restaurantId/suspend', c.suspendRestaurant);

module.exports = router;
