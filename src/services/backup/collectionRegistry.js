const Restaurant = require('../../models/restaurant/Restaurant');
const Branch = require('../../models/restaurant/Branch');
const BranchAuth = require('../../models/restaurant/BranchAuth');
const Category = require('../../models/restaurant/Category');
const MenuItem = require('../../models/restaurant/MenuItem');
const Table = require('../../models/restaurant/Table');
const Employee = require('../../models/restaurant/Employee');
const Order = require('../../models/restaurant/Order');
const CustomerOrder = require('../../models/restaurant/CustomerOrder');
const InventoryItem = require('../../models/restaurant/InventoryItem');
const InventoryLog = require('../../models/restaurant/InventoryLog');
const InventoryPurchase = require('../../models/restaurant/InventoryPurchase');
const Supplier = require('../../models/restaurant/Supplier');
const Expense = require('../../models/restaurant/Expense');
const Budget = require('../../models/restaurant/Budget');
const ChartOfAccount = require('../../models/restaurant/ChartOfAccount');
const JournalEntry = require('../../models/restaurant/JournalEntry');
const Payroll = require('../../models/restaurant/Payroll');
const PayrollTransaction = require('../../models/restaurant/PayrollTransaction');
const Invoice = require('../../models/restaurant/Invoice');
const POSInvoice = require('../../models/restaurant/POSInvoice');
const POSPayment = require('../../models/restaurant/POSPayment');
const POSShift = require('../../models/restaurant/POSShift');
const POSActivity = require('../../models/restaurant/POSActivity');
const Promotion = require('../../models/restaurant/Promotion');
const Recipe = require('../../models/restaurant/Recipe');
const SalesReport = require('../../models/restaurant/SalesReport');
const ProfitLossReport = require('../../models/restaurant/ProfitLossReport');
const TaxSettings = require('../../models/restaurant/TaxSettings');
const TdsSettings = require('../../models/restaurant/TdsSettings');
const FinancialPeriodLock = require('../../models/restaurant/FinancialPeriodLock');
const AccountingApproval = require('../../models/restaurant/AccountingApproval');
const RestaurantCreditCustomer = require('../../models/restaurant/RestaurantCreditCustomer');
const SubscriptionPayment = require('../../models/shared/SubscriptionPayment');
const PackageHistory = require('../../models/shared/PackageHistory');
const SubscriptionInvoice = require('../../models/shared/SubscriptionInvoice');
const Notification = require('../../models/platform/Notification');
const AuditLog = require('../../models/platform/AuditLog');

