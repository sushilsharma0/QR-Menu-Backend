const mongoose = require('mongoose');

const customerFeedbackSchema = new mongoose.Schema({
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
  table: { type: mongoose.Schema.Types.ObjectId, ref: 'Table', default: null },
  guestId: { type: String, index: true },
  qrToken: { type: String },
  systemRating: { type: Number, min: 1, max: 5, required: true },
  serviceRating: { type: String, enum: ['great', 'average', 'poor'], required: true },
  comment: { type: String, default: '' },
  customerName: { type: String, default: 'Guest customer' },
  itemRatings: [{
    menuItem: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' },
    rating: { type: Number, min: 1, max: 5 },
    comment: { type: String, default: '' },
  }],
  reviewImages: [{ type: String }],
  isPublic: { type: Boolean, default: true },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

customerFeedbackSchema.index({ restaurant: 1, isActive: 1, isPublic: 1, createdAt: -1 });

module.exports = mongoose.model('CustomerFeedback', customerFeedbackSchema);
