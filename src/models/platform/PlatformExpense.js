const mongoose = require('mongoose');

const PLATFORM_EXPENSE_CATEGORIES = [
  'staff_salary',
  'equipment',
  'office_supplies',
  'rent',
  'utilities',
  'internet',
  'marketing',
  'software',
  'travel',
  'professional_services',
  'maintenance',
  'miscellaneous',
];

const platformExpenseSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    category: { type: String, enum: PLATFORM_EXPENSE_CATEGORIES, required: true, index: true },
    paymentMethod: {
      type: String,
      enum: ['cash', 'card', 'bank_transfer', 'wallet', 'upi', 'other'],
      default: 'bank_transfer',
    },
    description: { type: String, trim: true, default: '' },
    notes: { type: String, trim: true, default: '' },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'partial', 'cancelled'],
      default: 'paid',
      index: true,
    },
    expenseDate: { type: Date, required: true, index: true },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Platform', required: true },
    sourcePayrollId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformPayroll', default: null, index: true },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

platformExpenseSchema.index({ expenseDate: -1, category: 1 });
platformExpenseSchema.index({ sourcePayrollId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('PlatformExpense', platformExpenseSchema);
module.exports.PLATFORM_EXPENSE_CATEGORIES = PLATFORM_EXPENSE_CATEGORIES;
