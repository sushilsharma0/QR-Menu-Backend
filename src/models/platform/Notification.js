const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  recipientType: {
    type: String,
    required: true,
    enum: ['platform', 'restaurant', 'employee', 'customer'],
  },
  recipientId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', default: null, index: true },
  restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', default: null, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null, index: true },
  title: { type: String, required: true, trim: true },
  message: { type: String, required: true, trim: true },
  type: { type: String, required: true, trim: true },
  priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
  category: { type: String, default: 'general', index: true },
  relatedEntity: {
    entityType: { type: String, default: null },
    entityId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  relatedOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerOrder', default: null, index: true },
  actionUrl: { type: String, default: '' },
  isRead: { type: Boolean, default: false },
  readAt: Date,
  expiresAt: Date,
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

notificationSchema.index({ recipientType: 1, recipientId: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ recipientType: 1, recipientId: 1, category: 1, priority: 1, createdAt: -1 });
notificationSchema.index({ restaurantId: 1, branchId: 1, createdAt: -1 });

notificationSchema.on('index', async function(error) {
  if (error) return;
  try {
    await this.collection.dropIndex('expiresAt_1');
  } catch (dropError) {
    if (
      dropError &&
      dropError.codeName !== 'IndexNotFound' &&
      !/index not found/i.test(dropError.message)
    ) {
      console.error('Error dropping legacy notification TTL index:', dropError);
    }
  }
});

module.exports = mongoose.model('Notification', notificationSchema);
