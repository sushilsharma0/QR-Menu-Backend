const mongoose = require('mongoose');

const platformStaffSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    designation: { type: String, trim: true, default: 'Staff' },
    department: { type: String, trim: true, default: 'Operations' },
    baseSalary: { type: Number, required: true, min: 0, default: 0 },
    joinDate: { type: Date, default: Date.now },
    bankAccount: { type: String, trim: true },
    panNumber: { type: String, trim: true },
    isActive: { type: Boolean, default: true, index: true },
    notes: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Platform' },
  },
  { timestamps: true },
);

platformStaffSchema.index({ email: 1 }, { sparse: true });

module.exports = mongoose.model('PlatformStaff', platformStaffSchema);
