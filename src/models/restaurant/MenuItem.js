const mongoose = require('mongoose');

const branchPriceSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    price: { type: Number, min: 0, default: 0 },
    discountedPrice: { type: Number, min: 0, default: null },
  },
  { _id: false },
);

const scheduledPriceSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: '' },
    startsAt: { type: Date },
    endsAt: { type: Date },
    daysOfWeek: [{ type: Number, min: 0, max: 6 }],
    orderTypes: [{
      type: String,
      enum: ['dine_in', 'takeaway', 'delivery', 'qr_ordering', 'pos'],
    }],
    price: { type: Number, min: 0, default: null },
    discountedPrice: { type: Number, min: 0, default: null },
  },
  { _id: false },
);

const variationDiscountSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['none', 'percentage', 'fixed'], default: 'none' },
    value: { type: Number, min: 0, default: 0 },
    startsAt: { type: Date },
    endsAt: { type: Date },
    label: { type: String, trim: true, default: '' },
  },
  { _id: false },
);

const variationOptionSchema = new mongoose.Schema(
  {
    templateOptionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    name: { type: String, required: true, trim: true },
    sku: { type: String, trim: true, default: '' },
    additionalPrice: { type: Number, min: 0, default: 0 },
    discountedPrice: { type: Number, min: 0, default: null },
    stockQuantity: { type: Number, min: 0, default: null },
    trackInventory: { type: Boolean, default: false },
    lowStockThreshold: { type: Number, min: 0, default: 0 },
    preparationTimeModifier: { type: Number, default: 0 },
    image: { type: String, default: '' },
    imagePublicId: { type: String, default: '' },
    isAvailable: { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false },
    calories: { type: Number, min: 0, default: null },
    taxClass: { type: String, trim: true, default: '' },
    taxRate: { type: Number, min: 0, max: 100, default: null },
    quantityStep: { type: Number, min: 1, default: 1 },
    minQuantity: { type: Number, min: 0, default: 0 },
    maxQuantity: { type: Number, min: 0, default: 1 },
    branchPrices: { type: [branchPriceSchema], default: [] },
    scheduledPrices: { type: [scheduledPriceSchema], default: [] },
    discount: { type: variationDiscountSchema, default: () => ({}) },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: true },
);

const variationGroupSnapshotSchema = new mongoose.Schema(
  {
    template: { type: mongoose.Schema.Types.ObjectId, ref: 'VariationGroup', default: null },
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: [
        'size',
        'portion',
        'volume',
        'weight',
        'pieces',
        'combo',
        'temperature',
        'flavor',
        'spice',
        'crust',
        'preparation',
        'addon',
        'topping',
        'custom',
      ],
      default: 'custom',
    },
    selectionType: { type: String, enum: ['single', 'multiple', 'quantity'], default: 'single' },
    /** additive: option price adds to base; tier: option price is the full item price (portion/size) */
    pricingMode: { type: String, enum: ['additive', 'tier'], default: 'additive' },
    isRequired: { type: Boolean, default: false },
    minSelection: { type: Number, min: 0, default: 0 },
    maxSelection: { type: Number, min: 0, default: 1 },
    displayType: {
      type: String,
      enum: ['radio', 'checkbox', 'dropdown', 'chips', 'cards', 'image', 'toggle', 'stepper'],
      default: 'radio',
    },
    sortOrder: { type: Number, default: 0 },
    allowQuantity: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    options: { type: [variationOptionSchema], default: [] },
    nestedGroups: { type: [mongoose.Schema.Types.Mixed], default: [] },
    incompatibleOptionPairs: [{
      optionA: { type: mongoose.Schema.Types.ObjectId },
      optionB: { type: mongoose.Schema.Types.ObjectId },
      reason: { type: String, trim: true, default: '' },
    }],
  },
  { _id: true },
);

const menuItemSchema = new mongoose.Schema({
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
  name: { type: String, required: true },
  sku: { type: String, trim: true, default: '' },
  barcode: { type: String, trim: true, default: '' },
  description: { type: String },
  price: { type: Number, required: true },
  originalPrice: { type: Number },
  image: { type: String },
  imagePublicId:{type: String},
  isAvailable: { type: Boolean, default: true },
  isVegetarian: { type: Boolean, default: false },
  isVegan: { type: Boolean, default: false },
  isSpicy: { type: Boolean, default: false },
  isGlutenFree: { type: Boolean, default: false },
  /**
   * Cuisine/meat tags chosen by the restaurant admin (e.g. veg, chicken,
   * mutton, buff). Drives the customer "Type" filter chips on the menu.
   * Multiple tags may be set (e.g. an item containing both chicken & egg).
   */
  dietaryTags: {
    type: [{
      type: String,
      enum: ['veg', 'chicken', 'mutton', 'buff', 'pork', 'fish', 'seafood', 'egg'],
    }],
    default: [],
  },
  /**
   * Per-serving nutrition. All fields optional — the customer detail page
   * hides the "Nutritional Facts" panel entirely when nothing has been set.
   */
  nutrition: {
    calories: { type: Number, min: 0 },
    protein: { type: Number, min: 0 },
    carbs: { type: Number, min: 0 },
    fat: { type: Number, min: 0 },
    fiber: { type: Number, min: 0 },
  },
  preparationTime: { type: Number, default: 15 },
  taxRate: { type: Number, default: 0 },
  sortOrder: { type: Number, default: 0 },
  /** e.g. [{ name: "Spice Level", options: ["Mild", "Medium", "Hot"] }] */
  customizations: [{
    name: { type: String, required: true },
    options: [{ type: String }],
  }],
  variationGroups: { type: [variationGroupSnapshotSchema], default: [] },
  variationPricing: {
    dineInAdjustment: { type: Number, default: 0 },
    takeawayAdjustment: { type: Number, default: 0 },
    deliveryAdjustment: { type: Number, default: 0 },
    branchPrices: { type: [branchPriceSchema], default: [] },
    scheduledPrices: { type: [scheduledPriceSchema], default: [] },
    discount: { type: variationDiscountSchema, default: () => ({}) },
  },
  isBestseller: { type: Boolean, default: false },
  /** chef_special | trending | popular_tonight — shown as badges on customer menu */
  highlightTag: { type: String, enum: ['', 'chef_special', 'trending', 'popular_tonight'], default: '' },
  /** BOM: quantities use the linked inventory item's unit (e.g. gram, kg). */
  recipe: [
    {
      inventoryItem: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
      quantity: { type: Number, required: true, min: 0 },
    },
  ],
  isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

menuItemSchema.index({ restaurant: 1, branchId: 1, category: 1 });
menuItemSchema.index({ restaurant: 1, branchId: 1, isAvailable: 1 });
menuItemSchema.index({ restaurant: 1, branchId: 1, sku: 1 });
menuItemSchema.index({ restaurant: 1, branchId: 1, barcode: 1 });
menuItemSchema.index({ restaurant: 1, branchId: 1, name: 'text', description: 'text' });
menuItemSchema.index({ restaurant: 1, branchId: 1, dietaryTags: 1 });
menuItemSchema.index({ restaurant: 1, branchId: 1, 'variationGroups.options.sku': 1 });

module.exports = mongoose.model('MenuItem', menuItemSchema);
