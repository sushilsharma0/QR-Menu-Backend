const mongoose = require('mongoose');

const platformSecuritySettingsSchema = new mongoose.Schema(
  {
    singletonKey: { type: String, unique: true, default: 'platform-security-settings' },
    restaurantLoginMaxFailures: { type: Number, default: 5, min: 3, max: 20 },
    restaurantLoginFailureWindowMinutes: { type: Number, default: 15, min: 5, max: 120 },
    restaurantLoginLockMinutes: { type: Number, default: 30, min: 5, max: 24 * 60 },
    employeeLoginMaxFailures: { type: Number, default: 5, min: 3, max: 20 },
    employeeLoginFailureWindowMinutes: { type: Number, default: 15, min: 5, max: 120 },
    employeeLoginLockMinutes: { type: Number, default: 30, min: 5, max: 24 * 60 },
  },
  { timestamps: true },
);

platformSecuritySettingsSchema.statics.getSingleton = async function getSingleton() {
  let settings = await this.findOne({ singletonKey: 'platform-security-settings' });
  if (!settings) {
    settings = await this.create({ singletonKey: 'platform-security-settings' });
  }
  return settings;
};

module.exports = mongoose.model('PlatformSecuritySettings', platformSecuritySettingsSchema);
