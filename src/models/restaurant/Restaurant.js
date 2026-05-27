const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const slugify = require('slugify');

const restaurantSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  phone: { type: String, required: true },
  phoneNormalized: { type: String, trim: true, default: '', select: false },
  password: { type: String, required: true, select: false },
  googleId: { type: String, unique: true, sparse: true },
  authProvider: { type: String, enum: ['password', 'google'], default: 'password' },
  emailVerified: { type: Boolean, default: true },
  emailVerificationOTP: { type: String, select: false },
  emailVerificationOTPExpiry: { type: Date, select: false },
  slug: { type: String, unique: true },
  /** Unguessable 12-hex segment for branch portal URLs (per restaurant). */
  branchPortalKey: { type: String, default: '' },
  /** Human-facing id for staff/branch login (e.g. REST-2041). */
  publicRestaurantId: { type: String, trim: true, uppercase: true, sparse: true, unique: true },
  /** Shareable code used to invite another restaurant. */
  referralCode: { type: String, trim: true, uppercase: true, sparse: true, unique: true },
  referredByRestaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant' },
  logo: { type: String },
  favicon: { type: String },
  backgroundPhoto: { type: String },
  brandBackgroundImage: { type: String },
  address: { type: String },
  city: { type: String },
  state: { type: String },
  district: { type: String, default: '' },
  localLevel: { type: String, default: '' },
  pincode: { type: String },
  country: { type: String, default: 'Nepal' },
  description: { type: String },
  openingTime: { type: String, default: '09:00' },
  closingTime: { type: String, default: '22:00' },

  /**
   * Public-facing "About" content rendered on the customer portal.
   * All fields are optional — the customer UI falls back to sensible defaults
   * when a vendor hasn't filled in this section yet.
   */
  about: {
    tagline: { type: String, default: '' },
    aboutText: { type: String, default: '' },
    cuisine: { type: String, default: '' },
    priceRange: { type: String, default: '' },
    establishedYear: { type: Number },
    rating: { type: Number, min: 0, max: 5 },
    reviewCount: { type: Number, min: 0 },
    features: {
      type: [
        {
          icon: { type: String, default: 'Utensils' },
          label: { type: String, required: true },
        },
      ],
      default: [],
    },
    gallery: { type: [String], default: [] },
    hours: {
      monday: { type: String, default: '' },
      tuesday: { type: String, default: '' },
      wednesday: { type: String, default: '' },
      thursday: { type: String, default: '' },
      friday: { type: String, default: '' },
      saturday: { type: String, default: '' },
      sunday: { type: String, default: '' },
    },
    socials: {
      website: { type: String, default: '' },
      facebook: { type: String, default: '' },
      instagram: { type: String, default: '' },
      twitter: { type: String, default: '' },
    },
  },

  /**
   * Per-restaurant privacy policy shown to customers from the QR portal.
   * `sections` lets the vendor express the policy as a list of titled
   * paragraphs (Introduction, Data Use, Contact, …) without losing structure.
   */
  privacyPolicy: {
    enabled: { type: Boolean, default: false },
    lastUpdated: { type: Date },
    sections: {
      type: [
        {
          title: { type: String, required: true },
          content: { type: String, default: '' },
        },
      ],
      default: [],
    },
    contactEmail: { type: String, default: '' },
    contactPhone: { type: String, default: '' },
    contactAddress: { type: String, default: '' },
  },

  isKYCVerified: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  isDeleted: { type: Boolean, default: false },
  
  resetOTP: { type: String, select: false },
  resetOTPExpiry: { type: Date, select: false },
  resetOTPAttempts: { type: Number, default: 0, select: false },
  passwordChangedAt: { type: Date },
  successfulLoginCount: { type: Number, default: 0 },
  lastLoginAt: { type: Date },
  
  /** catalog = tied to Subscription doc; custom = super-admin-defined limits & feature flags */
  planAssignmentSource: {
    type: String,
    enum: ['catalog', 'custom'],
    default: 'catalog',
  },
  customPlanLabel: { type: String },
  currentPlan: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription' },
  planStartDate: Date,
  planEndDate: Date,
  lastRenewedAt: Date,
  requestedPlan: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription' },
  planRequestDate: Date,
  /** none → awaiting_proof (after request) → pending_review (after payment upload) */
  planRequestStatus: {
    type: String,
    enum: ['none', 'awaiting_proof', 'pending_review', 'rejected'],
    default: 'none'
  },
  planPaymentProofPath: { type: String },
  planPaymentReferenceId: { type: String },
  planRequestRejectionReason: { type: String },
  /** End of free trial (registration + platform-configured days). Paid plan uses planEndDate. */
  trialEndsAt: { type: Date },
  /** Shown once on first owner login after registration. */
  hasSeenTrialWelcome: { type: Boolean, default: false },
  /** Extra features granted by platform admin before a paid plan (ignored while paid plan is active). */
  preSubscriptionFeatureGrants: {
    menu: { type: Boolean },
    orders: { type: Boolean },
    customerOrders: { type: Boolean },
    tables: { type: Boolean },
    employees: { type: Boolean },
    promotions: { type: Boolean },
    branches: { type: Boolean },
    cashier: { type: Boolean },
    analytics: { type: Boolean },
    inventory: { type: Boolean },
    creditCustomers: { type: Boolean },
    billing: { type: Boolean },
    activityLogs: { type: Boolean },
    supportTickets: { type: Boolean },
    accountSettings: { type: Boolean },
    backup: { type: Boolean },
  },
  
  planLimits: {
    maxTables: { type: Number, default: 0 },
    maxEmployees: { type: Number, default: 0 },
    maxCategories: { type: Number, default: 0 },
    maxMenuItems: { type: Number, default: 0 }
  },
  planFeatures: { type: [String], default: [] },
  /** false = disabled; stored as Mixed so new plan modules are not stripped by Mongoose */
  planFeatureFlags: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  
  autoRenew: { type: Boolean, default: true },
  subscription: {
    activePlan: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription' },
    status: {
      type: String,
      enum: ['trial', 'active', 'expired', 'pending_verification', 'inactive'],
      default: 'trial',
    },
    activatedAt: Date,
    expiresAt: Date,
    autoRenew: { type: Boolean, default: true },
  },
  settings: {
    currency: { type: String, default: 'Rs.' },
    timezone: { type: String, default: 'Asia/Kathmandu' },
    taxRate: { type: Number, default: 13 },
    /** Default % service charge for POS (0 = off unless overridden per order) */
    serviceChargePercent: { type: Number, default: 0 },
    orderPrefix: { type: String, default: 'ORD' },
    receiptFooter: { type: String },
    feedbackEnabled: { type: Boolean, default: true },
    showFeedbackOnLanding: { type: Boolean, default: true },
    loyalty: {
      enabled: { type: Boolean, default: true },
      /** Earn 1 point per this many currency units (e.g. 50 = Rs. 50) */
      pointsPerCurrencyUnit: { type: Number, default: 50 },
      minPointsPerOrder: { type: Number, default: 0 },
      minOrderAmount: { type: Number, default: 0 },
      smsOnOrderReady: { type: Boolean, default: false },
    },
    themeSettings: {
      activeTheme: { type: String, default: 'royal_brown' },
      mode: { type: String, enum: ['light', 'dark', 'system'], default: 'light' },
      darkMode: { type: Boolean, default: false },
      fontFamily: { type: String, default: 'Inter, system-ui, sans-serif' },
      allowCustomThemes: { type: Boolean, default: true },
      branchOverridesEnabled: { type: Boolean, default: false },
      branchThemes: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
      customPalette: {
        primary: { type: String },
        secondary: { type: String },
        accent: { type: String },
        attention: { type: String },
        surface: { type: String },
        background: { type: String },
        text: { type: String },
      },
      branding: {
        logo: { type: String, default: '' },
        favicon: { type: String, default: '' },
        backgroundImage: { type: String, default: '' },
      },
      premiumThemesEnabled: { type: Boolean, default: false },
      customThemesDisabledByAdmin: { type: Boolean, default: false },
    },
    /** Running cash / bank balances adjusted by paid inventory purchases, manual expenses, payroll, and raw-use COGS. */
    cashBalance: { type: Number, default: 0 },
    bankBalance: { type: Number, default: 0 },
  }
}, { timestamps: true });

