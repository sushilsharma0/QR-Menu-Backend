const mongoose = require('mongoose');

const guestLoyaltySchema = new mongoose.Schema(
  {
    guestId: { type: String, required: true, index: true },
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    points: { type: Number, default: 0, min: 0 },
    lifetimePoints: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

guestLoyaltySchema.index({ guestId: 1, restaurant: 1 }, { unique: true });

module.exports = mongoose.model('GuestLoyalty', guestLoyaltySchema);
