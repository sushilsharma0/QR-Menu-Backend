const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
  name: { type: String, required: true },
  description: { type: String },
  image: { type: String },
  sortOrder: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

categorySchema.index({ restaurant: 1, branchId: 1, sortOrder: 1 });
categorySchema.index({ restaurant: 1, branchId: 1, name: 1 });

module.exports = mongoose.model('Category', categorySchema);