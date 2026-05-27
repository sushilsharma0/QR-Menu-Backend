const {
  PLAN_FEATURE_DEFINITIONS,
  PLAN_FEATURE_KEYS,
} = require('../constants/planFeatures');

const GRANULAR_OVERVIEW_KEYS = ['dashboard', 'salesReports'];
const GRANULAR_FINANCE_KEYS = ['financeOverview', 'expenses', 'budget', 'profitLoss', 'accounting', 'payroll'];

const PLAN_LIMIT_KEYS = ['maxTables', 'maxEmployees', 'maxCategories', 'maxMenuItems'];

function defaultFeatureFlags() {
  const o = {};
  for (const k of PLAN_FEATURE_KEYS) {
    o[k] = true;
  }
  return o;
}

function hasOwn(input, key) {
  return input && typeof input === 'object' && Object.prototype.hasOwnProperty.call(input, key);
}

/**
 * Maps legacy `analytics` / `employees` flags to granular keys when older plans omit them.
 */
function applyLegacyDerivations(flags, input) {
  const raw = input && typeof input === 'object' ? input : {};

  const hasGranularOverview = GRANULAR_OVERVIEW_KEYS.some((k) => hasOwn(raw, k));
  const hasGranularFinance = GRANULAR_FINANCE_KEYS.some((k) => hasOwn(raw, k));

  if (!hasGranularOverview && hasOwn(raw, 'analytics')) {
    const on = raw.analytics !== false;
    for (const k of GRANULAR_OVERVIEW_KEYS) {
      flags[k] = on;
    }
  }

  if (!hasGranularFinance && hasOwn(raw, 'analytics')) {
    const on = raw.analytics !== false;
    for (const k of GRANULAR_FINANCE_KEYS) {
      flags[k] = on;
    }
  }

  if (!hasOwn(raw, 'payroll') && hasOwn(raw, 'employees')) {
    flags.payroll = raw.employees !== false;
  }

  const overviewOn =
    flags.dashboard !== false ||
    flags.salesReports !== false ||
    GRANULAR_FINANCE_KEYS.some((k) => flags[k] !== false);

  flags.analytics = overviewOn;

  return flags;
}

function usesGranularPlanFormat(raw) {
  if (!raw || typeof raw !== 'object') return false;
  return (
    GRANULAR_FINANCE_KEYS.some((k) => hasOwn(raw, k)) ||
    GRANULAR_OVERVIEW_KEYS.some((k) => hasOwn(raw, k)) ||
    PLAN_FEATURE_KEYS.filter((k) => hasOwn(raw, k)).length >= 8
  );
}

function mergeFeatureFlags(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const strictDefaults = usesGranularPlanFormat(raw);
  const out = {};

  for (const k of PLAN_FEATURE_KEYS) {
    if (hasOwn(raw, k)) {
      out[k] = Boolean(raw[k]);
    } else if (strictDefaults) {
      out[k] = false;
    } else {
      out[k] = true;
    }
  }

  return applyLegacyDerivations(out, raw);
}

function featureLabelsFromFlags(flags) {
  return PLAN_FEATURE_DEFINITIONS.filter((d) => !d.legacy && flags[d.key]).map((d) => d.label);
}

function parseCustomLimits(limits) {
  if (!limits || typeof limits !== 'object') {
    return { error: 'limits object is required' };
  }
  const out = {};
  for (const k of PLAN_LIMIT_KEYS) {
    if (limits[k] === undefined || limits[k] === null || limits[k] === '') {
      return { error: `${k} is required` };
    }
    const n = Number(limits[k]);
    if (!Number.isFinite(n) || n < 0 || n > 999999) {
      return { error: `${k} must be a number between 0 and 999999` };
    }
    out[k] = Math.floor(n);
  }
  return { limits: out };
}

function mergePlanLimits(input, fallback = {}) {
  const out = {};
  for (const k of PLAN_LIMIT_KEYS) {
    const raw = input && Object.prototype.hasOwnProperty.call(input, k)
      ? input[k]
      : fallback[k];
    const n = Number(raw ?? 0);
    out[k] = Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 999999) : 0;
  }
  return out;
}

module.exports = {
  mergeFeatureFlags,
  featureLabelsFromFlags,
  parseCustomLimits,
  mergePlanLimits,
  defaultFeatureFlags,
  applyLegacyDerivations,
  PLAN_LIMIT_KEYS,
};
