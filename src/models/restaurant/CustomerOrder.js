const mongoose = require('mongoose');

const customerOrderSchema = new mongoose.Schema({
  qrToken: { type: String, required: true, unique: true },
  guestId: { type: String, index: true, default: null },
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
  table: { type: mongoose.Schema.Types.ObjectId, ref: 'Table', required: true },
  customerName: { type: String, required: true },
  customerPhone: String,
  customerEmail: String,
  /** Approved house-account customer (restaurant-scoped credit program) */
  restaurantCreditCustomer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RestaurantCreditCustomer',
    default: null,
    index: true,
  },
  isCreditSale: { type: Boolean, default: false },
  /** Amounts customer declared at QR checkout (pay now / mixed) */
  cashPaidAtCheckout: { type: Number, default: 0 },
  onlinePaidAtCheckout: { type: Number, default: 0 },
  items: [{
    menuItem: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true },
    name: String,
    price: Number,
    quantity: { type: Number, required: true, min: 1 },
    fulfillmentMode: { type: String, enum: ['dine_in', 'parcel'], default: 'dine_in' },
    kitchenStatus: {
      type: String,
      enum: ['queued', 'preparing', 'cooking', 'ready', 'served', 'held', 'cancelled'],
      default: 'queued',
      index: true,
    },
    kitchenStation: { type: String, default: 'main' },
    kitchenStartedAt: { type: Date, default: null },
    kitchenReadyAt: { type: Date, default: null },
    kitchenServedAt: { type: Date, default: null },
    kitchenStatusHistory: [{
      status: String,
      timestamp: { type: Date, default: Date.now },
      updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
      note: String,
    }],
    specialInstructions: String,
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
      quantity: { type: Number, default: 1 },
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
    subtotal: Number
  }],
  itemBatches: [{
    batchNumber: { type: Number, required: true },
    items: [{
      menuItem: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' },
      name: String,
      price: Number,
      quantity: Number,
      fulfillmentMode: { type: String, enum: ['dine_in', 'parcel'], default: 'dine_in' },
      specialInstructions: String,
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
        quantity: { type: Number, default: 1 },
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
      subtotal: Number
    }],
    subtotal: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    serviceChargeAmount: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    statusHistory: [{
      status: String,
      timestamp: { type: Date, default: Date.now },
      note: String
    }],
    createdAt: { type: Date, default: Date.now }
  }],
  totalAmount: { type: Number, required: true },
  taxAmount: { type: Number, default: 0 },
  discountAmount: { type: Number, default: 0 },
  grandTotal: { type: Number, required: true },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'preparing', 'cooking', 'ready', 'served', 'completed', 'cancelled'],
    default: 'pending'
  },
  statusHistory: [{
    status: String,
    timestamp: { type: Date, default: Date.now },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
    note: String
  }],
  estimatedWaitTime: Number,
  actualWaitTime: Number,
  /** Kitchen delay notice shown to customer (real-time via socket) */
  kitchenDelayMinutes: { type: Number, default: 0 },
  kitchenDelayMessage: { type: String, default: '' },
  kitchenDelayUpdatedAt: { type: Date },
  paymentStatus: { type: String, enum: ['pending', 'partial', 'paid', 'failed'], default: 'pending' },
  /** Revenue channel for P&L / ERP analytics */
  orderChannel: {
    type: String,
    enum: ['dine_in', 'qr_ordering', 'delivery', 'takeaway'],
    default: 'qr_ordering',
    index: true,
  },
  /** 'pending' = customer will choose pay now / credit after food is served (QR defer flow) */
  paymentMethod: {
    type: String,
    /** New orders use cash | online | mixed | credit | pending. Legacy values kept so old rows still validate on save. */
    enum: ['pending', 'cash', 'online', 'mixed', 'credit', 'upi', 'card', 'wallet', 'esewa', 'khalti', 'fonepay'],
  },
  /** True when checkout skipped payment; customer pays from order track after served */
  customerPaymentDeferred: { type: Boolean, default: false },
  /** Guest told staff how they will pay (cash / online / split); does not mark paid */
  guestPaymentPreferenceAt: { type: Date, default: null },
  guestPaymentPreferenceCash: { type: Number, default: 0 },
  guestPaymentPreferenceOnline: { type: Number, default: 0 },
  orderNumber: { type: String, unique: true },
  specialRequests: String,
  createdBy: {
    type: {
      type: String,
      enum: ['waiter', 'qr', 'cashier', 'manager', 'restaurant'],
      default: 'qr',
      required: true,
    },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  },
  /** POS-only context; optional for QR orders */
  posDetails: {
    mode: { type: String, enum: ['dine_in', 'takeaway', 'delivery'] },
    pickupToken: { type: String, default: '' },
    deliveryAddress: { type: String, default: '' },
    riderName: { type: String, default: '' },
    riderPhone: { type: String, default: '' },
    deliveryCharge: { type: Number, default: 0 },
    guestsCount: { type: Number, default: 0 },
    serviceChargeAmount: { type: Number, default: 0 },
    taxInclusive: { type: Boolean, default: false },
    promoCode: { type: String, default: '' },
    loyaltyPointsEarned: { type: Number, default: 0 },
    loyaltyPointsRedeemed: { type: Number, default: 0 },
  },
  /** Sum of successful split payments (denormalized for quick POS balance) */
  amountPaidTotal: { type: Number, default: 0 },
  checkoutRequestId: { type: String, default: '', index: true },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

customerOrderSchema.index({ restaurant: 1, status: 1, createdAt: -1 });
customerOrderSchema.index({ restaurantId: 1, branchId: 1, status: 1, createdAt: -1 });
customerOrderSchema.index({ guestId: 1, createdAt: -1 });
customerOrderSchema.index({ qrToken: 1 });
customerOrderSchema.index({ orderNumber: 1 });
customerOrderSchema.index({ createdAt: -1 });
customerOrderSchema.index(
  { restaurant: 1, guestId: 1, checkoutRequestId: 1 },
  { unique: true, partialFilterExpression: { checkoutRequestId: { $type: 'string', $gt: '' } } },
);

const { generateUniqueOrderNumber } = require('../../utils/orderNumber');

customerOrderSchema.pre('save', async function(next) {
  if (!this.restaurantId && this.restaurant) this.restaurantId = this.restaurant;
  if (this.isNew && !this.orderNumber) {
    try {
      this.orderNumber = await generateUniqueOrderNumber();
    } catch (err) {
      return next(err);
    }
  }
  next();
});

module.exports = mongoose.model('CustomerOrder', customerOrderSchema);
