const mongoose = require('mongoose');

const branchSessionSchema = new mongoose.Schema(
  {
    branchAuthId: { type: mongoose.Schema.Types.ObjectId, ref: 'BranchAuth', required: true, index: true },
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    tokenFamily: { type: String, trim: true, index: true },
    userAgent: { type: String, default: '' },
    ipAddress: { type: String, default: '' },
    deviceLabel: { type: String, default: '' },
    lastActivityAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true, index: true },
    revokedAt: { type: Date, default: null, index: true },
    revokedReason: { type: String, default: '' },
  },
  { timestamps: true },
);

branchSessionSchema.index({ branchAuthId: 1, createdAt: -1 })

module.exports = mongoose.model('BranchSession', branchSessionSchema)
