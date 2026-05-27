const mongoose = require('mongoose');

const customerCartItemSchema = new mongoose.Schema(
  {
    menuItem: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true },
    quantity: { type: Number, required: true, min: 1, default: 1 },
    price: { type: Number, required: true, default: 0 },
    notes: { type: String, default: '' },
    cookingInstructions: { type: String, default: '' },
    customizations: [{
      name: { type: String },
      value: { type: String },
    }],
    addOns: [{ type: String }],
    selectedVariations: [{
      groupId: { type: mongoose.Schema.Types.ObjectId },
      groupName: { type: String },
      groupType: { type: String },
      selectionType: { type: String },
      optionId: { type: mongoose.Schema.Types.ObjectId },
      optionName: { type: String },
      sku: { type: String, default: '' },
      quantity: { type: Number, default: 1, min: 0 },
      unitPrice: { type: Number, default: 0 },
      totalPrice: { type: Number, default: 0 },
      discountedPrice: { type: Number, default: null },
      taxRate: { type: Number, default: null },
      calories: { type: Number, default: null },
      image: { type: String, default: '' },
      preparationTimeModifier: { type: Number, default: 0 },
      isAddOn: { type: Boolean, default: false },
    }],
    priceSnapshot: {
      basePrice: { type: Number, default: 0 },
      variationPrice: { type: Number, default: 0 },
      addOnPrice: { type: Number, default: 0 },
      discountAmount: { type: Number, default: 0 },
      taxRate: { type: Number, default: 0 },
      taxAmount: { type: Number, default: 0 },
      unitPrice: { type: Number, default: 0 },
      lineSubtotal: { type: Number, default: 0 },
      lineTotal: { type: Number, default: 0 },
    },
  },
  { _id: true }
);

const customerCartSchema = new mongoose.Schema(
  {
    guestId: { type: String, required: true, index: true },
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    table: { type: mongoose.Schema.Types.ObjectId, ref: 'Table', required: true, index: true },
    items: { type: [customerCartItemSchema], default: [] },
    totalAmount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

customerCartSchema.index({ guestId: 1, restaurant: 1, table: 1 }, { unique: true });

module.exports = mongoose.model('CustomerCart', customerCartSchema);
