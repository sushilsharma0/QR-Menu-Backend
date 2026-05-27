const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const employeeSchema = new mongoose.Schema({
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String },
  username: { type: String, required: true },
  password: { type: String, required: true, select: false },
  posPinHash: { type: String, select: false },
  role: { type: String, enum: ['admin', 'manager', 'kitchen', 'cashier', 'waiter', 'accountant'], required: true },
  department: { type: String, trim: true, default: '' },
  designation: { type: String, trim: true, default: '' },
  joiningDate: { type: Date, default: null },
  panNumber: { type: String, trim: true, default: '' },
  bankName: { type: String, trim: true, default: '' },
  bankAccountNumber: { type: String, trim: true, default: '' },
  bankBranch: { type: String, trim: true, default: '' },
  /** Monthly salary template for payroll generation */
  salary: { type: Number, default: 0, min: 0 },
  /** Monthly allowance added to gross pay (payroll uses this unless overridden on the payroll row) */
  allowance: { type: Number, default: 0, min: 0 },
  /** Optional override; if null, restaurant TdsSettings.defaultTdsPercent applies */
  customTdsPercent: { type: Number, default: null, min: 0, max: 100 },
  /** Optional override; if null, restaurant TdsSettings.defaultEpfPercent applies */
  customEpfPercent: { type: Number, default: null, min: 0, max: 100 },
  /** Optional override for employer EPF %; if null, restaurant defaultEmployerEpfPercent applies */
  customEmployerEpfPercent: { type: Number, default: null, min: 0, max: 100 },
  profileImage: { type: String },
  isPasswordChanged: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  lastLogin: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant' }
}, { timestamps: true });

employeeSchema.pre('validate', function(next) {
  if (!this.restaurantId && this.restaurant) this.restaurantId = this.restaurant;
  next();
});

employeeSchema.index({ restaurant: 1, branchId: 1, username: 1 }, { unique: true });
employeeSchema.index({ restaurant: 1, email: 1 });
employeeSchema.index({ restaurantId: 1, branchId: 1, role: 1 });

employeeSchema.pre('save', async function(next) {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 10);
  }
  if (this.isModified('posPinHash') && this.posPinHash && !String(this.posPinHash).startsWith('$2')) {
    this.posPinHash = await bcrypt.hash(String(this.posPinHash), 10);
  }
  next();
});

employeeSchema.methods.comparePassword = async function(password) {
  return bcrypt.compare(password, this.password);
};

employeeSchema.methods.comparePosPin = async function(pin) {
  if (!this.posPinHash || !pin) return false;
  return bcrypt.compare(String(pin), this.posPinHash);
};

module.exports = mongoose.model('Employee', employeeSchema);
