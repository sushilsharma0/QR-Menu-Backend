const asyncHandler = require('express-async-handler');
const Ticket = require('../../models/shared/Ticket');
const Restaurant = require('../../models/restaurant/Restaurant');
const Platform = require('../../models/platform/Platform');
const { success, error } = require('../../utils/apiResponse');
const { sendNewTicketNotification, sendTicketReplyNotification, sendTicketStatusChangeNotification } = require('../../services/emailService');
const notificationService = require('../../services/notificationService');
const { readNumber, readObjectId, readSearchRegex, readString } = require('../../utils/inputValidation');

const resolveRestaurantId = (req) => req.user?.scope === 'branch_user' ? req.user.restaurantId : req.user.id;
const resolveBranchId = (req) => req.user?.scope === 'branch_user' && req.user.branchId ? req.user.branchId : null;

/**
 * @desc    Create a support ticket (Restaurant)
 * @route   POST /api/restaurant/tickets
 * @access  Private
 */
const createTicket = asyncHandler(async (req, res) => {
  const { subject, description, category, priority } = req.body;

  if (!subject || !description) {
    return error(res, 'Subject and description are required', 400);
  }

  const ticket = await Ticket.create({
    restaurant: resolveRestaurantId(req),
    branchId: resolveBranchId(req),
    createdBy: resolveRestaurantId(req),
    subject,
    description,
    category: category || 'other',
    priority: priority || 'medium'
  });

  await ticket.populate('restaurant', 'name email');

  // Send notification to admins
  const admins = await Platform.find({ isActive: true }).select('email');
  if (admins.length > 0) {
    const adminEmails = admins.map(a => a.email);
    await sendNewTicketNotification(adminEmails, ticket.restaurant.name, ticket.ticketNumber, subject);
    await notificationService.sendBulkNotifications(
      admins.map((admin) => ({
        recipientType: 'platform',
        recipientId: admin._id,
        category: 'support',
        type: 'ticket_created',
        priority: priority || 'medium',
        title: `New ticket ${ticket.ticketNumber}`,
        message: `${ticket.restaurant.name}: ${subject}`,
        relatedEntity: { entityType: 'ticket', entityId: ticket._id },
        actionUrl: '/notifications',
      }))
    );
  }

  return success(res, ticket, 'Support ticket created successfully');
});

/**
 * @desc    Get all tickets for a restaurant
 * @route   GET /api/restaurant/tickets
 * @access  Private
 */
const getRestaurantTickets = asyncHandler(async (req, res) => {
  const { search } = req.query;
  const status = readString(req.query.status, { max: 32 });
  const priority = readString(req.query.priority, { max: 32 });
  const category = readString(req.query.category, { max: 32 });
  const page = readNumber(req.query.page, { min: 1, max: 10000, integer: true, fallback: 1 });
  const limit = readNumber(req.query.limit, { min: 1, max: 100, integer: true, fallback: 10 });
  const skip = (page - 1) * limit;

  const query = { restaurant: resolveRestaurantId(req) };
  const branchId = resolveBranchId(req);
  if (branchId) query.branchId = branchId;
  if (status) query.status = status;
  if (priority) query.priority = priority;
  if (category) query.category = category;
  const searchRegex = readSearchRegex(search);
  if (searchRegex) {
    query.$or = [
      { ticketNumber: searchRegex },
      { subject: searchRegex },
      { description: searchRegex },
    ];
  }

  const tickets = await Ticket.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('restaurant', 'name email')
    .populate('assignedTo', 'name email');

  const total = await Ticket.countDocuments(query);

  return success(res, {
    tickets,
    pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / limit) }
  }, 'Tickets retrieved');
});

/**
 * @desc    Get ticket detail (Restaurant)
 * @route   GET /api/restaurant/tickets/:id
 * @access  Private
 */
const getRestaurantTicketDetail = asyncHandler(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id)
    .populate('restaurant', 'name email')
    .populate('assignedTo', 'name email role')
    .populate('replies.responder.id');

  if (!ticket) {
    return error(res, 'Ticket not found', 404);
  }

  const restaurantId = ticket.restaurant?._id || ticket.restaurant;
  if (restaurantId.toString() !== String(resolveRestaurantId(req))) {
    return error(res, 'Not authorized to view this ticket', 403);
  }
  const branchId = resolveBranchId(req);
  if (branchId && String(ticket.branchId || '') !== String(branchId)) {
    return error(res, 'Not authorized to view this branch ticket', 403);
  }

  return success(res, ticket, 'Ticket retrieved');
});

