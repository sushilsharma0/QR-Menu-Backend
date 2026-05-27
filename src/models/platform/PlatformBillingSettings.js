const mongoose = require('mongoose');
const { DEFAULT_CURRENCY_CODE, DEFAULT_CURRENCY_SYMBOL } = require('../../config/currencyDefaults');

const platformBillingSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    companyLegalName: { type: String, default: '' },
    companyAddress: { type: String, default: '' },
    taxIdLabel: { type: String, default: 'Tax ID / VAT' },
    companyTaxId: { type: String, default: '' },
    invoicePrefix: { type: String, default: 'INV' },
    invoiceSequence: { type: Number, default: 0 },
    vatRatePercent: { type: Number, default: 13 },
    pricesAreVatInclusive: { type: Boolean, default: true },
    currencyCode: { type: String, default: DEFAULT_CURRENCY_CODE },
    currencySymbol: { type: String, default: DEFAULT_CURRENCY_SYMBOL },
  },
  { timestamps: true }
);

platformBillingSettingsSchema.statics.getSingleton = async function getSingleton() {
  const id = 'global';
  let doc = await this.findById(id);
  if (!doc) {
    doc = await this.create({ _id: id });
  } else if (doc.currencyCode === 'USD' && doc.currencySymbol === '$') {
    doc.currencyCode = DEFAULT_CURRENCY_CODE;
    doc.currencySymbol = DEFAULT_CURRENCY_SYMBOL;
    await doc.save();
  }
  return doc;
};

module.exports = mongoose.model('PlatformBillingSettings', platformBillingSettingsSchema);
