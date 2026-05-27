const express = require('express');
const router = express.Router();
const { authLimiter } = require('../../middleware/rateLimiter');
const verifyToken = require('../../middleware/auth/verifyToken');
const c = require('../../controllers/restaurant/branchAuthController');

router.post('/login', authLimiter, c.login);
router.get('/me', verifyToken, c.me);
router.post('/change-password', verifyToken, c.changePassword);
router.post('/logout', verifyToken, c.logout);
router.get('/sessions', verifyToken, c.listMySessions);

module.exports = router;
