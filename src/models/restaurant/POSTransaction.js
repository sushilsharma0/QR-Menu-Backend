const mongoose = require('mongoose');

/**
 * Optional aggregate for a multi-tender checkout session.
 * Individual legs are stored as `Transaction` documents sharing `splitGroupId`.
 */
const posTransactionSchema = new mongoose.Schema(
  {
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    customerOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CustomerOrder',
      required: true,
    },
    posShift: { type: mongoose.Schema.Types.ObjectId, ref: 'POSShift' },
    splitGroupId: { type: mongoose.Schema.Types.ObjectId, required: true },
    status: { type: String, enum: ['open', 'settled'], default: 'open' },
    totalExpected: { type: Number, default: 0 },
  },
  { timestamps: true }
);

posTransactionSchema.index({ restaurant: 1, createdAt: -1 });
posTransactionSchema.index({ splitGroupId: 1 }, { unique: true });

module.exports = mongoose.model('POSTransaction', posTransactionSchema);