/** Restore order matters for FK dependencies */
const COLLECTION_CONFIGS = [
  { key: 'restaurant', model: Restaurant, section: 'restaurant', single: true, filter: (rid) => ({ _id: rid }), restoreOrder: 0, skipOnRestore: true },
  { key: 'branches', model: Branch, section: 'branches', tenantField: 'restaurantId', restoreOrder: 10, skipOnRestore: true },
  { key: 'branchAuth', model: BranchAuth, section: 'branches', tenantField: 'restaurantId', restoreOrder: 11, skipOnRestore: true },
  { key: 'categories', model: Category, section: 'menu', tenantField: 'restaurant', restoreOrder: 20 },
  { key: 'menuItems', model: MenuItem, section: 'menu', tenantField: 'restaurant', restoreOrder: 21 },
  { key: 'recipes', model: Recipe, section: 'menu', tenantField: 'restaurantId', restoreOrder: 22 },
  { key: 'tables', model: Table, section: 'tables', tenantField: 'restaurant', restoreOrder: 30 },
  { key: 'employees', model: Employee, section: 'employees', tenantField: 'restaurant', restoreOrder: 40 },
  { key: 'suppliers', model: Supplier, section: 'inventory', tenantField: 'restaurantId', restoreOrder: 50 },
  { key: 'inventoryItems', model: InventoryItem, section: 'inventory', tenantField: 'restaurantId', restoreOrder: 51 },
  { key: 'inventoryLogs', model: InventoryLog, section: 'inventory', tenantField: 'restaurantId', restoreOrder: 52 },
  { key: 'inventoryPurchases', model: InventoryPurchase, section: 'inventory', tenantField: 'restaurantId', restoreOrder: 53 },
  { key: 'chartOfAccounts', model: ChartOfAccount, section: 'accounting', tenantField: 'restaurantId', restoreOrder: 60 },
  { key: 'expenses', model: Expense, section: 'accounting', tenantField: 'restaurantId', restoreOrder: 61 },
  { key: 'budgets', model: Budget, section: 'accounting', tenantField: 'restaurantId', restoreOrder: 62 },
  { key: 'journalEntries', model: JournalEntry, section: 'accounting', tenantField: 'restaurantId', restoreOrder: 63 },
  { key: 'financialPeriodLocks', model: FinancialPeriodLock, section: 'accounting', tenantField: 'restaurantId', restoreOrder: 64 },
  { key: 'accountingApprovals', model: AccountingApproval, section: 'accounting', tenantField: 'restaurantId', restoreOrder: 65 },
  { key: 'payroll', model: Payroll, section: 'payroll', tenantField: 'restaurantId', restoreOrder: 70 },
  { key: 'payrollTransactions', model: PayrollTransaction, section: 'payroll', tenantField: 'restaurantId', restoreOrder: 71 },
  { key: 'promotions', model: Promotion, section: 'promotions', tenantField: 'restaurantId', restoreOrder: 80 },
  { key: 'orders', model: Order, section: 'orders', tenantField: 'restaurant', restoreOrder: 90 },
  { key: 'customerOrders', model: CustomerOrder, section: 'customerOrders', tenantField: 'restaurant', restoreOrder: 91 },
  { key: 'invoices', model: Invoice, section: 'invoices', tenantField: 'restaurantId', restoreOrder: 100 },
  { key: 'posInvoices', model: POSInvoice, section: 'invoices', tenantField: 'restaurantId', restoreOrder: 101 },
  { key: 'posPayments', model: POSPayment, section: 'invoices', tenantField: 'restaurantId', restoreOrder: 102 },
  { key: 'posShifts', model: POSShift, section: 'invoices', tenantField: 'restaurantId', restoreOrder: 103 },
  { key: 'taxSettings', model: TaxSettings, section: 'settings', tenantField: 'restaurantId', restoreOrder: 110, singleton: true },
  { key: 'tdsSettings', model: TdsSettings, section: 'settings', tenantField: 'restaurantId', restoreOrder: 111, singleton: true },
  { key: 'creditCustomers', model: RestaurantCreditCustomer, section: 'settings', tenantField: 'restaurantId', restoreOrder: 112 },
  { key: 'packageHistory', model: PackageHistory, section: 'subscriptions', tenantField: 'restaurant', restoreOrder: 120, skipOnRestore: true },
  { key: 'subscriptionPayments', model: SubscriptionPayment, section: 'subscriptions', tenantField: 'restaurant', restoreOrder: 121, skipOnRestore: true },
  { key: 'subscriptionInvoices', model: SubscriptionInvoice, section: 'subscriptions', tenantField: 'restaurant', restoreOrder: 122, skipOnRestore: true },
  { key: 'salesReports', model: SalesReport, section: 'analytics', tenantField: 'restaurantId', restoreOrder: 130 },
  { key: 'profitLossReports', model: ProfitLossReport, section: 'analytics', tenantField: 'restaurantId', restoreOrder: 131 },
  { key: 'posActivities', model: POSActivity, section: 'logs', tenantField: 'restaurantId', restoreOrder: 140, skipOnRestore: true },
  { key: 'notifications', model: Notification, section: 'notifications', restoreOrder: 150, skipOnRestore: true, filter: (rid) => ({ recipientId: String(rid), recipientType: 'restaurant' }) },
  { key: 'auditLogs', model: AuditLog, section: 'logs', restoreOrder: 151, skipOnRestore: true, filter: (rid) => ({ 'details.restaurantId': String(rid) }) },
];

function getRestoreConfigs(sections = null) {
  let configs = COLLECTION_CONFIGS.filter((c) => !c.skipOnRestore);
  if (sections && sections.length) {
    configs = configs.filter((c) => sections.includes(c.section));
  }
  return configs.sort((a, b) => a.restoreOrder - b.restoreOrder);
}

function getBackupConfigs(sections) {
  if (!sections || !sections.length) return COLLECTION_CONFIGS;
  return COLLECTION_CONFIGS.filter((c) => sections.includes(c.section));
}

function configByKey(key) {
  return COLLECTION_CONFIGS.find((c) => c.key === key);
}

module.exports = {
  COLLECTION_CONFIGS,
  getRestoreConfigs,
  getBackupConfigs,
  configByKey,
};
