const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const requireEmployeePasswordChanged = require('../../middleware/auth/requireEmployeePasswordChanged');
const requireRestaurantSubscriptionAccess = require('../../middleware/restaurant/requireRestaurantSubscriptionAccess');
const requireRestaurantPlanFeature = require('../../middleware/restaurant/requireRestaurantPlanFeature');
const verifyBranchAccess = require('../../middleware/restaurant/verifyBranchAccess');
const c = require('../../controllers/backupController');

const router = express.Router();

const backupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.BACKUP_RATE_LIMIT_MAX || 30),
  message: { success: false, message: 'Too many backup requests. Try again later.' },
});

const restoreLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RESTORE_RATE_LIMIT_MAX || 10),
  message: { success: false, message: 'Too many restore requests. Try again later.' },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.BACKUP_MAX_UPLOAD_BYTES || 250 * 1024 * 1024),
    files: 1,
  },
  fileFilter(req, file, cb) {
    const name = (file.originalname || '').toLowerCase();
    const ok =
      name.endsWith('.qrbackup') ||
      name.endsWith('.qrbak') ||
      file.mimetype === 'application/octet-stream' ||
      file.mimetype === 'application/zip';
    cb(ok ? null : new Error('Only encrypted .qrbackup backup files are allowed'), ok);
  },
});

router.get('/download/:id', c.downloadBackupWithToken);

router.use(verifyToken);
router.use(requireEmployeePasswordChanged);
router.use(requireRole('restaurant', 'admin', 'super_admin', 'branch_admin'));
router.use(requireRestaurantSubscriptionAccess);
router.use(requireRestaurantPlanFeature('backup'));
router.use(verifyBranchAccess);

router.post('/create', backupLimiter, c.createBackup);
router.get('/history', c.getBackupHistory);
router.get('/download/:id', c.downloadBackup);
router.delete('/:id', backupLimiter, c.deleteBackup);
router.post('/schedule', backupLimiter, c.saveSchedule);
router.post('/clone-branch', backupLimiter, c.cloneBranch);

router.post('/validate', restoreLimiter, upload.single('backup'), c.validateBackup);
router.post('/preview', restoreLimiter, upload.single('backup'), c.previewBackup);
router.post('/restore/otp/request', restoreLimiter, c.requestOtp);
router.post('/restore/otp/verify', restoreLimiter, c.confirmOtp);
router.post('/restore/start', restoreLimiter, upload.single('backup'), c.startRestore);
router.get('/restore/jobs/:jobId', c.getRestoreJob);
router.post('/restore/jobs/:jobId/cancel', c.cancelRestore);
router.post('/restore/rollback/:snapshotId', restoreLimiter, c.rollbackRestore);
router.post('/restore', restoreLimiter, upload.single('backup'), c.restoreBackup);

module.exports = router;
