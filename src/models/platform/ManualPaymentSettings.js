const mongoose = require('mongoose');

const manualPaymentSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'global' },
    accountName: { type: String, default: '' },
    accountNumber: { type: String, default: '' },
    branch: { type: String, default: '' },
    qrCodeImage: { type: String, default: '' },
    notes: { type: String, default: '' },
  },
  { timestamps: true },
);

manualPaymentSettingsSchema.statics.getSingleton = function getSingleton() {
  return this.findByIdAndUpdate(
    'global',
    { $setOnInsert: { _id: 'global' } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
};

module.exports = mongoose.model('ManualPaymentSettings', manualPaymentSettingsSchema);
