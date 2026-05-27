const mongoose = require('mongoose');

const guestSchema = new mongoose.Schema(
  {
    guestId: { type: String, required: true, unique: true, index: true },
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    table: { type: mongoose.Schema.Types.ObjectId, ref: 'Table', required: true, index: true },
    qrTokenHash: { type: String, default: '', index: true },
    sessionTokenHash: { type: String, default: '', index: true },
    sessionIssuedAt: { type: Date },
    sessionExpiresAt: { type: Date, index: true },
    sessionLastActiveAt: { type: Date },
    sessionRevokedAt: { type: Date },
    deviceInfo: {
      userAgent: { type: String, default: '' },
      platform: { type: String, default: '' },
      language: { type: String, default: '' },
      timezone: { type: String, default: '' },
    },
    lastVisitedAt: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

guestSchema.index({ restaurant: 1, branchId: 1, table: 1, guestId: 1 }, { unique: true });

module.exports = mongoose.model('Guest', guestSchema);
