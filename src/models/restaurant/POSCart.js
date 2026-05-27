const mongoose = require('mongoose');

/** Server-side POS cart draft for multi-device handoff (optional). */
const posCartSchema = new mongoose.Schema(
  {
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    keyedBy: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    expiresAt: { type: Date, index: true },
  },
  { timestamps: true }
);

posCartSchema.index({ restaurant: 1, keyedBy: 1 }, { unique: true });

module.exports = mongoose.model('POSCart', posCartSchema);
