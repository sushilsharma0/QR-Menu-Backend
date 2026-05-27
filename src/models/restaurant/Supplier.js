const mongoose = require('mongoose');

const supplierSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, default: '' },
    address: { type: String, trim: true, default: '' },
    panVat: { type: String, trim: true, default: '' },
    paymentDue: { type: Number, default: 0, min: 0 },
    verificationStatus: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending', index: true },
    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'verifiedByModel', default: null },
    verifiedByModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth'], default: 'Restaurant' },
    notes: { type: String, trim: true, default: '' },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

supplierSchema.index({ restaurantId: 1, name: 1 });

module.exports = mongoose.model('Supplier', supplierSchema);
