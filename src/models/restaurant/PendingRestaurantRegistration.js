const mongoose = require('mongoose');

const pendingRestaurantRegistrationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, required: true, trim: true },
    phoneNormalized: { type: String, trim: true, default: '', select: false },
    password: { type: String, required: true, select: false },
    address: { type: String, default: '' },
    slug: { type: String, required: true },
    referralCode: { type: String, trim: true, uppercase: true, default: '' },
    referredByRestaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant' },
    emailVerificationOTP: { type: String, required: true, select: false },
    emailVerificationOTPExpiry: { type: Date, required: true },
  },
  { timestamps: true },
);

pendingRestaurantRegistrationSchema.index({ emailVerificationOTPExpiry: 1 }, { expireAfterSeconds: 0 });
pendingRestaurantRegistrationSchema.index(
  { phoneNormalized: 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: { phoneNormalized: { $type: 'string', $gt: '' } },
  },
);

pendingRestaurantRegistrationSchema.pre('validate', function normalizePendingPhone(next) {
  const digits = String(this.phone || '').replace(/\D/g, '');
  this.phoneNormalized = digits.length >= 7 ? digits : '';
  next();
});

module.exports = mongoose.model('PendingRestaurantRegistration', pendingRestaurantRegistrationSchema);
