const mongoose = require('mongoose');
const InventoryItem = require('./InventoryItem');

const UNITS = InventoryItem.INVENTORY_UNITS;

const recipeSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      required: true,
      index: true,
    },
    menuItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MenuItem',
      required: true,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      required: true,
      index: true,
    },
    ingredients: [
      {
        inventoryItem: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'InventoryItem',
          required: true,
        },
        quantity: { type: Number, required: true, min: 0 },
        unit: { type: String, required: true, enum: UNITS },
      },
    ],
  },
  { timestamps: true },
);

recipeSchema.index({ restaurantId: 1, branchId: 1, menuItem: 1 }, { unique: true });

module.exports = mongoose.model('Recipe', recipeSchema);
