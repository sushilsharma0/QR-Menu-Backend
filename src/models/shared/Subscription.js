const mongoose = require('mongoose');
const { PLAN_FEATURE_KEYS } = require('../../constants/planFeatures');

const defaultPlanFeatureFlags = () => {
  const flags = {};
  for (const key of PLAN_FEATURE_KEYS) flags[key] = true;
  return flags;
};

const subscriptionSchema = new mongoose.Schema({
  name: { type: String, required: true },
  planType: { type: String, enum: ['basic', 'standard', 'premium'], required: true },
  duration: { type: Number, required: true },
  durationLabel: { type: String },
  /** Amount excluding VAT (base); VAT is applied using platform billing settings when saving. */
  priceExclVat: { type: Number },
  /** Grand total including VAT (charged amount). */
  price: { type: Number, required: true },
  features: { type: [String], default: [] },
  /** Platform feature access toggles for catalog plans. */
  featureFlags: { type: mongoose.Schema.Types.Mixed, default: defaultPlanFeatureFlags },
  limits: {
    maxTables: { type: Number, default: 0 },
    maxEmployees: { type: Number, default: 0 },
    maxCategories: { type: Number, default: 0 },
    maxMenuItems: { type: Number, default: 0 }
  },
  isPopular: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('Subscription', subscriptionSchema);