const mongoose = require('mongoose');

const taxSettingsSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, unique: true, index: true },
    taxType: { type: String, enum: ['vat', 'gst'], default: 'vat' },
    vatRate: { type: Number, default: 13, min: 0, max: 100 },
    serviceChargeRate: { type: Number, default: 0, min: 0, max: 100 },
    enabled: { type: Boolean, default: true },
    pricingMode: { type: String, enum: ['inclusive', 'exclusive'], default: 'inclusive' },
  },
  { timestamps: true },
);

taxSettingsSchema.statics.getForRestaurant = function getForRestaurant(restaurantId) {
  return this.findOneAndUpdate(
    { restaurantId },
    { $setOnInsert: { restaurantId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
};

module.exports = mongoose.model('TaxSettings', taxSettingsSchema);
