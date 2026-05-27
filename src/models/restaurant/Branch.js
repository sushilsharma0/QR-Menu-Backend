const mongoose = require('mongoose');
const slugify = require('slugify');
const { DEFAULT_ENABLED_MODULES } = require('../../constants/branchModules');

const branchSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    name: { type: String, required: true, trim: true },
    /** Human-facing id e.g. BR-POKHARA-2041 */
    publicBranchId: { type: String, trim: true, uppercase: true, sparse: true, unique: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    branchCode: { type: String, required: true, trim: true, uppercase: true },
    phone: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
    address: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    country: { type: String, trim: true, default: 'Nepal' },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    openingHours: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({ monday: '', tuesday: '', wednesday: '', thursday: '', friday: '', saturday: '', sunday: '' }),
    },
    branchManager: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    branchManagerName: { type: String, trim: true, default: '' },
    /** Verified Gmail used for OTP + welcome mail; required for new branch portal logins that check owner. */
    ownerEmail: { type: String, trim: true, lowercase: true, default: '' },
    enabledModules: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({ ...DEFAULT_ENABLED_MODULES }),
    },
    subscriptionLimits: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    taxNumber: { type: String, trim: true, default: '' },
    status: { type: String, enum: ['active', 'inactive', 'suspended'], default: 'active', index: true },
    logo: { type: String, default: '' },
    banner: { type: String, default: '' },
    settings: {
      currency: { type: String, default: '' },
      timezone: { type: String, default: '' },
      taxRate: { type: Number, default: null },
      serviceChargePercent: { type: Number, default: null },
      receiptFooter: { type: String, default: '' },
      deliveryZones: { type: [String], default: [] },
      languages: { type: [String], default: [] },
      themeSettings: {
        activeTheme: { type: String, default: '' },
        mode: { type: String, enum: ['light', 'dark', 'system', ''], default: '' },
        fontFamily: { type: String, default: '' },
        customPalette: { type: mongoose.Schema.Types.Mixed, default: null },
        branding: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
      },
    },
    about: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    privacyPolicy: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    createdBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'createdByModel', default: null },
    createdByModel: { type: String, enum: ['Restaurant', 'Employee', 'Admin'], default: 'Restaurant' },
    isDefault: { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

branchSchema.index({ restaurantId: 1, branchCode: 1 }, { unique: true });
branchSchema.index({ restaurantId: 1, status: 1, isDeleted: 1 });

branchSchema.pre('validate', async function branchSlug(next) {
  if (!this.slug && this.name) {
    const base = slugify(`${this.name}`, { lower: true, strict: true });
    let candidate = base;
    let counter = 1;
    while (await this.constructor.exists({ slug: candidate, _id: { $ne: this._id } })) {
      candidate = `${base}-${counter}`;
      counter += 1;
    }
    this.slug = candidate;
  }
  next();
});

module.exports = mongoose.model('Branch', branchSchema);
