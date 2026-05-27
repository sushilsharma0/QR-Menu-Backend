const express = require('express');
const router = express.Router();
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const c = require('../../controllers/platform/branchPlatformController');

router.use(verifyToken, requireRole('super_admin', 'admin'));

router.get('/', c.listBranches);
router.patch('/:id/suspend', c.suspendBranch);

module.exports = router;
