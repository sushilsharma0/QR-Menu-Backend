const mongoose = require('mongoose');

const promotionSchema = new mongoose.Schema(
  {
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    discountType: { type: String, enum: ['flat', 'percent'], required: true },
    discountValue: { type: Number, required: true, min: 0 },
    scope: { type: String, enum: ['order', 'item'], default: 'order' },
    targetMenuItems: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' }],
    minOrderAmount: { type: Number, default: 0, min: 0 },
    maxDiscountAmount: { type: Number, default: null, min: 0 },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    usageLimit: { type: Number, default: null, min: 1 },
    usedCount: { type: Number, default: 0, min: 0 },
    bannerText: { type: String, default: '' },
    bannerColor: { type: String, default: '#f97316' },
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

promotionSchema.index(
  { restaurant: 1, branchId: 1, code: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);
promotionSchema.index({ restaurant: 1, branchId: 1, isActive: 1, isDeleted: 1 });

module.exports = mongoose.model('Promotion', promotionSchema);