/**
 * @desc    Add reply to ticket (Restaurant)
 * @route   POST /api/restaurant/tickets/:id/reply
 * @access  Private
 */
const addRestaurantReply = asyncHandler(async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return error(res, 'Message is required', 400);
  }

  const ticket = await Ticket.findById(req.params.id);

  if (!ticket) {
    return error(res, 'Ticket not found', 404);
  }

  if (ticket.restaurant.toString() !== String(resolveRestaurantId(req))) {
    return error(res, 'Not authorized to reply to this ticket', 403);
  }
  const branchId = resolveBranchId(req);
  if (branchId && String(ticket.branchId || '') !== String(branchId)) {
    return error(res, 'Not authorized to reply to this branch ticket', 403);
  }

  const restaurant = await Restaurant.findById(resolveRestaurantId(req));

  ticket.replies.push({
    responder: {
      id: req.user.id,
      model: 'Restaurant',
      name: req.user?.scope === 'branch_user' ? (req.user.branchName || req.user.name || restaurant.name) : restaurant.name,
      role: req.user?.scope === 'branch_user' ? req.user.role : 'restaurant'
    },
    message
  });

  ticket.lastReplyAt = new Date();
  await ticket.save();

  // Send notification to assigned admin
  if (ticket.assignedTo) {
    const admin = await Platform.findById(ticket.assignedTo);
    if (admin) {
      await sendTicketReplyNotification(admin.email, admin.name, ticket.ticketNumber, restaurant.name, false);
      await notificationService.sendNotification({
        recipientType: 'platform',
        recipientId: admin._id,
        category: 'support',
        type: 'ticket_replied',
        priority: 'medium',
        title: `Reply on ${ticket.ticketNumber}`,
        message: `${restaurant.name} replied to the ticket.`,
        relatedEntity: { entityType: 'ticket', entityId: ticket._id },
        actionUrl: '/notifications',
      });
    }
  }

  return success(res, ticket, 'Reply added successfully');
});

/**
 * @desc    Get all tickets (Admin)
 * @route   GET /api/platform/tickets
 * @access  Private
 */
const getAllTickets = asyncHandler(async (req, res) => {
  const status = readString(req.query.status, { max: 32 });
  const priority = readString(req.query.priority, { max: 32 });
  const category = readString(req.query.category, { max: 32 });
  const restaurantId = readObjectId(req.query.restaurantId);
  const page = readNumber(req.query.page, { min: 1, max: 10000, integer: true, fallback: 1 });
  const limit = readNumber(req.query.limit, { min: 1, max: 100, integer: true, fallback: 10 });
  const skip = (page - 1) * limit;

  const query = {};
  if (status) query.status = status;
  if (priority) query.priority = priority;
  if (category) query.category = category;
  if (restaurantId) query.restaurant = restaurantId;

  const tickets = await Ticket.find(query)
    .sort({ lastReplyAt: -1, createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('restaurant', 'name email phone')
    .populate('assignedTo', 'name email role')
    .populate('createdBy', 'name email');

  const total = await Ticket.countDocuments(query);

  return success(res, {
    tickets,
    pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / limit) }
  }, 'Tickets retrieved');
});

/**
 * @desc    Get ticket detail (Admin)
 * @route   GET /api/platform/tickets/:id
 * @access  Private
 */
const getAdminTicketDetail = asyncHandler(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id)
    .populate('restaurant', 'name email phone address')
    .populate('assignedTo', 'name email role')
    .populate('createdBy', 'name email');

  if (!ticket) {
    return error(res, 'Ticket not found', 404);
  }

  return success(res, ticket, 'Ticket retrieved');
});

/**
 * @desc    Add admin reply to ticket
 * @route   POST /api/platform/tickets/:id/reply
 * @access  Private
 */
