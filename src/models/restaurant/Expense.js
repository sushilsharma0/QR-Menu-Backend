const mongoose = require('mongoose');

const EXPENSE_CATEGORIES = [
  'rent',
  'electricity',
  'gas',
  'staff_salary',
  'ingredients',
  'marketing',
  'maintenance',
  'tax',
  'internet',
  'water',
  'fuel',
  'transportation',
  'equipment',
  'miscellaneous',
];

const expenseSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    title: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    category: { type: String, enum: EXPENSE_CATEGORIES, required: true },
    paymentMethod: {
      type: String,
      enum: ['cash', 'card', 'bank_transfer', 'wallet', 'upi', 'other'],
      default: 'cash',
    },
    description: { type: String, trim: true },
    notes: { type: String, trim: true, default: '' },
    receiptImage: { type: String, default: '' },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'partial', 'cancelled'],
      default: 'paid',
      index: true,
    },
    approvalStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'approved', index: true },
    approval: { type: mongoose.Schema.Types.ObjectId, ref: 'AccountingApproval', default: null },
    lockedAt: { type: Date, default: null },
    isRecurring: { type: Boolean, default: false },
    recurringFrequency: { type: String, enum: ['', 'weekly', 'monthly', 'yearly'], default: '' },
    nextDueDate: { type: Date, default: null },
    expenseDate: { type: Date, required: true, index: true },
    addedBy: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: 'addedByModel' },
    addedByModel: { type: String, enum: ['Restaurant', 'Employee'], required: true },
    /** When set, this expense was created from a payroll payment (one expense per payroll pay). */
    sourcePayrollId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payroll', default: null, index: true },
    /** When set, this expense was created from a manual raw-material usage movement (inventory). */
    sourceInventoryLogId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryLog', default: null, index: true },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

expenseSchema.index({ restaurantId: 1, branchId: 1, expenseDate: -1, category: 1 });
expenseSchema.index({ sourcePayrollId: 1 }, { unique: true, sparse: true });
expenseSchema.index({ sourceInventoryLogId: 1 }, { unique: true, sparse: true });

expenseSchema.pre('save', function(next) {
  if (!this.isNew && this.lockedAt) return next(new Error('Locked expense cannot be modified'));
  return next();
});

module.exports = mongoose.model('Expense', expenseSchema);
module.exports.EXPENSE_CATEGORIES = EXPENSE_CATEGORIES;
