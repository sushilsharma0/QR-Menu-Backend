const mongoose = require('mongoose');

const inventorySchema = new mongoose.Schema({
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  menuItem: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' },
  name: { type: String, required: true },
  category: { type: String },
  unit: { type: String, default: 'pcs' },
  quantity: { type: Number, default: 0 },
  minStock: { type: Number, default: 5 },
  costPrice: { type: Number, default: 0 },
  sellingPrice: { type: Number },
  supplier: String,
  lastRestocked: Date,
  isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

inventorySchema.index({ restaurant: 1, name: 1 });
inventorySchema.index({ restaurant: 1, category: 1 });

module.exports = mongoose.model('Inventory', inventorySchema);