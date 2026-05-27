const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/auth/verifyToken');
const notificationService = require('../services/notificationService');
const { success, error } = require('../utils/apiResponse');

const resolveRecipientFromUser = (user) => {
  if (!user) return null;
  if (user.scope === 'employee') {
    return { recipientType: 'employee', recipientId: String(user.id) };
  }
  if (user.scope === 'branch_user' && user.restaurantId) {
    return { recipientType: 'restaurant', recipientId: String(user.restaurantId) };
  }
  if (user.role === 'restaurant') {
    return { recipientType: 'restaurant', recipientId: String(user.id) };
  }
  if (user.role === 'super_admin' || user.role === 'admin') {
    return { recipientType: 'platform', recipientId: String(user.id) };
  }
  return null;
};

const resolveNotificationScope = (user) => {
  if (!user) return {};
  if ((user.scope === 'branch_user' || user.scope === 'employee') && user.branchId) {
    return { branchId: String(user.branchId) };
  }
  return {};
};

router.use(verifyToken);

router.get('/', async (req, res) => {
  try {
    const recipient = resolveRecipientFromUser(req.user);
    if (!recipient) return error(res, 'Unauthorized recipient', 403);

    const {
      page = 1,
      limit = 20,
      unreadOnly = 'false',
      category,
      priority,
      search,
      fromDate,
      toDate,
    } = req.query;

    const data = await notificationService.getUserNotifications(
      recipient.recipientId,
      recipient.recipientType,
      {
        page: Number(page) || 1,
        limit: Number(limit) || 20,
        unreadOnly: unreadOnly === 'true',
        category,
        priority,
        search,
        fromDate,
        toDate,
        ...resolveNotificationScope(req.user),
      }
    );

    const unreadCount = await notificationService.getUnreadCount(
      recipient.recipientId,
      recipient.recipientType,
      resolveNotificationScope(req.user)
    );

    return success(res, { ...data, unreadCount }, 'Notifications retrieved');
  } catch (err) {
    return error(res, err.message || 'Failed to retrieve notifications', 500);
  }
});

router.get('/unread-count', async (req, res) => {
  try {
    const recipient = resolveRecipientFromUser(req.user);
    if (!recipient) return error(res, 'Unauthorized recipient', 403);
    const unreadCount = await notificationService.getUnreadCount(
      recipient.recipientId,
      recipient.recipientType,
      resolveNotificationScope(req.user)
    );
    return success(res, { unreadCount }, 'Unread count retrieved');
  } catch (err) {
    return error(res, err.message || 'Failed to retrieve unread count', 500);
  }
});

router.patch('/:id/read', async (req, res) => {
  try {
    const recipient = resolveRecipientFromUser(req.user);
    if (!recipient) return error(res, 'Unauthorized recipient', 403);
    const notif = await notificationService.markAsRead(
      req.params.id,
      recipient.recipientId,
      recipient.recipientType,
      resolveNotificationScope(req.user)
    );
    if (!notif) return error(res, 'Notification not found', 404);
    return success(res, notif, 'Notification marked as read');
  } catch (err) {
    return error(res, err.message || 'Failed to mark notification as read', 500);
  }
});

router.patch('/read-all', async (req, res) => {
  try {
    const recipient = resolveRecipientFromUser(req.user);
    if (!recipient) return error(res, 'Unauthorized recipient', 403);
    const result = await notificationService.markAllAsRead(
      recipient.recipientId,
      recipient.recipientType,
      resolveNotificationScope(req.user)
    );
    return success(res, { modifiedCount: result.modifiedCount || 0 }, 'All notifications marked as read');
  } catch (err) {
    return error(res, err.message || 'Failed to mark all notifications as read', 500);
  }
});

module.exports = router;
