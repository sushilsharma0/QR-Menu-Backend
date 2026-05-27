const express = require('express');
const router = express.Router();
const {
  createTicket,
  getRestaurantTickets,
  getRestaurantTicketDetail,
  addRestaurantReply
} = require('../../controllers/shared/ticketController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const requireRestaurantSubscriptionAccess = require('../../middleware/restaurant/requireRestaurantSubscriptionAccess');
const requireRestaurantPlanFeature = require('../../middleware/restaurant/requireRestaurantPlanFeature');

router.use(verifyToken, requireRole('restaurant', 'branch_admin', 'branch_manager', 'branch_cashier', 'branch_waiter', 'branch_kitchen'));
router.use(requireRestaurantSubscriptionAccess);
router.use(requireRestaurantPlanFeature('supportTickets'));

router.post('/', createTicket);
router.get('/', getRestaurantTickets);
router.get('/:id', getRestaurantTicketDetail);
router.post('/:id/reply', addRestaurantReply);

module.exports = router;
