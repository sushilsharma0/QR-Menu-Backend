const express = require('express');
const router = express.Router();
const {
  submitKYC,
  getKYCStatus,
  updateKYC
} = require('../../controllers/restaurant/kycController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const upload = require('../../middleware/upload');

router.use(verifyToken, requireRole('restaurant'));

router.post('/submit', upload.fields([
  { name: 'idDocument', maxCount: 1 },
  { name: 'panDocument', maxCount: 1 },
  { name: 'profilePhoto', maxCount: 1 },
  { name: 'businessRegistrationDoc', maxCount: 1 },
  { name: 'addressProof', maxCount: 1 }
]), submitKYC);
router.get('/status', getKYCStatus);
router.put('/update', upload.fields([
  { name: 'idDocument', maxCount: 1 },
  { name: 'panDocument', maxCount: 1 },
  { name: 'profilePhoto', maxCount: 1 }
]), updateKYC);

module.exports = router;