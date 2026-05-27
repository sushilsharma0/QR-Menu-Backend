const mongoose = require('mongoose');

const payrollTransactionSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    payrollId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payroll', required: true, index: true },
    /** Net pay transferred to the employee */
    amount: { type: Number, required: true, min: 0 },
    employeeEpfAmount: { type: Number, default: 0, min: 0 },
    employerEpfAmount: { type: Number, default: 0, min: 0 },
    method: { type: String, enum: ['cash', 'bank_transfer', 'wallet', 'upi', 'other'], default: 'bank_transfer' },
    referenceId: { type: String, trim: true },
    paidAt: { type: Date, default: Date.now },
    paidBy: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: 'paidByModel' },
    paidByModel: { type: String, enum: ['Restaurant', 'Employee'], required: true },
    note: { type: String, trim: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model('PayrollTransaction', payrollTransactionSchema);
