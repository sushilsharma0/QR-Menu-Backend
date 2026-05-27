const mongoose = require('mongoose');

const invoiceSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    invoiceNumber: { type: String, required: true, unique: true, index: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerOrder', required: true, index: true },
    customerId: { type: String, default: '' },
    subtotal: { type: Number, required: true, min: 0 },
    tax: { type: Number, required: true, min: 0, default: 0 },
    serviceCharge: { type: Number, required: true, min: 0, default: 0 },
    total: { type: Number, required: true, min: 0 },
    paymentStatus: { type: String, enum: ['pending', 'paid', 'failed', 'refunded'], default: 'pending' },
    paymentMethod: { type: String, default: 'cash' },
    generatedBy: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: 'generatedByModel' },
    generatedByModel: { type: String, enum: ['Restaurant', 'Employee'], required: true },
    waiterName: { type: String, default: '' },
    customerName: { type: String, default: '' },
    issuedAt: { type: Date, default: Date.now, index: true },
    lockedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

invoiceSchema.index({ restaurantId: 1, issuedAt: -1 });

invoiceSchema.pre('save', function(next) {
  if (!this.isNew && this.lockedAt) {
    const allowed = new Set(['lockedAt', 'updatedAt']);
    const illegal = this.modifiedPaths().filter((path) => !allowed.has(path));
    if (illegal.length) return next(new Error('Issued invoices are immutable'));
  }
  return next();
});

module.exports = mongoose.model('Invoice', invoiceSchema);
