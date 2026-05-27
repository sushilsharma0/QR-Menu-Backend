const express = require('express');
const router = express.Router();
const {
  getAllTickets,
  getAdminTicketDetail,
  addAdminReply,
  updateTicketStatus,
  assignTicket,
  getTicketStats
} = require('../../controllers/shared/ticketController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const checkPermission = require('../../middleware/auth/checkPermission');

router.use(verifyToken, requireRole('super_admin', 'admin'), checkPermission('manageTickets'));

router.get('/stats', getTicketStats);
router.get('/', getAllTickets);
router.get('/:id', getAdminTicketDetail);
router.post('/:id/reply', addAdminReply);
router.patch('/:id/status', updateTicketStatus);
router.patch('/:id/assign', assignTicket);

module.exports = router;
