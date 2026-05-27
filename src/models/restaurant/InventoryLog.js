const mongoose = require('mongoose');

const inventoryLogSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    inventoryItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true, index: true },
    type: {
      type: String,
      enum: ['stock_in', 'stock_out', 'purchase', 'usage', 'wastage', 'adjustment', 'recipe_sale'],
      required: true,
      index: true,
    },
    quantity: { type: Number, required: true, min: 0 },
    totalCost: { type: Number, required: true, min: 0, default: 0 },
    linkedOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerOrder' },
    linkedPurchaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryPurchase', default: null, index: true },
    referenceNumber: { type: String, trim: true, default: '' },
    note: { type: String, trim: true },
    approval: { type: mongoose.Schema.Types.ObjectId, ref: 'AccountingApproval', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: 'createdByModel' },
    createdByModel: { type: String, enum: ['Restaurant', 'Employee'], required: true },
  },
  { timestamps: true },
);

inventoryLogSchema.index({ restaurantId: 1, branchId: 1, createdAt: -1 });

inventoryLogSchema.pre('save', function(next) {
  if (!this.isNew) return next(new Error('Inventory movement logs are immutable'));
  return next();
});

module.exports = mongoose.model('InventoryLog', inventoryLogSchema);
