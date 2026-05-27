const express = require('express');
const router = express.Router();
const {
  getPackageStatus,
  requestPackage,
  submitPaymentProof,
  getPackageHistory,
  toggleAutoRenew
} = require('../../controllers/restaurant/packageController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const upload = require('../../config/multer');

// All routes require authentication
router.use(verifyToken, requireRole('restaurant'));

// Get current package status
router.get('/status', getPackageStatus);

// Get package history
router.get('/history', getPackageHistory);

// Request a new package
router.post('/request', requestPackage);

router.post('/payment-proof', upload.single('paymentProof'), submitPaymentProof);

// Toggle auto-renew
router.patch('/auto-renew', toggleAutoRenew);

module.exports = router;