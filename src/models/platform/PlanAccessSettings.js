const mongoose = require('mongoose');
const { PLAN_FEATURE_KEYS } = require('../../constants/planFeatures');
const { mergePlanLimits } = require('../../utils/planFeatureHelpers');

const featureFlagShape = {};
for (const key of PLAN_FEATURE_KEYS) {
  featureFlagShape[key] = { type: Boolean };
}

const planAccessSettingsSchema = new mongoose.Schema(
  {
    /** Days granted on new restaurant registration (replaces env-only default). */
    trialDays: { type: Number, default: 14, min: 1, max: 365 },
    trialFeatureFlags: featureFlagShape,
    trialLimits: {
      maxTables: { type: Number, default: 0, min: 0 },
      maxEmployees: { type: Number, default: 0, min: 0 },
      maxCategories: { type: Number, default: 0, min: 0 },
      maxMenuItems: { type: Number, default: 0, min: 0 },
    },
  },
  { timestamps: true },
);

planAccessSettingsSchema.statics.getSingleton = async function getSingleton() {
  let doc = await this.findOne();
  if (!doc) {
    const trialFeatureFlags = {};
    for (const key of PLAN_FEATURE_KEYS) {
      trialFeatureFlags[key] = key !== 'backup';
    }
    doc = await this.create({
      trialDays: parseInt(process.env.RESTAURANT_TRIAL_DAYS, 10) || 14,
      trialFeatureFlags,
      trialLimits: mergePlanLimits(),
    });
  } else if (!doc.trialLimits) {
    doc.trialLimits = mergePlanLimits();
    await doc.save();
  }
  return doc;
};

module.exports = mongoose.model('PlanAccessSettings', planAccessSettingsSchema);