const normalizePhoneForAuth = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 7 ? digits : '';
};

restaurantSchema.index(
  { phoneNormalized: 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: {
      phoneNormalized: { $type: 'string', $gt: '' },
    },
  },
);

restaurantSchema.pre('validate', function normalizeRestaurantPhone(next) {
  this.phoneNormalized = normalizePhoneForAuth(this.phone);
  next();
});

// Pre-save middleware for password hashing
restaurantSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  this.passwordChangedAt = new Date();
  this.successfulLoginCount = 0;
  next();
});

// Pre-save middleware for slug generation
restaurantSchema.pre('save', async function(next) {
  if (this.isModified('name') && !this.slug) {
    let baseSlug = slugify(this.name, { lower: true, strict: true });
    let uniqueSlug = baseSlug;
    let counter = 1;
    
    while (await this.constructor.findOne({ slug: uniqueSlug, _id: { $ne: this._id } })) {
      uniqueSlug = `${baseSlug}-${counter}`;
      counter++;
    }
    this.slug = uniqueSlug;
  }
  next();
});

restaurantSchema.methods.comparePassword = async function(password) {
  return bcrypt.compare(password, this.password);
};

restaurantSchema.methods.isPlanValid = function() {
  return this.planEndDate && this.planEndDate > new Date();
};

restaurantSchema.methods.hasPaidPlanActive = function() {
  if (!this.planEndDate || new Date(this.planEndDate) <= new Date()) {
    return false;
  }
  if (this.planAssignmentSource === 'custom') {
    return true;
  }
  return Boolean(this.currentPlan);
};

/** Active paid access via a catalog Subscription plan (not trial, not custom). */
restaurantSchema.methods.hasActiveCatalogSubscription = function hasActiveCatalogSubscription() {
  if (!this.planEndDate || new Date(this.planEndDate) <= new Date()) {
    return false;
  }
  if (this.planAssignmentSource !== 'catalog') {
    return false;
  }
  return Boolean(this.currentPlan);
};

/** Super-admin custom plans cannot replace an in-force catalog subscription. */
restaurantSchema.methods.canAssignCustomPlan = function canAssignCustomPlan() {
  return !this.hasActiveCatalogSubscription();
};

restaurantSchema.methods.isTrialActive = function() {
  if (!this.trialEndsAt) return false;
  return new Date(this.trialEndsAt) > new Date();
};

/** Trial or an active paid subscription */
restaurantSchema.methods.canUseRestaurantFeatures = function() {
  return this.isTrialActive() || this.hasPaidPlanActive();
};

module.exports = mongoose.model('Restaurant', restaurantSchema);
