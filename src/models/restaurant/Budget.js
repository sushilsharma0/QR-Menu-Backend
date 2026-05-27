const mongoose = require('mongoose');

const budgetLineSchema = new mongoose.Schema(
  {
    category: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const budgetSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    periodType: { type: String, enum: ['monthly', 'yearly'], required: true },
    year: { type: Number, required: true, min: 2000, max: 3100 },
    /** 1–12 for monthly; 0 means whole year when periodType is yearly */
    month: { type: Number, required: true, min: 0, max: 12 },
    lines: { type: [budgetLineSchema], default: [] },
    notes: { type: String, trim: true, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: 'createdByModel' },
    createdByModel: { type: String, enum: ['Restaurant', 'Employee'], required: true },
  },
  { timestamps: true },
);

budgetSchema.index({ restaurantId: 1, periodType: 1, year: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('Budget', budgetSchema);
