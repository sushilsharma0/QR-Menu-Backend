/** Enterprise backup / migration constants */
const BACKUP_VERSION = '2.0.0';
const SCHEMA_VERSION = '2';
const ENCRYPTION_VERSION = 'AES-256-GCM-v1';

const MAGIC_LEGACY = 'QRBAK1:';
const MAGIC = 'QRBACKUP1:';
const FILE_EXTENSIONS = ['.qrbackup', '.qrbak'];

const ALL_SECTIONS = [
  'restaurant',
  'branches',
  'menu',
  'tables',
  'employees',
  'orders',
  'customerOrders',
  'inventory',
  'accounting',
  'payroll',
  'invoices',
  'subscriptions',
  'promotions',
  'settings',
  'notifications',
  'analytics',
  'logs',
  'media',
];

/** Partial restore UI groups → internal sections */
const PARTIAL_RESTORE_GROUPS = {
  menu: ['menu'],
  inventory: ['inventory'],
  accounting: ['accounting'],
  customers: ['customerOrders', 'settings'],
  employees: ['employees'],
  payroll: ['payroll'],
  settings: ['settings'],
  branches: ['branches'],
  tables: ['tables'],
  orders: ['orders', 'customerOrders'],
  invoices: ['invoices'],
  promotions: ['promotions'],
};

const RESTORE_MODES = [
  'full',
  'partial',
  'merge',
  'replace',
  'migration',
  'create_new_branch',
  'branch_clone',
];

const CONFLICT_STRATEGIES = ['skip', 'replace', 'rename', 'merge', 'duplicate'];

const RESTORE_STEPS = [
  { key: 'validate', label: 'Validating backup' },
  { key: 'snapshot', label: 'Creating safety snapshot' },
  { key: 'branches', label: 'Restoring branches' },
  { key: 'menu', label: 'Restoring menu' },
  { key: 'tables', label: 'Restoring tables' },
  { key: 'employees', label: 'Restoring employees' },
  { key: 'inventory', label: 'Restoring inventory' },
  { key: 'orders', label: 'Restoring orders' },
  { key: 'accounting', label: 'Restoring accounting' },
  { key: 'payroll', label: 'Restoring payroll' },
  { key: 'invoices', label: 'Restoring invoices' },
  { key: 'settings', label: 'Restoring settings' },
  { key: 'relationships', label: 'Processing relationships' },
  { key: 'finalize', label: 'Finalizing restore' },
];

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordHash',
  'posPinHash',
  'resetOTP',
  'resetOTPExpiry',
  'resetOTPAttempts',
  'emailVerificationOTP',
  'emailVerificationOTPExpiry',
  'refreshToken',
  'refreshTokenHash',
  'accessToken',
  'jwt',
  'otp',
  'secret',
  'apiKey',
  'apiSecret',
  'privateKey',
  'sessionToken',
]);

/** Operational fields that must NOT be stripped by sanitize */
const SANITIZE_ALLOWLIST = new Set([
  'qrToken',
  'qrTokenHash',
  'qrTokenVersion',
  'checkoutRequestId',
]);

const SUPPORTED_BACKUP_VERSIONS = new Set(['1.0.0', '2.0.0']);

module.exports = {
  BACKUP_VERSION,
  SCHEMA_VERSION,
  ENCRYPTION_VERSION,
  MAGIC_LEGACY,
  MAGIC,
  FILE_EXTENSIONS,
  ALL_SECTIONS,
  PARTIAL_RESTORE_GROUPS,
  RESTORE_MODES,
  CONFLICT_STRATEGIES,
  RESTORE_STEPS,
  SENSITIVE_KEYS,
  SANITIZE_ALLOWLIST,
  SUPPORTED_BACKUP_VERSIONS,
};
