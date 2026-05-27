const mongoose = require('mongoose');

const posInvoiceSchema = new mongoose.Schema(
  {
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    customerOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CustomerOrder',
      required: true,
    },
    invoiceNumber: { type: String, required: true },
    pdfPath: { type: String, default: '' },
    status: { type: String, enum: ['draft', 'locked', 'voided'], default: 'draft', index: true },
    lockedAt: { type: Date, default: null },
    lockedBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'lockedByModel', default: null },
    lockedByModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth'], default: 'Employee' },
    voidedAt: { type: Date, default: null },
    voidedBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'voidedByModel', default: null },
    voidedByModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth'], default: 'Employee' },
    voidReason: { type: String, default: '' },
    totals: {
      subtotal: Number,
      taxAmount: Number,
      serviceCharge: Number,
      discountAmount: Number,
      grandTotal: Number,
    },
  },
  { timestamps: true }
);

posInvoiceSchema.index({ restaurant: 1, branchId: 1, invoiceNumber: 1 }, { unique: true });
posInvoiceSchema.index({ customerOrder: 1 }, { unique: true });

posInvoiceSchema.pre('save', function(next) {
  if (!this.isNew && this.lockedAt) {
    const allowed = new Set(['status', 'voidedAt', 'voidedBy', 'voidedByModel', 'voidReason', 'updatedAt']);
    const illegal = this.modifiedPaths().filter((path) => !allowed.has(path));
    if (illegal.length && this.status !== 'voided') {
      return next(new Error('Locked invoice cannot be modified'));
    }
  }
  return next();
});

module.exports = mongoose.model('POSInvoice', posInvoiceSchema);
