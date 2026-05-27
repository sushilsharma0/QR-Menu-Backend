/**
 * Branch portal module keys — aligned with restaurant sidebar / planFeatures.js.
 * Restaurant-only items (branches, kyc, subscription) are omitted.
 */

const BRANCH_MODULE_KEYS = [
  'dashboard',
  'salesReports',
  'customerOrders',
  'orders',
  'menu',
  'tables',
  'promotions',
  'creditCustomers',
  'employees',
  'financeOverview',
  'expenses',
  'budget',
  'profitLoss',
  'inventory',
  'payroll',
  'billing',
  'accounting',
  'supportTickets',
  'accountSettings',
  'backup',
  'activityLogs',
]

const DEFAULT_ENABLED_MODULES = Object.freeze({
  dashboard: true,
  salesReports: true,
  customerOrders: true,
  orders: true,
  menu: true,
  tables: true,
  promotions: false,
  creditCustomers: false,
  employees: true,
  financeOverview: false,
  expenses: false,
  budget: false,
  profitLoss: false,
  inventory: false,
  payroll: false,
  billing: false,
  accounting: false,
  supportTickets: true,
  accountSettings: true,
  backup: false,
  activityLogs: false,
})

/** Legacy keys stored on older branches — mapped when reading */
const LEGACY_TO_CANONICAL = Object.freeze({
  pos: 'customerOrders',
  analytics: 'salesReports',
})

/** Maps API / route groups to enabledModules keys */
const FEATURE_TO_MODULE = Object.freeze({
  dashboard: 'dashboard',
  salesReports: 'salesReports',
  customerOrders: 'customerOrders',
  orders: 'orders',
  menu: 'menu',
  tables: 'tables',
  promotions: 'promotions',
  creditCustomers: 'creditCustomers',
  employees: 'employees',
  financeOverview: 'financeOverview',
  expenses: 'expenses',
  budget: 'budget',
  profitLoss: 'profitLoss',
  inventory: 'inventory',
  payroll: 'payroll',
  billing: 'billing',
  accounting: 'accounting',
  supportTickets: 'supportTickets',
  accountSettings: 'accountSettings',
  backup: 'backup',
  activityLogs: 'activityLogs',
  /** @deprecated */
  pos: 'customerOrders',
  analytics: 'salesReports',
  cashier: 'customerOrders',
})

/** Alternate keys checked when resolving access (legacy storage) */
const MODULE_ACCESS_ALIASES = Object.freeze({
  customerOrders: ['pos'],
  salesReports: ['analytics'],
  pos: ['customerOrders'],
  analytics: ['salesReports'],
})

/** Default module access per branch role (subset of enabled modules) */
const ROLE_MODULE_ALLOW = Object.freeze({
  branch_admin: null,
  branch_manager: null,
  branch_cashier: new Set([
    'dashboard',
    'salesReports',
    'orders',
    'menu',
    'tables',
    'customerOrders',
  ]),
  branch_waiter: new Set(['dashboard', 'salesReports', 'orders', 'menu', 'tables']),
  branch_kitchen: new Set(['dashboard', 'salesReports', 'orders', 'menu']),
})

const FINANCE_SUB_KEYS = ['financeOverview', 'expenses', 'budget', 'profitLoss', 'billing']

function applyLegacyAliases(partial, out) {
  if (!partial || typeof partial !== 'object') return
  for (const [legacy, canonical] of Object.entries(LEGACY_TO_CANONICAL)) {
    if (Object.prototype.hasOwnProperty.call(partial, legacy) && !Object.prototype.hasOwnProperty.call(partial, canonical)) {
      out[canonical] = Boolean(partial[legacy])
    }
  }
  if (partial.accounting === false) {
    for (const key of FINANCE_SUB_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(partial, key)) {
        out[key] = false
      }
    }
  }
}

function mergeEnabledModules(partial) {
  const out = { ...DEFAULT_ENABLED_MODULES }
  if (partial && typeof partial === 'object') {
    applyLegacyAliases(partial, out)
    for (const key of BRANCH_MODULE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(partial, key)) {
        out[key] = Boolean(partial[key])
      }
    }
  }
  return out
}

function allEnabledModules() {
  const out = {}
  for (const key of BRANCH_MODULE_KEYS) out[key] = true
  return out
}

function isBranchModuleDisabled(modules, moduleKey) {
  const mod = modules || {}
  const canonical = FEATURE_TO_MODULE[moduleKey] || moduleKey
  if (mod[canonical] === false) return true
  const aliases = MODULE_ACCESS_ALIASES[canonical] || []
  return aliases.some((alias) => mod[alias] === false)
}

function resolveFinanceModuleKey(path = '') {
  const p = String(path || '')
  if (p.includes('/tds')) return 'payroll'
  if (p.includes('/inventory')) return 'inventory'
  if (p.includes('/expenses') || p.startsWith('/expenses')) return 'expenses'
  if (p.includes('/budget')) return 'budget'
  if (p.includes('/profit-loss')) return 'profitLoss'
  if (p.includes('/invoices') || p.includes('/billing')) return 'billing'
  if (p.includes('/erp-dashboard') || p.includes('/revenue-by-channel') || p.includes('/sales')) {
    return 'financeOverview'
  }
  if (p.includes('/accounting')) return 'accounting'
  return 'accounting'
}

module.exports = {
  BRANCH_MODULE_KEYS,
  DEFAULT_ENABLED_MODULES,
  FEATURE_TO_MODULE,
  ROLE_MODULE_ALLOW,
  MODULE_ACCESS_ALIASES,
  LEGACY_TO_CANONICAL,
  allEnabledModules,
  mergeEnabledModules,
  isBranchModuleDisabled,
  resolveFinanceModuleKey,
}
