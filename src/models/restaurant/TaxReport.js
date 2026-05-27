const mongoose = require('mongoose');

const taxReportSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    fromDate: { type: Date, required: true },
    toDate: { type: Date, required: true },
    taxType: { type: String, enum: ['vat', 'gst'], default: 'vat' },
    taxableAmount: { type: Number, default: 0, min: 0 },
    taxCollected: { type: Number, default: 0, min: 0 },
    serviceChargeCollected: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

taxReportSchema.index({ restaurantId: 1, fromDate: -1, toDate: -1 });

module.exports = mongoose.model('TaxReport', taxReportSchema);
