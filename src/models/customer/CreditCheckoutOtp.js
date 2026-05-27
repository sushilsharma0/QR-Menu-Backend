const mongoose = require('mongoose');

const creditCheckoutOtpSchema = new mongoose.Schema(
  {
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    guestId: { type: String, required: true },
    code: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true },
);

creditCheckoutOtpSchema.index({ restaurant: 1, email: 1, guestId: 1 });

module.exports = mongoose.model('CreditCheckoutOtp', creditCheckoutOtpSchema);
