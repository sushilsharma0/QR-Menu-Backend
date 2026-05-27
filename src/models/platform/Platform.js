const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const platformSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true, select: false },
  role: { type: String, enum: ['super_admin', 'admin', 'support'], default: 'admin' },
  permissions: {
    viewAnalytics: { type: Boolean, default: false },
    manageRestaurants: { type: Boolean, default: false },
    manageSubscriptions: { type: Boolean, default: false },
    manageSubscriptionPlans: { type: Boolean, default: false },
    manageTrialAccess: { type: Boolean, default: false },
    manageSubscriptionPayments: { type: Boolean, default: false },
    manageSubscriptionInvoices: { type: Boolean, default: false },
    manageSubscriptionActivity: { type: Boolean, default: false },
    managePlatformBillingSettings: { type: Boolean, default: false },
    verifyKYC: { type: Boolean, default: false },
    manageCMS: { type: Boolean, default: false },
    manageReviews: { type: Boolean, default: false },
    manageTickets: { type: Boolean, default: false },
    manageSecurity: { type: Boolean, default: false },
    managePayroll: { type: Boolean, default: false },
    manageFinance: { type: Boolean, default: false },
    manageSystem: { type: Boolean, default: false },
    manageLogs: { type: Boolean, default: false },
  },
  /** Payroll employee id e.g. EMP001 — assigned to admin/support accounts */
  employeeCode: { type: String, trim: true, unique: true, sparse: true },
  phone: { type: String, trim: true },
  department: { type: String, trim: true, default: '' },
  designation: { type: String, trim: true, default: '' },
  joiningDate: { type: Date, default: null },
  salary: { type: Number, default: 0, min: 0 },
  allowance: { type: Number, default: 0, min: 0 },
  panNumber: { type: String, trim: true, default: '' },
  bankName: { type: String, trim: true, default: '' },
  bankAccountNumber: { type: String, trim: true, default: '' },
  bankBranch: { type: String, trim: true, default: '' },
  customTdsPercent: { type: Number, default: null, min: 0, max: 100 },
  customEpfPercent: { type: Number, default: null, min: 0, max: 100 },
  customEmployerEpfPercent: { type: Number, default: null, min: 0, max: 100 },
  payrollEligible: { type: Boolean, default: true },
  profileImage: { type: String },
  bio: { type: String, trim: true, maxlength: 500, default: '' },
  lastLogin: { type: Date },
  isActive: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Platform' }
}, { timestamps: true });

platformSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

platformSchema.methods.comparePassword = async function(password) {
  return bcrypt.compare(password, this.password);
};

module.exports = mongoose.model('Platform', platformSchema);