const mongoose = require('mongoose');

const customerIdentityOtpSchema = new mongoose.Schema(
  {
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    guestId: { type: String, required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    code: { type: String, required: true },
    purpose: { type: String, enum: ['signup', 'login', 'reset'], default: 'signup' },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

customerIdentityOtpSchema.index({ restaurant: 1, email: 1, guestId: 1, purpose: 1 });
customerIdentityOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('CustomerIdentityOtp', customerIdentityOtpSchema);
