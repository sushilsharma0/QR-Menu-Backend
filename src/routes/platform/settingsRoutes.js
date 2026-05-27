const express = require('express');
const router = express.Router();
const {
  getSiteSettings,
  updateSiteSettings,
  getManualPaymentSettings,
  updateManualPaymentSettings,
} = require('../../controllers/platform/settingsController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const checkPermission = require('../../middleware/auth/checkPermission');
const upload = require('../../config/multer');

router.use(verifyToken, requireRole('super_admin', 'admin'), checkPermission('manageSystem'));

router.get('/site', getSiteSettings);
router.patch('/site', upload.single('landingLogo'), updateSiteSettings);
router.get('/manual-payment', getManualPaymentSettings);
router.patch('/manual-payment', upload.single('qrCodeImage'), updateManualPaymentSettings);

module.exports = router;
