const mongoose = require('mongoose');

const customerIdentitySchema = new mongoose.Schema(
  {
    customerId: { type: String, required: true, unique: true, index: true },
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
    passwordHash: { type: String, select: false },
    linkedGuestIds: [{ type: String }],
    primaryGuestId: { type: String, required: true, index: true },
    lastTable: { type: mongoose.Schema.Types.ObjectId, ref: 'Table', default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

customerIdentitySchema.index(
  { restaurant: 1, phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: 'string', $gt: '' } } },
);
customerIdentitySchema.index(
  { restaurant: 1, email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string', $gt: '' } } },
);

module.exports = mongoose.model('CustomerIdentity', customerIdentitySchema);
