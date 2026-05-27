const mongoose = require('mongoose');

const restaurantSessionSchema = new mongoose.Schema({
  restaurantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Restaurant',
    required: true,
    index: true,
  },
  deviceId: { type: String, required: true, index: true },
  deviceFingerprint: { type: String, required: true },
  browser: { type: String, default: 'Unknown browser' },
  operatingSystem: { type: String, default: 'Unknown OS' },
  deviceType: { type: String, default: 'Desktop' },
  timezone: { type: String, default: '' },
  screenResolution: { type: String, default: '' },
  ipAddress: { type: String, default: '' },
  loginLocation: {
    city: { type: String, default: '' },
    region: { type: String, default: '' },
    country: { type: String, default: '' },
    latitude: { type: Number },
    longitude: { type: Number },
    source: { type: String, default: 'ip' },
  },
  userAgent: { type: String, default: '' },
  lastActiveAt: { type: Date, default: Date.now, index: true },
  expiresAt: { type: Date, required: true, index: true },
  revokedAt: { type: Date, default: null, index: true },
  revokedReason: { type: String, default: '' },
  refreshTokenHash: { type: String, select: false },
  refreshTokenBlacklistedAt: { type: Date, default: null },
  tokenVersion: { type: Number, default: 1 },
  loginAlerts: {
    unknownDevice: { type: Boolean, default: false },
    impossibleTravel: { type: Boolean, default: false },
    suspiciousConcurrentSessions: { type: Boolean, default: false },
  },
}, { timestamps: true });

restaurantSessionSchema.index({ restaurantId: 1, deviceId: 1 });
restaurantSessionSchema.index({ restaurantId: 1, revokedAt: 1, expiresAt: 1 });

module.exports = mongoose.model('RestaurantSession', restaurantSessionSchema);
