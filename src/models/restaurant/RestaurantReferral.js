const mongoose = require('mongoose');

const restaurantReferralSchema = new mongoose.Schema(
  {
    referrerRestaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      required: true,
      index: true,
    },
    referredRestaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      required: true,
      unique: true,
      index: true,
    },
    referralCode: { type: String, required: true, trim: true, uppercase: true },
    status: {
      type: String,
      enum: ['pending', 'qualified', 'rewarded', 'cancelled'],
      default: 'pending',
      index: true,
    },
    rewardDays: { type: Number, default: 30 },
    qualifiedAt: Date,
    referredAwardedAt: Date,
    referrerAwardedAt: Date,
    awardedAt: Date,
    activatedByPayment: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPayment' },
    referrerPreviousPlanEndDate: Date,
    referrerNewPlanEndDate: Date,
    referredPreviousPlanEndDate: Date,
    referredNewPlanEndDate: Date,
    notes: String,
  },
  { timestamps: true },
);

restaurantReferralSchema.index({ referralCode: 1, createdAt: -1 });

module.exports = mongoose.model('RestaurantReferral', restaurantReferralSchema);
