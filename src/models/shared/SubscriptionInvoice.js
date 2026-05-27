const mongoose = require('mongoose');

const lineItemSchema = new mongoose.Schema(
  {
    description: { type: String, required: true },
    quantity: { type: Number, default: 1 },
    unitPriceInclVat: { type: Number, required: true },
    lineTotalInclVat: { type: Number, required: true },
  },
  { _id: false }
);

const customerSnapshotSchema = new mongoose.Schema(
  {
    name: String,
    email: String,
    phone: String,
    address: String,
    city: String,
    state: String,
    country: String,
    pincode: String,
  },
  { _id: false }
);

const issuerSnapshotSchema = new mongoose.Schema(
  {
    companyLegalName: String,
    companyAddress: String,
    taxIdLabel: String,
    companyTaxId: String,
    vatRatePercent: Number,
    pricesAreVatInclusive: Boolean,
    currencyCode: String,
    currencySymbol: String,
  },
  { _id: false }
);

const subscriptionInvoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true, unique: true, index: true },
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      required: true,
      index: true,
    },
    subscriptionPlan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subscription',
      required: true,
    },
    packageHistory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PackageHistory',
      required: true,
    },
    lineItems: { type: [lineItemSchema], default: [] },
    subtotalExclVat: { type: Number, required: true },
    vatRateApplied: { type: Number, required: true },
    vatAmount: { type: Number, required: true },
    totalInclVat: { type: Number, required: true },
    transactionType: {
      type: String,
      enum: ['assigned', 'renewed', 'upgraded', 'downgraded', 'cancelled', 'expired'],
      required: true,
    },
    paymentMethod: {
      type: String,
      enum: ['online', 'offline', 'free'],
      default: 'offline',
    },
    billingPeriodStart: { type: Date, required: true },
    billingPeriodEnd: { type: Date, required: true },
    issuedAt: { type: Date, default: Date.now },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Platform' },
    customerSnapshot: customerSnapshotSchema,
    issuerSnapshot: issuerSnapshotSchema,
  },
  { timestamps: true }
);

subscriptionInvoiceSchema.index({ restaurant: 1, createdAt: -1 });
subscriptionInvoiceSchema.index({ issuedAt: -1 });

module.exports = mongoose.model('SubscriptionInvoice', subscriptionInvoiceSchema);
