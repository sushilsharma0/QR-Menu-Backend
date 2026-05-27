/**
 * Restaurant capabilities controlled per subscription plan.
 * Super admin toggles on catalog plans (Create Plan) and custom assignments.
 * Copied to Restaurant.planFeatureFlags on assign; false = hidden in UI + blocked on API.
 *
 * `analytics` is legacy (bundled overview + finance); kept for old plans — hidden in admin UI.
 */
const PLAN_FEATURE_GROUPS = [
  {
    id: 'overview',
    label: 'Overview & reports',
    description: 'Dashboard and sales analytics',
  },
  {
    id: 'service',
    label: 'Operations',
    description: 'POS, orders, menu, tables, promotions',
  },
  {
    id: 'business',
    label: 'Business',
    description: 'Staff, branches, credit accounts',
  },
  {
    id: 'finance',
    label: 'Finance & accounting',
    description: 'Expenses, budget, P&L, payroll, inventory, invoices',
  },
  {
    id: 'support',
    label: 'Account & support',
    description: 'Settings, tickets, audit logs, backup',
  },
];

const PLAN_FEATURE_DEFINITIONS = [
  {
    key: 'dashboard',
    group: 'overview',
    label: 'Dashboard',
    description: 'Main restaurant dashboard and KPIs',
    restaurantNav: ['dashboard'],
  },
  {
    key: 'salesReports',
    group: 'overview',
    label: 'Sales reports',
    description: 'Order activity and sales reporting',
    restaurantNav: ['orders/activity'],
  },
  {
    key: 'menu',
    group: 'service',
    label: 'Menu & categories',
    description: 'Categories, menu items, and recipes',
    restaurantNav: ['menu'],
  },
  {
    key: 'orders',
    group: 'service',
    label: 'Order management',
    description: 'Kitchen queue, order status, cancellations, and order stats',
    restaurantNav: ['orders'],
  },
  {
    key: 'customerOrders',
    group: 'service',
    label: 'POS & new orders',
    description: 'POS screen, manual/new order entry, and QR customer ordering',
    restaurantNav: ['pos'],
  },
  {
    key: 'tables',
    group: 'service',
    label: 'Tables & QR codes',
    description: 'Table layout and QR management',
    restaurantNav: ['tables'],
  },
  {
    key: 'promotions',
    group: 'service',
    label: 'Promotions',
    description: 'Discounts and campaigns',
    restaurantNav: ['promotions'],
  },
  {
    key: 'cashier',
    group: 'service',
    label: 'Cashier payments',
    description: 'Dedicated cashier flows (staff portal)',
    restaurantNav: [],
  },
  {
    key: 'employees',
    group: 'business',
    label: 'Staff management',
    description: 'Employee accounts, roles, and permissions',
    restaurantNav: ['employees'],
  },
  {
    key: 'branches',
    group: 'business',
    label: 'Branch management',
    description: 'Multi-branch outlets and branch portals',
    restaurantNav: ['branches'],
  },
  {
    key: 'creditCustomers',
    group: 'business',
    label: 'Credit customers',
    description: 'House accounts and credit ledger',
    restaurantNav: ['credit-customers'],
  },
  {
    key: 'financeOverview',
    group: 'finance',
    label: 'Finance overview',
    description: 'Finance dashboard, sales sync, ERP summary',
    restaurantNav: ['finance/dashboard'],
  },
  {
    key: 'expenses',
    group: 'finance',
    label: 'Expenses',
    description: 'Record and manage business expenses',
    restaurantNav: ['finance/expenses'],
  },
  {
    key: 'budget',
    group: 'finance',
    label: 'Budget',
    description: 'Budget planning and variance tracking',
    restaurantNav: ['finance/budget'],
  },
  {
    key: 'profitLoss',
    group: 'finance',
    label: 'Profit & loss',
    description: 'P&L reports and period performance',
    restaurantNav: ['finance/profit-loss'],
  },
  {
    key: 'accounting',
    group: 'finance',
    label: 'Accounting',
    description: 'Chart of accounts, journals, trial balance, tax & period locks',
    restaurantNav: ['finance/accounting'],
  },
  {
    key: 'payroll',
    group: 'finance',
    label: 'Payroll',
    description: 'Payroll runs, payslips, and salary payments',
    restaurantNav: ['finance/payroll'],
  },
  {
    key: 'inventory',
    group: 'finance',
    label: 'Inventory',
    description: 'Stock, procurement, suppliers, and inventory accounting',
    restaurantNav: ['finance/inventory'],
  },
  {
    key: 'billing',
    group: 'finance',
    label: 'Invoices & billing',
    description: 'Finance invoices and billing views',
    restaurantNav: ['finance/invoices'],
  },
  {
    key: 'supportTickets',
    group: 'support',
    label: 'Support tickets',
    description: 'Platform support tickets',
    restaurantNav: ['tickets'],
  },
  {
    key: 'activityLogs',
    group: 'support',
    label: 'Audit logs',
    description: 'Employee and system activity trail',
    restaurantNav: ['logs'],
  },
  {
    key: 'accountSettings',
    group: 'support',
    label: 'Settings & profile',
    description: 'Branding, profile, and account security',
    restaurantNav: ['settings', 'public-profile', 'profile', 'security'],
  },
  {
    key: 'backup',
    group: 'support',
    label: 'Backup & restore',
    description: 'Encrypted backups and restore',
    restaurantNav: ['backup-recovery'],
  },
  /** @deprecated Legacy bundle — derived from granular flags for old plans; not shown in plan builder UI */
  {
    key: 'analytics',
    group: 'overview',
    label: 'Overview (legacy)',
    description: 'Legacy bundled overview + finance flag',
    legacy: true,
    restaurantNav: [],
  },
];

const PLAN_FEATURE_KEYS = PLAN_FEATURE_DEFINITIONS.map((d) => d.key);

const PLAN_FEATURE_UI_DEFINITIONS = PLAN_FEATURE_DEFINITIONS.filter((d) => !d.legacy);

module.exports = {
  PLAN_FEATURE_GROUPS,
  PLAN_FEATURE_DEFINITIONS,
  PLAN_FEATURE_UI_DEFINITIONS,
  PLAN_FEATURE_KEYS,
};
