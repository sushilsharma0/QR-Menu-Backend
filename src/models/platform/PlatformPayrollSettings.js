const mongoose = require('mongoose');

const platformPayrollSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'default', unique: true },
    enabled: { type: Boolean, default: false },
    defaultTdsPercent: { type: Number, default: 0, min: 0, max: 100 },
    defaultEpfPercent: { type: Number, default: 0, min: 0, max: 100 },
    defaultEmployerEpfPercent: { type: Number, default: 0, min: 0, max: 100 },
  },
  { timestamps: true },
);

platformPayrollSettingsSchema.statics.getSettings = async function getSettings() {
  let doc = await this.findOne({ key: 'default' });
  if (!doc) doc = await this.create({ key: 'default' });
  return doc;
};

module.exports = mongoose.model('PlatformPayrollSettings', platformPayrollSettingsSchema);
