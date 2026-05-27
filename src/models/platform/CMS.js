const mongoose = require('mongoose');

const cmsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  title: { type: String },
  content: { type: String },
  type: { type: String, enum: ['page', 'banner', 'faq', 'feature', 'blog'], default: 'page' },
  metaTitle: String,
  metaDescription: String,
  metaKeywords: [String],
  image: String,
  isActive: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Platform' }
}, { timestamps: true });

module.exports = mongoose.model('CMS', cmsSchema);