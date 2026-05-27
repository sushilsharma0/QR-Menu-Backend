const express = require('express');
const router = express.Router();
const { login, logout, getProfile, updateProfile, changePassword } = require('../../controllers/platform/authController');
const { authLimiter } = require('../../middleware/rateLimiter');
const verifyToken = require('../../middleware/auth/verifyToken');
const upload = require('../../config/multer');

router.post('/login', authLimiter, login);
router.post('/logout', verifyToken, logout);
router.get('/profile', verifyToken, getProfile);
router.put('/profile', verifyToken, upload.single('profileImage'), updateProfile);
router.patch('/profile', verifyToken, upload.single('profileImage'), updateProfile);
router.post('/change-password', verifyToken, changePassword);

module.exports = router;
