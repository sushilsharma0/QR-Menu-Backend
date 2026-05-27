const mongoose = require('mongoose');

/** One pending OTP per restaurant + owner email (branch creation verification). */
const branchOwnerOtpSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    ownerEmail: { type: String, required: true, trim: true, lowercase: true },
    otp: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true },
);

branchOwnerOtpSchema.index({ restaurantId: 1, ownerEmail: 1 }, { unique: true });

module.exports = mongoose.model('BranchOwnerOtp', branchOwnerOtpSchema);
