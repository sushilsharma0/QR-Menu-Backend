const mongoose = require('mongoose');

const INVENTORY_UNITS = ['kg', 'gram', 'liter', 'ml', 'piece', 'packet', 'bottle', 'carton', 'box', 'other'];

const inventoryItemSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    name: { type: String, required: true, trim: true },
    unit: { type: String, required: true, trim: true, default: 'piece' },
    quantity: { type: Number, required: true, min: 0, default: 0 },
    openingStock: { type: Number, default: 0, min: 0 },
    minimumStock: { type: Number, required: true, min: 0, default: 0 },
    costPerUnit: { type: Number, required: true, min: 0, default: 0 },
    supplier: { type: String, trim: true, default: '' },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null },
    category: { type: String, trim: true, default: 'general' },
    purchaseUnit: { type: String, trim: true, default: '' },
    conversionFactor: { type: Number, default: 1, min: 0 },
    manufacturingDate: { type: Date, default: null },
    expiryDate: { type: Date, default: null, index: true },
    notes: { type: String, trim: true, default: '' },
    invoiceDocumentUrl: { type: String, default: '' },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

inventoryItemSchema.index({ restaurantId: 1, branchId: 1, name: 1 }, { unique: true });
inventoryItemSchema.index({ restaurantId: 1, branchId: 1, category: 1 });

const InventoryItem = mongoose.model('InventoryItem', inventoryItemSchema);
InventoryItem.INVENTORY_UNITS = INVENTORY_UNITS;
module.exports = InventoryItem;
