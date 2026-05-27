const mongoose = require('mongoose');

const securityIpBlockSchema = new mongoose.Schema(
  {
    ipAddress: { type: String, required: true, trim: true, index: true },
    reason: { type: String, default: '' },
    scope: { type: String, enum: ['global', 'restaurant'], default: 'global', index: true },
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', default: null, index: true },
    active: { type: Boolean, default: true, index: true },
    blockedBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'blockedByModel', required: true },
    blockedByModel: { type: String, enum: ['Platform', 'Admin'], required: true },
    expiresAt: { type: Date, default: null, index: true },
    unblockedAt: { type: Date, default: null },
    unblockedBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'unblockedByModel', default: null },
    unblockedByModel: { type: String, enum: ['Platform', 'Admin'], default: null },
  },
  { timestamps: true },
);

securityIpBlockSchema.index({ ipAddress: 1, active: 1, expiresAt: 1 });

module.exports = mongoose.model('SecurityIpBlock', securityIpBlockSchema);
