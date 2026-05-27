const mongoose = require('mongoose');

const chartOfAccountSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    code: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ['asset', 'liability', 'equity', 'revenue', 'expense'],
      required: true,
      index: true,
    },
    isSystem: { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

chartOfAccountSchema.index({ restaurantId: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('ChartOfAccount', chartOfAccountSchema);
