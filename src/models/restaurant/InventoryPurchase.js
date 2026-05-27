const mongoose = require('mongoose');

const inventoryPurchaseSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    inventoryItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true, index: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null },
    quantity: { type: Number, required: true, min: 0 },
    unitCost: { type: Number, required: true, min: 0 },
    totalCost: { type: Number, required: true, min: 0 },
    taxAmount: { type: Number, default: 0, min: 0 },
    vatPercent: { type: Number, default: 0, min: 0 },
    supplier: { type: String, trim: true, default: '' },
    supplierBillNumber: { type: String, trim: true, default: '' },
    paymentStatus: { type: String, enum: ['pending', 'partial', 'paid'], default: 'paid', index: true },
    validationStatus: { type: String, enum: ['pending', 'validated', 'rejected'], default: 'validated', index: true },
    approval: { type: mongoose.Schema.Types.ObjectId, ref: 'AccountingApproval', default: null },
    /** When paymentStatus is paid, which balance this purchase drew from */
    paymentSource: { type: String, enum: ['cash', 'bank'], default: 'cash', index: true },
    invoiceDocumentUrl: { type: String, default: '' },
    notes: { type: String, trim: true, default: '' },
    purchasedAt: { type: Date, default: Date.now, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: 'createdByModel' },
    createdByModel: { type: String, enum: ['Restaurant', 'Employee'], required: true },
    lockedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

inventoryPurchaseSchema.pre('save', function(next) {
  if (!this.isNew && this.lockedAt) return next(new Error('Locked purchase cannot be modified'));
  return next();
});

module.exports = mongoose.model('InventoryPurchase', inventoryPurchaseSchema);
