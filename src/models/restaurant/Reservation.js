const mongoose = require('mongoose');

const reservationSchema = new mongoose.Schema(
  {
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    table: { type: mongoose.Schema.Types.ObjectId, ref: 'Table', default: null },
    customerName: { type: String, required: true, trim: true },
    customerPhone: { type: String, trim: true, default: '' },
    customerEmail: { type: String, trim: true, lowercase: true, default: '' },
    partySize: { type: Number, required: true, min: 1, default: 2 },
    reservationAt: { type: Date, required: true, index: true },
    durationMinutes: { type: Number, default: 90, min: 15 },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show'],
      default: 'pending',
      index: true,
    },
    source: { type: String, enum: ['staff', 'customer', 'phone', 'walk_in'], default: 'staff' },
    notes: { type: String, default: '' },
    statusHistory: [{
      status: String,
      timestamp: { type: Date, default: Date.now },
      updatedBy: { type: mongoose.Schema.Types.ObjectId },
      note: String,
    }],
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

reservationSchema.pre('validate', function setRestaurantId(next) {
  if (!this.restaurantId && this.restaurant) this.restaurantId = this.restaurant;
  next();
});

reservationSchema.index({ restaurant: 1, branchId: 1, reservationAt: 1, status: 1 });
reservationSchema.index({ restaurantId: 1, branchId: 1, reservationAt: 1 });

module.exports = mongoose.model('Reservation', reservationSchema);
