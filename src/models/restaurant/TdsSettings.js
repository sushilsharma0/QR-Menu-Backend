const mongoose = require('mongoose');

const tdsSettingsSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, unique: true },
    /** Simplified flat rate applied to taxable payroll (Nepal-style TDS placeholder) */
    defaultTdsPercent: { type: Number, default: 1, min: 0, max: 100 },
    /** Employee EPF % on full monthly basic (deducted from net pay). */
    defaultEpfPercent: { type: Number, default: 0, min: 0, max: 100 },
    /** Employer EPF % on full monthly basic (company cost; not deducted from employee net pay). */
    defaultEmployerEpfPercent: { type: Number, default: 0, min: 0, max: 100 },
    enabled: { type: Boolean, default: true },
    notes: { type: String, trim: true, default: '' },
  },
  { timestamps: true },
);

tdsSettingsSchema.statics.getForRestaurant = async function getForRestaurant(restaurantId) {
  let doc = await this.findOne({ restaurantId });
  if (!doc) {
    doc = await this.create({ restaurantId, defaultTdsPercent: 1, enabled: true });
  }
  return doc;
};

module.exports = mongoose.model('TdsSettings', tdsSettingsSchema);
