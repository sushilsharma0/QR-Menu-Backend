const mongoose = require('mongoose');

const journalLineSchema = new mongoose.Schema(
  {
    accountCode: { type: String, required: true, trim: true },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const journalEntrySchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    entryDate: { type: Date, required: true, index: true },
    memo: { type: String, trim: true, default: '' },
    sourceType: {
      type: String,
      enum: ['manual', 'expense', 'inventory_purchase', 'payroll', 'sales', 'adjustment'],
      default: 'manual',
    },
    sourceId: { type: mongoose.Schema.Types.ObjectId, default: null },
    lines: { type: [journalLineSchema], required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: 'createdByModel' },
    createdByModel: { type: String, enum: ['Restaurant', 'Employee'], required: true },
  },
  { timestamps: true },
);

journalEntrySchema.index({ restaurantId: 1, entryDate: -1 });

module.exports = mongoose.model('JournalEntry', journalEntrySchema);
