const mongoose = require('mongoose');
const branchAuthSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    /** Globally unique branch login address (local@branch.com). Sparse for legacy rows. */
    branchEmail: { type: String, trim: true, lowercase: true, sparse: true },
    username: { type: String, required: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true, select: false },
    role: {
      type: String,
      enum: ['branch_admin', 'branch_manager', 'branch_cashier', 'branch_waiter', 'branch_kitchen'],
      default: 'branch_admin',
      index: true,
    },
    permissions: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    lastLogin: { type: Date, default: null },
    activeStatus: { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'createdByModel', default: null },
    createdByModel: { type: String, enum: ['Restaurant', 'Employee', 'Admin', 'BranchAuth'], default: 'Restaurant' },
  },
  { timestamps: true },
);

branchAuthSchema.index({ restaurantId: 1, username: 1 }, { unique: true })
branchAuthSchema.index({ branchEmail: 1 }, { unique: true, sparse: true })
branchAuthSchema.index({ branchId: 1, activeStatus: 1 })

branchAuthSchema.methods.safeObject = function safeObject() {
  return {
    _id: this._id,
    restaurantId: this.restaurantId,
    branchId: this.branchId,
    username: this.username,
    branchEmail: this.branchEmail,
    role: this.role,
    permissions: this.permissions,
    lastLogin: this.lastLogin,
    activeStatus: this.activeStatus,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  }
}

module.exports = mongoose.model('BranchAuth', branchAuthSchema)
