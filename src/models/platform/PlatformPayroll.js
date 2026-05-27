const mongoose = require('mongoose');

const platformPayrollSchema = new mongoose.Schema(
  {
    platformUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'Platform', required: true, index: true },
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
    tdsAmount: { type: Number, default: 0, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    epfAmount: { type: Number, default: 0, min: 0 },
    employerEpfAmount: { type: Number, default: 0, min: 0 },
    grossEarnings: { type: Number, default: 0, min: 0 },
    finalSalary: { type: Number, required: true, min: 0 },
    paymentStatus: { type: String, enum: ['pending', 'paid'], default: 'pending', index: true },
    paymentDate: { type: Date },
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Platform', required: true },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Platform' },
  },
  { timestamps: true },
);

platformPayrollSchema.index({ periodYear: -1, periodMonth: -1 });
platformPayrollSchema.index({ platformUserId: 1, periodYear: 1, periodMonth: 1 }, { unique: true });

module.exports = mongoose.model('PlatformPayroll', platformPayrollSchema);
