const mongoose = require('mongoose');

const restaurantCreditCustomerSchema = new mongoose.Schema(
  {
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, default: '', trim: true },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'suspended'],
      default: 'pending',
      index: true,
    },
    notes: { type: String, default: '' },
    rejectedReason: { type: String, default: '' },
    creditLimit: { type: Number, default: 0 },
    approvedAt: { type: Date },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant' },
  },
  { timestamps: true },
);

restaurantCreditCustomerSchema.index({ restaurant: 1, branchId: 1, email: 1 }, { unique: true });

module.exports = mongoose.model('RestaurantCreditCustomer', restaurantCreditCustomerSchema);
