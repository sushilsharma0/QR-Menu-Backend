const mongoose = require('mongoose');

const platformStaffPayrollSchema = new mongoose.Schema(
  {
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformStaff', required: true, index: true },
    periodMonth: { type: Number, required: true, min: 1, max: 12 },
    periodYear: { type: Number, required: true, min: 2000, max: 3000 },
    baseSalary: { type: Number, required: true, min: 0 },
    allowance: { type: Number, default: 0, min: 0 },
    bonus: { type: Number, default: 0, min: 0 },
    deduction: { type: Number, default: 0, min: 0 },
    netSalary: { type: Number, required: true, min: 0 },
    paymentStatus: { type: String, enum: ['pending', 'paid'], default: 'pending', index: true },
    paymentDate: { type: Date },
    notes: { type: String, trim: true },
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Platform', required: true },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Platform' },
  },
  { timestamps: true },
);

platformStaffPayrollSchema.index({ periodYear: -1, periodMonth: -1 });
platformStaffPayrollSchema.index({ staffId: 1, periodYear: 1, periodMonth: 1 }, { unique: true });

module.exports = mongoose.model('PlatformStaffPayroll', platformStaffPayrollSchema);
