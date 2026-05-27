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

const discountSchema = new mongoose.Schema(
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
    discount: { type: discountSchema, default: () => ({}) },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

const variationGroupSchema = new mongoose.Schema(
  {
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
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
    selectionType: {
      type: String,
      enum: ['single', 'multiple', 'quantity'],
      default: 'single',
    },
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
    isTemplate: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    options: { type: [variationOptionSchema], default: [] },
    nestedGroups: { type: [mongoose.Schema.Types.Mixed], default: [] },
    incompatibleOptionPairs: [{
      optionA: { type: mongoose.Schema.Types.ObjectId },
      optionB: { type: mongoose.Schema.Types.ObjectId },
      reason: { type: String, trim: true, default: '' },
    }],
    createdBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'createdByModel' },
    createdByModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth'], default: 'Restaurant' },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

variationGroupSchema.index({ restaurant: 1, branchId: 1, name: 1, isDeleted: 1 });
variationGroupSchema.index({ restaurant: 1, branchId: 1, type: 1, isActive: 1 });
variationGroupSchema.index({ 'options.sku': 1 });

module.exports = mongoose.model('VariationGroup', variationGroupSchema);
