const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  menuItem: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' },
  name: String,
  quantity: { type: Number, default: 1 },
  price: Number,
  selectedVariations: [{
    groupId: { type: mongoose.Schema.Types.ObjectId },
    groupName: { type: String },
    groupType: { type: String },
    optionId: { type: mongoose.Schema.Types.ObjectId },
    optionName: { type: String },
    quantity: { type: Number, default: 1 },
    unitPrice: { type: Number, default: 0 },
    totalPrice: { type: Number, default: 0 },
    isAddOn: { type: Boolean, default: false },
  }],
  priceSnapshot: {
    basePrice: { type: Number, default: 0 },
    variationPrice: { type: Number, default: 0 },
    addOnPrice: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    unitPrice: { type: Number, default: 0 },
    lineSubtotal: { type: Number, default: 0 },
    lineTotal: { type: Number, default: 0 },
  },
  note: String
});

const orderSchema = new mongoose.Schema({
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
  table: { type: mongoose.Schema.Types.ObjectId, ref: 'Table', required: true },
  items: [orderItemSchema],
  status: { type: String, enum: ['pending', 'preparing', 'ready', 'served', 'cancelled'], default: 'pending' },
  totalAmount: Number,
  handledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
  note: String,
  orderNumber: { type: String, unique: true },
  guest_id:String
}, { timestamps: true });

const { generateUniqueOrderNumber } = require('../../utils/orderNumber');

orderSchema.pre('save', async function(next) {
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

orderSchema.index({ restaurant: 1, branchId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('Order', orderSchema);
