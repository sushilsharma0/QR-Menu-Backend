const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const adminSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true, select: false },
  role: { type: String, enum: ['super_admin', 'admin', 'support'], default: 'admin' },
  permissions: {
    manageRestaurants: { type: Boolean, default: false },
    manageSubscriptions: { type: Boolean, default: false },
    manageAdmins: { type: Boolean, default: false },
    manageCMS: { type: Boolean, default: false },
    verifyKYC: { type: Boolean, default: false },
    viewAnalytics: { type: Boolean, default: false },
    manageSystem: { type: Boolean, default: false }
  },
  profileImage: { type: String },
  lastLogin: { type: Date },
  isActive: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, { timestamps: true });

adminSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

adminSchema.methods.comparePassword = async function(password) {
  return bcrypt.compare(password, this.password);
};

module.exports = mongoose.model('Admin', adminSchema);