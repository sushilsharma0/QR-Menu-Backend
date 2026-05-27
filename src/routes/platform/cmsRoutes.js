const express = require('express');
const router = express.Router();
const {
  getAllContent,
  getContentByKey,
  upsertContent,
  deleteContent,
  toggleContentStatus
} = require('../../controllers/platform/cmsController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const checkPermission = require('../../middleware/auth/checkPermission');

router.get('/', getAllContent);
router.get('/:key', getContentByKey);

router.use(verifyToken, requireRole('super_admin', 'admin'), checkPermission('manageCMS'));

router.post('/', upsertContent);
router.put('/:key', upsertContent);
router.delete('/:key', deleteContent);
router.patch('/:key/toggle-status', toggleContentStatus);

module.exports = router;