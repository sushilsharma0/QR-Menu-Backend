const express = require('express');
const router = express.Router();
const { authLimiter } = require('../middleware/rateLimiter');
const c = require('../controllers/auth/unifiedAuthController');

router.post('/login', authLimiter, c.unifiedLogin);

module.exports = router;
