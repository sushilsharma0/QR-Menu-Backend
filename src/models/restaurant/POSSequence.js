const mongoose = require('mongoose');

const posSequenceSchema = new mongoose.Schema(
  {
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    key: { type: String, required: true },
    value: { type: Number, default: 0 },
  },
  { timestamps: true }
);

posSequenceSchema.index({ restaurant: 1, branchId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('POSSequence', posSequenceSchema);
