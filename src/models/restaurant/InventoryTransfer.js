const mongoose = require('mongoose');

const inventoryTransferSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    fromBranchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    toBranchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    inventoryItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true, index: true },
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, trim: true, default: '' },
    status: { type: String, enum: ['draft', 'requested', 'approved', 'in_transit', 'completed', 'cancelled'], default: 'requested' },
    note: { type: String, trim: true, default: '' },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'requestedByModel', default: null },
    requestedByModel: { type: String, enum: ['Restaurant', 'Employee'], default: 'Restaurant' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'approvedByModel', default: null },
    approvedByModel: { type: String, enum: ['Restaurant', 'Employee'], default: 'Restaurant' },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

inventoryTransferSchema.index({ restaurantId: 1, createdAt: -1 });

module.exports = mongoose.model('InventoryTransfer', inventoryTransferSchema);
