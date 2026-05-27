const Notification = require('../models/platform/Notification');
const {
  emitNotification,
  emitNotificationRead,
  emitNotificationAllRead,
} = require('./socketService');

class NotificationService {
  normalizeRecipient(input) {
    if (input?.recipientType && input?.recipientId) {
      return { recipientType: input.recipientType, recipientId: String(input.recipientId) };
    }

    // Backward compatibility for old callers using recipient + recipientModel.
    const legacyMap = {
      Restaurant: 'restaurant',
      Employee: 'employee',
      Platform: 'platform',
      Admin: 'platform',
      Customer: 'customer',
    };
    if (input?.recipient && input?.recipientModel) {
      return {
        recipientType: legacyMap[input.recipientModel] || 'restaurant',
        recipientId: String(input.recipient),
      };
    }

    throw new Error('recipientType and recipientId are required');
  }

  async create(data) {
    const { recipientType, recipientId } = this.normalizeRecipient(data);
    if (data?.dedupeKey) {
      const existing = await Notification.findOne({
        recipientType,
        recipientId,
        type: data.type || 'system',
        'metadata.dedupeKey': data.dedupeKey,
      }).sort({ createdAt: -1 });
      if (existing) return existing;
    }

    const metadata = { ...(data.metadata || data.data || {}) };
    if (data?.dedupeKey) metadata.dedupeKey = data.dedupeKey;
    if (data?.silent) metadata.silent = true;
    const doc = await Notification.create({
      recipientType,
      recipientId,
      title: data.title,
      message: data.message,
      type: data.type || 'system',
      priority: data.priority || 'medium',
      category: data.category || 'general',
      relatedEntity: data.relatedEntity || { entityType: null, entityId: null },
      restaurant: data.restaurant || data.restaurantId || null,
      restaurantId: data.restaurantId || data.restaurant || null,
      branchId: data.branchId || metadata.branchId || null,
      employee: data.employee || data.employeeId || null,
      relatedOrder:
        data.relatedOrder ||
        data.relatedOrderId ||
        (data.relatedEntity?.entityType === 'order' ? data.relatedEntity?.entityId : null),
      actionUrl: data.actionUrl || '',
      metadata,
      expiresAt: data.expiresAt || null,
      isRead: false,
    });
    emitNotification(recipientType, recipientId, doc);
    return doc;
  }

  async sendNotification(data) {
    return this.create(data);
  }

  async sendBulkNotifications(items = []) {
    if (!Array.isArray(items) || items.length === 0) return [];
    const docs = [];
    for (const item of items) {
      docs.push(await this.create(item));
    }
    return docs;
  }
  
  buildScopeQuery(scope = {}) {
    const query = {};
    if (scope.branchId) query.branchId = scope.branchId;
    return query;
  }

  async getUnreadCount(recipientId, recipientType, scope = {}) {
    return Notification.countDocuments({
      recipientId,
      recipientType,
      isRead: false,
      ...this.buildScopeQuery(scope),
    });
  }
  
  async markAsRead(notificationId, recipientId, recipientType, scope = {}) {
    const notification = await Notification.findOneAndUpdate(
      { _id: notificationId, recipientId, recipientType, ...this.buildScopeQuery(scope) },
      { isRead: true, readAt: new Date() },
      { new: true }
    );
    if (notification) {
      emitNotificationRead(recipientType, recipientId, {
        notificationId: String(notification._id),
        branchId: notification.branchId ? String(notification.branchId) : null,
      });
    }
    return notification;
  }
  
  async markAllAsRead(recipientId, recipientType, scope = {}) {
    const res = await Notification.updateMany(
      { recipientId, recipientType, isRead: false, ...this.buildScopeQuery(scope) },
      { $set: { isRead: true, readAt: new Date() } }
    );
    emitNotificationAllRead(recipientType, recipientId, {
      modifiedCount: res.modifiedCount || 0,
      branchId: scope.branchId ? String(scope.branchId) : null,
    });
    return res;
  }

  async getUserNotifications(recipientId, recipientType, options = {}) {
    const {
      page = 1,
      limit = 20,
      unreadOnly = false,
      category,
      priority,
      search,
      fromDate,
      toDate,
      branchId,
    } = options;
    const skip = (page - 1) * limit;
    const query = { recipientId, recipientType, ...this.buildScopeQuery({ branchId }) };
    if (unreadOnly) query.isRead = false;
    if (category) query.category = category;
    if (priority) query.priority = priority;
    if (search) {
      const esc = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { title: new RegExp(esc, 'i') },
        { message: new RegExp(esc, 'i') },
      ];
    }
    if (fromDate || toDate) {
      query.createdAt = {};
      if (fromDate) query.createdAt.$gte = new Date(fromDate);
      if (toDate) query.createdAt.$lte = new Date(toDate);
    }
    
    const [notifications, total] = await Promise.all([
      Notification.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Notification.countDocuments(query)
    ]);
    
    return {
      notifications,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  }
}

module.exports = new NotificationService();
