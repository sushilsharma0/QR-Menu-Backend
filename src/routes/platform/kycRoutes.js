const express = require('express');
const router = express.Router();
const {
  getKYCApplications,
  getKYCById,
  getKYCByRestaurant,
  approveKYC,
  rejectKYC,
  getKYCStats
} = require('../../controllers/platform/kycController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const checkPermission = require('../../middleware/auth/checkPermission');

router.use(verifyToken, requireRole('super_admin', 'admin'), checkPermission('verifyKYC'));

router.get('/stats', getKYCStats);
router.get('/', getKYCApplications);
router.get('/:id', getKYCById);
router.get('/restaurant/:restaurantId', getKYCByRestaurant);
router.patch('/:id/approve', approveKYC);
router.patch('/:id/reject', rejectKYC);

module.exports = router;