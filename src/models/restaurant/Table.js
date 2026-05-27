const mongoose = require('mongoose');

const tableSchema = new mongoose.Schema({
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
  tableNumber: { type: String, required: true },
  capacity: { type: Number, default: 4 },
  tableType: {
    type: String,
    enum: ['regular', 'family', 'couple', 'private', 'outdoor', 'bar', 'other'],
    default: 'regular',
  },
  floor: { type: String, default: 'ground', index: true },
  area: { type: String, default: '' },
  floorPosition: {
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 },
  },
  qrCode: { type: String },
  qrToken: { type: String, unique: true, sparse: true },
  qrTokenHash: { type: String, index: true },
  qrTokenVersion: { type: Number, default: 1 },
  qrIssuedAt: { type: Date },
  qrExpiresAt: { type: Date, index: true },
  qrLastRegeneratedAt: { type: Date },
  isActive: { type: Boolean, default: true },
  isDeleted: { type: Boolean, default: false },
  /** POS / floor: dine-in table state (QR tables may ignore this) */
  posStatus: {
    type: String,
    enum: ['available', 'occupied', 'reserved', 'billing', 'cleaning'],
    default: 'available',
  },
  guestCount: { type: Number, default: 0 },
  assignedWaiter: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
  currentCustomerOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerOrder' },
  /** Virtual POS tables (e.g. POS-TAKEAWAY) allow many open orders at once */
  allowsConcurrentOrders: { type: Boolean, default: false },
}, { timestamps: true });

tableSchema.pre('validate', function(next) {
  if (!this.restaurantId && this.restaurant) this.restaurantId = this.restaurant;
  next();
});

tableSchema.index(
  { restaurant: 1, branchId: 1, tableNumber: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
    name: 'restaurant_tableNumber_unique_not_deleted'
  }
);
tableSchema.index({ qrToken: 1 });
tableSchema.index({ restaurantId: 1, branchId: 1, posStatus: 1 });

tableSchema.on('index', async function(error) {
  if (error) return;

  try {
    await this.collection.dropIndex('restaurant_1_tableNumber_1');
  } catch (dropError) {
    if (
      dropError &&
      dropError.codeName !== 'IndexNotFound' &&
      !/index not found/i.test(dropError.message)
    ) {
      console.error('Error dropping legacy table index:', dropError);
    }
  }
});

module.exports = mongoose.model('Table', tableSchema);
