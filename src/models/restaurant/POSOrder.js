const mongoose = require('mongoose');

/** Links a CustomerOrder to POS session metadata (shift, invoice, source). */
const posOrderSchema = new mongoose.Schema(
  {
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    customerOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CustomerOrder',
      required: true,
    },
    shift: { type: mongoose.Schema.Types.ObjectId, ref: 'POSShift' },
    invoiceNumber: { type: String, index: true },
    /** waiter / cashier attribution for performance stats */
    primaryStaff: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
    source: { type: String, enum: ['pos_terminal', 'qr_menu'], default: 'pos_terminal' },
  },
  { timestamps: true }
);

posOrderSchema.index({ restaurant: 1, branchId: 1, createdAt: -1 });
posOrderSchema.index({ customerOrder: 1 }, { unique: true });

module.exports = mongoose.model('POSOrder', posOrderSchema);
