const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  customerOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerOrder' },
  amount: { type: Number, required: true },
  paymentMethod: {
    type: String,
    /** New transactions: cash | online | credit. Legacy gateway labels kept for existing DB rows. */
    enum: ['cash', 'online', 'credit', 'card', 'upi', 'wallet', 'esewa', 'khalti', 'fonepay'],
    required: true,
  },
  splitGroupId: { type: mongoose.Schema.Types.ObjectId },
  posShift: { type: mongoose.Schema.Types.ObjectId, ref: 'POSShift' },
  status: { type: String, enum: ['pending', 'success', 'failed', 'refunded'], default: 'pending' },
  transactionId: { type: String },
  processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
  receiptNo: { type: String, unique: true },
  notes: String,
  
  // ── Status tracking
  statusHistory: [{
    status: { type: String, enum: ['pending', 'success', 'failed', 'refunded'] },
    timestamp: { type: Date, default: Date.now },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
    note: String
  }],
  
  // ── Refund tracking
  refunded: { type: Boolean, default: false },
  refundAmount: { type: Number, default: 0 },
  refundReason: String,
  refundedAt: Date,
  refundedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
  immutableLedger: { type: Boolean, default: true },
  
  // ── Order status sync
  linkedOrderStatus: String,
  linkedOrderPaymentStatus: String
}, { timestamps: true });

transactionSchema.pre('validate', function(next) {
  if (!this.order && !this.customerOrder) {
    this.invalidate('order', 'Either order or customerOrder is required');
  }
  next();
});

transactionSchema.pre('save', async function(next) {
  if (!this.isNew && this.immutableLedger) {
    const allowed = new Set([
      'status',
      'statusHistory',
      'refunded',
      'refundAmount',
      'refundReason',
      'refundedAt',
      'refundedBy',
      'updatedAt',
    ]);
    const illegal = this.modifiedPaths().filter((path) => !allowed.has(path));
    if (illegal.length) return next(new Error('Financial transaction ledger fields are immutable'));
  }

  if (this.isNew && !this.receiptNo) {
    this.receiptNo = `RCP-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  }
  
  // Initialize statusHistory on creation
  if (this.isNew && (!this.statusHistory || this.statusHistory.length === 0)) {
    this.statusHistory = [{
      status: this.status,
      timestamp: new Date(),
      updatedBy: this.processedBy,
      note: 'Transaction created'
    }];
  }
  
  next();
});

module.exports = mongoose.model('Transaction', transactionSchema);
