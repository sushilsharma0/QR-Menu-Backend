const express = require('express');
const router = express.Router();
const { listFeedback, patchFeedback } = require('../../controllers/platform/feedbackController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');

router.use(verifyToken, requireRole('super_admin', 'admin', 'support'));

router.get('/', listFeedback);
router.patch('/:id', patchFeedback);

module.exports = router;
