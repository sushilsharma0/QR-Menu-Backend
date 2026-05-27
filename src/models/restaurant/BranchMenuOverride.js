const mongoose = require('mongoose');

const branchMenuOverrideSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true, index: true },
    customPrice: { type: Number, default: null, min: 0 },
    isAvailable: { type: Boolean, default: true },
    isFeatured: { type: Boolean, default: false },
  },
  { timestamps: true },
);

branchMenuOverrideSchema.index({ branchId: 1, menuItemId: 1 }, { unique: true });

module.exports = mongoose.model('BranchMenuOverride', branchMenuOverrideSchema);