const addAdminReply = asyncHandler(async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return error(res, 'Message is required', 400);
  }

  const ticket = await Ticket.findById(req.params.id);

  if (!ticket) {
    return error(res, 'Ticket not found', 404);
  }

  const admin = await Platform.findById(req.user.id);

  ticket.replies.push({
    responder: {
      id: req.user.id,
      model: 'Platform',
      name: admin.name,
      role: admin.role
    },
    message
  });

  ticket.lastReplyAt = new Date();
  ticket.assignedTo = req.user.id;
  await ticket.save();

  // Send notification to restaurant
  const restaurant = await Restaurant.findById(ticket.restaurant);
  if (restaurant) {
    await sendTicketReplyNotification(restaurant.email, restaurant.name, ticket.ticketNumber, admin.name, true);
    await notificationService.sendNotification({
      recipientType: 'restaurant',
      recipientId: restaurant._id,
      category: 'support',
      type: 'ticket_replied',
      priority: 'medium',
      title: `Support replied to ${ticket.ticketNumber}`,
      message: `${admin.name} replied to your ticket.`,
      relatedEntity: { entityType: 'ticket', entityId: ticket._id },
      actionUrl: '/notifications',
    });
  }

  return success(res, ticket, 'Reply added successfully');
});

/**
 * @desc    Update ticket status (Admin)
 * @route   PATCH /api/platform/tickets/:id/status
 * @access  Private
 */
const updateTicketStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;

  if (!status) {
    return error(res, 'Status is required', 400);
  }

  const validStatuses = ['open', 'in_progress', 'resolved', 'closed'];
  if (!validStatuses.includes(status)) {
    return error(res, `Status must be one of: ${validStatuses.join(', ')}`, 400);
  }

  const ticket = await Ticket.findById(req.params.id);

  if (!ticket) {
    return error(res, 'Ticket not found', 404);
  }

  ticket.status = status;

  if (status === 'resolved') {
    ticket.resolvedAt = new Date();
  } else if (status === 'closed') {
    ticket.closedAt = new Date();
  }

  await ticket.save();

  // Send status update notification to restaurant
  const restaurant = await Restaurant.findById(ticket.restaurant);
  if (restaurant) {
    await sendTicketStatusChangeNotification(restaurant.email, restaurant.name, ticket.ticketNumber, status);
    await notificationService.sendNotification({
      recipientType: 'restaurant',
      recipientId: restaurant._id,
      category: 'support',
      type: `ticket_${status}`,
      priority: status === 'resolved' || status === 'closed' ? 'medium' : 'low',
      title: `Ticket ${status}`,
      message: `Ticket ${ticket.ticketNumber} is now ${status.replace('_', ' ')}.`,
      relatedEntity: { entityType: 'ticket', entityId: ticket._id },
      actionUrl: '/notifications',
    });
  }

  return success(res, ticket, `Ticket status updated to ${status}`);
});

/**
 * @desc    Assign ticket to admin
 * @route   PATCH /api/platform/tickets/:id/assign
 * @access  Private
 */
const assignTicket = asyncHandler(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id);

  if (!ticket) {
    return error(res, 'Ticket not found', 404);
  }

  ticket.assignedTo = req.user.id;
  ticket.status = 'in_progress';
  await ticket.save();

  return success(res, ticket, 'Ticket assigned to you');
});

/**
 * @desc    Get ticket statistics (Admin)
 * @route   GET /api/platform/tickets/stats
 * @access  Private
 */
const getTicketStats = asyncHandler(async (req, res) => {
  const stats = await Ticket.aggregate([
    {
      $facet: {
        byStatus: [
          { $group: { _id: '$status', count: { $sum: 1 } } }
        ],
        byPriority: [
          { $group: { _id: '$priority', count: { $sum: 1 } } }
        ],
        byCategory: [
          { $group: { _id: '$category', count: { $sum: 1 } } }
        ],
        totalTickets: [
          { $count: 'count' }
        ],
        averageResolutionTime: [
          {
            $match: { resolvedAt: { $exists: true } }
          },
          {
            $group: {
              _id: null,
              avgTime: {
                $avg: {
                  $subtract: ['$resolvedAt', '$createdAt']
                }
              }
            }
          }
        ]
      }
    }
  ]);

  return success(res, stats[0], 'Ticket statistics retrieved');
});

module.exports = {
  createTicket,
  getRestaurantTickets,
  getRestaurantTicketDetail,
  addRestaurantReply,
  getAllTickets,
  getAdminTicketDetail,
  addAdminReply,
  updateTicketStatus,
  assignTicket,
  getTicketStats
};
