const mongoose = require('mongoose');

const payrollSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    periodMonth: { type: Number, required: true, min: 1, max: 12 },
    periodYear: { type: Number, required: true, min: 2000, max: 3000 },
    basicSalary: { type: Number, required: true, min: 0 },
    workingDays: { type: Number, default: 30, min: 0 },
    presentDays: { type: Number, default: 30, min: 0 },
    absentDays: { type: Number, default: 0, min: 0 },
    lateDays: { type: Number, default: 0, min: 0 },
    attendancePay: { type: Number, default: 0, min: 0 },
    absentDeduction: { type: Number, default: 0, min: 0 },
    latePenalty: { type: Number, default: 0, min: 0 },
    allowance: { type: Number, default: 0, min: 0 },
    overtimeHours: { type: Number, default: 0, min: 0 },
    overtimeRate: { type: Number, default: 0, min: 0 },
    overtimePay: { type: Number, default: 0, min: 0 },
    overtime: { type: Number, default: 0, min: 0 },
    festivalBonus: { type: Number, default: 0, min: 0 },
    performanceBonus: { type: Number, default: 0, min: 0 },
    bonus: { type: Number, default: 0, min: 0 },
    incentive: { type: Number, default: 0, min: 0 },
    deductions: { type: Number, default: 0, min: 0 },
    advanceSalary: { type: Number, default: 0, min: 0 },
    /** Nepal TDS (withheld); mirrored into tax for backward compatibility */
    tdsAmount: { type: Number, default: 0, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    /** Employee EPF / provident-style deduction (amount for the period) */
    epfAmount: { type: Number, default: 0, min: 0 },
    /** Employer EPF contribution (same base as employee EPF; company cost, not withheld from net pay) */
    employerEpfAmount: { type: Number, default: 0, min: 0 },
    grossEarnings: { type: Number, default: 0, min: 0 },
    finalSalary: { type: Number, required: true, min: 0 },
    paymentStatus: { type: String, enum: ['pending', 'paid'], default: 'pending', index: true },
    lockedAt: { type: Date, default: null, index: true },
    approval: { type: mongoose.Schema.Types.ObjectId, ref: 'AccountingApproval', default: null },
    paymentDate: { type: Date },
    generatedBy: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: 'generatedByModel' },
    generatedByModel: { type: String, enum: ['Restaurant', 'Employee'], required: true },
    paidBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'paidByModel' },
    paidByModel: { type: String, enum: ['Restaurant', 'Employee'] },
  },
  { timestamps: true },
);

payrollSchema.index({ restaurantId: 1, periodYear: -1, periodMonth: -1 });
payrollSchema.index({ restaurantId: 1, employeeId: 1, periodYear: 1, periodMonth: 1 }, { unique: true });

payrollSchema.pre('save', function(next) {
  if (!this.isNew && this.lockedAt) {
    const allowed = new Set(['lockedAt', 'paymentStatus', 'paymentDate', 'paidBy', 'paidByModel', 'approval', 'updatedAt']);
    const illegal = this.modifiedPaths().filter((path) => !allowed.has(path));
    if (illegal.length) return next(new Error('Locked payroll cannot be modified'));
  }
  return next();
});

module.exports = mongoose.model('Payroll', payrollSchema);
