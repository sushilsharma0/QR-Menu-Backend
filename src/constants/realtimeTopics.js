/** Topics pushed over Socket.IO so clients can refetch matching views. */
const REALTIME_TOPICS = {
  ALL: 'all',
  SUBSCRIPTION: 'subscription',
  MENU: 'menu',
  ORDERS: 'orders',
  TABLES: 'tables',
  STAFF: 'staff',
  KYC: 'kyc',
  SETTINGS: 'settings',
  BRANCHES: 'branches',
  PROMOTIONS: 'promotions',
  FINANCE: 'finance',
  INVENTORY: 'inventory',
  DASHBOARD: 'dashboard',
  BACKUP: 'backup',
  PLATFORM: 'platform',
  NOTIFICATIONS: 'notifications',
};

module.exports = { REALTIME_TOPICS };
