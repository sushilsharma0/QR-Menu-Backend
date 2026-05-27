const mongoose = require('mongoose');
const FraudAlert = require('../models/platform/FraudAlert');
const FraudLock = require('../models/platform/FraudLock');
const AuditLog = require('../models/platform/AuditLog');
const Platform = require('../models/platform/Platform');
const POSRefund = require('../models/restaurant/POSRefund');
const POSActivity = require('../models/restaurant/POSActivity');
const CustomerOrder = require('../models/restaurant/CustomerOrder');
const POSPayment = require('../models/restaurant/POSPayment');
const notificationService = require('./notificationService');

const thresholds = {
  refundCountHour: Number(process.env.FRAUD_REFUND_COUNT_HOUR || 3),
  voidCountDay: Number(process.env.FRAUD_VOID_COUNT_DAY || 3),
  discountPercent: Number(process.env.FRAUD_DISCOUNT_PERCENT || 30),
  failedPaymentsHour: Number(process.env.FRAUD_FAILED_PAYMENTS_HOUR || 5),
  failedLoginsWindow: Number(process.env.FRAUD_FAILED_LOGINS_WINDOW || 5),
  failedLoginsMinutes: Number(process.env.FRAUD_FAILED_LOGINS_MINUTES || 15),
  lockMinutes: Number(process.env.FRAUD_LOCK_MINUTES || 30),
  duplicateOrderMinutes: Number(process.env.FRAUD_DUPLICATE_ORDER_MINUTES || 3),
  salesSpikeMultiplier: Number(process.env.FRAUD_SALES_SPIKE_MULTIPLIER || 3),
  salesSpikeMinRevenue: Number(process.env.FRAUD_SALES_SPIKE_MIN_REVENUE || 1000),
};

const since = (minutes) => new Date(Date.now() - minutes * 60 * 1000);
const hourAgo = () => since(60);
const dayAgo = () => since(24 * 60);

function normalizeObjectId(value) {
  if (!value || !mongoose.Types.ObjectId.isValid(String(value))) return null;
  return new mongoose.Types.ObjectId(String(value));
}

async function notifyPlatformAdmins(alert) {
  const admins = await Platform.find({
    isActive: true,
    $or: [{ role: 'super_admin' }, { 'permissions.manageSystem': true }, { 'permissions.viewAnalytics': true }],
  }).select('_id').lean();

  for (const admin of admins) {
    await notificationService.sendNotification({
      recipientType: 'platform',
      recipientId: admin._id,
      category: 'security',
      type: 'fraud_alert',
      priority: alert.severity === 'critical' ? 'critical' : 'high',
      title: alert.title,
      message: alert.message,
      relatedEntity: { entityType: 'fraud_alert', entityId: alert._id },
      restaurantId: alert.restaurantId,
      branchId: alert.branchId,
      actionUrl: '/platform/security',
      dedupeKey: `platform-fraud-${alert._id}-${admin._id}`,
      // In-app notification only — no popup toast on platform (restaurant login failures).
      silent: true,
    });
  }
}

async function createAlert({
  restaurantId,
  branchId = null,
  type,
  severity = 'medium',
  title,
  message,
  actor = null,
  actorModel = 'Restaurant',
  resourceType = '',
  resourceId = null,
  evidence = {},
  dedupeKey,
  lockSubject = null,
}) {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const existing = await FraudAlert.findOne({
    dedupeKey,
    status: { $in: ['open', 'investigating'] },
    createdAt: { $gte: dayAgo() },
  });
  if (existing) return existing;

  const alert = await FraudAlert.create({
    restaurantId: normalizeObjectId(restaurantId),
    branchId: normalizeObjectId(branchId),
    type,
    severity,
    title,
    message,
    actor,
    actorModel,
    resourceType,
    resourceId,
    evidence,
    dedupeKey,
    expiresAt,
  });

  if (restaurantId) {
    await notificationService.sendNotification({
      recipientType: 'restaurant',
      recipientId: restaurantId,
      category: 'security',
      type: 'fraud_alert',
      priority: severity === 'critical' ? 'critical' : 'high',
      title,
      message,
      relatedEntity: { entityType: 'fraud_alert', entityId: alert._id },
      restaurantId,
      branchId,
      actionUrl: '/notifications',
      dedupeKey: `restaurant-fraud-${alert._id}`,
    });
  }

  await notifyPlatformAdmins(alert);

  if (lockSubject) {
    await FraudLock.findOneAndUpdate(
      {
        subjectType: lockSubject.subjectType,
        subjectId: String(lockSubject.subjectId),
        active: true,
        lockedUntil: { $gt: new Date() },
      },
      {
        $set: {
          restaurantId: normalizeObjectId(restaurantId),
          branchId: normalizeObjectId(branchId),
          reason: message,
          alert: alert._id,
          lockedUntil: new Date(Date.now() + thresholds.lockMinutes * 60 * 1000),
          active: true,
        },
      },
      { upsert: true, new: true }
    );
  }

  return alert;
}

async function detectRefundFraud({ req, order, refund, amount, kind }) {
  const restaurantId = String(order.restaurant || req.user?.restaurantId || req.user?.id || '');
  const count = await POSRefund.countDocuments({
    restaurant: order.restaurant,
    branchId: order.branchId || null,
    requestedBy: req.user?.employeeId || req.user?.id,
    createdAt: { $gte: hourAgo() },
  });
  const ratio = Number(amount || 0) / Math.max(1, Number(order.grandTotal || 0));
  if (count >= thresholds.refundCountHour || ratio > 0.75 || kind === 'void') {
    await createAlert({
      restaurantId,
      branchId: order.branchId,
      type: kind === 'void' ? 'excessive_void_bills' : 'fake_refund',
      severity: ratio > 0.75 || kind === 'void' ? 'high' : 'medium',
      title: kind === 'void' ? 'Suspicious void bill activity' : 'Suspicious refund activity',
      message: `POS ${kind} detected for order ${order.orderNumber}. Recent refunds by actor: ${count}.`,
      actor: req.user?.employeeId || req.user?.id,
      actorModel: req.user?.scope === 'employee' ? 'Employee' : req.user?.scope === 'branch_user' ? 'BranchAuth' : 'Restaurant',
      resourceType: 'order',
      resourceId: order._id,
      evidence: { refundId: refund?._id, amount, kind, ratio, recentRefundCount: count },
      dedupeKey: `refund:${restaurantId}:${req.user?.employeeId || req.user?.id}:${kind}:${new Date().toISOString().slice(0, 13)}`,
    });
  }
}

async function detectSuspiciousDiscount({ req, order, discountAmount, discountPercent, impliedDiscPct }) {
  if (Number(discountAmount || 0) <= 0 && Number(discountPercent || 0) <= 0) return;
  if (Number(impliedDiscPct || 0) < thresholds.discountPercent) return;
  await createAlert({
    restaurantId: String(order.restaurant),
    branchId: order.branchId,
    type: 'suspicious_discount',
    severity: impliedDiscPct >= 50 ? 'high' : 'medium',
    title: 'Suspicious POS discount',
    message: `Discount of ${impliedDiscPct.toFixed(1)}% was applied to order ${order.orderNumber}.`,
    actor: req.user?.employeeId || req.user?.id,
    actorModel: req.user?.scope === 'employee' ? 'Employee' : req.user?.scope === 'branch_user' ? 'BranchAuth' : 'Restaurant',
    resourceType: 'order',
    resourceId: order._id,
    evidence: { discountAmount, discountPercent, impliedDiscPct, orderNumber: order.orderNumber },
    dedupeKey: `discount:${order._id}`,
  });
}

async function detectDuplicateOrder({ req, order }) {
  const windowStart = since(thresholds.duplicateOrderMinutes);
  const signature = JSON.stringify((order.items || []).map((item) => ({
    id: String(item.menuItem || ''),
    q: Number(item.quantity || 0),
    p: Number(item.price || 0),
  })).sort((a, b) => a.id.localeCompare(b.id)));
  const candidates = await CustomerOrder.find({
    _id: { $ne: order._id },
    restaurant: order.restaurant,
    branchId: order.branchId || null,
    table: order.table,
    grandTotal: order.grandTotal,
    createdAt: { $gte: windowStart },
    isActive: true,
  }).select('orderNumber items grandTotal createdAt').lean();
  const duplicate = candidates.find((candidate) => {
    const other = JSON.stringify((candidate.items || []).map((item) => ({
      id: String(item.menuItem || ''),
      q: Number(item.quantity || 0),
      p: Number(item.price || 0),
    })).sort((a, b) => a.id.localeCompare(b.id)));
    return other === signature;
  });
  if (!duplicate) return;
  await createAlert({
    restaurantId: String(order.restaurant),
    branchId: order.branchId,
    type: 'duplicate_orders',
    severity: 'medium',
    title: 'Possible duplicate POS order',
    message: `Order ${order.orderNumber} looks like duplicate order ${duplicate.orderNumber}.`,
    actor: req.user?.employeeId || req.user?.id,
    actorModel: req.user?.scope === 'employee' ? 'Employee' : req.user?.scope === 'branch_user' ? 'BranchAuth' : 'Restaurant',
    resourceType: 'order',
    resourceId: order._id,
    evidence: { duplicateOrderId: duplicate._id, duplicateOrderNumber: duplicate.orderNumber },
    dedupeKey: `duplicate-order:${order._id}:${duplicate._id}`,
  });
}

async function detectFailedPayments({ restaurantId, branchId, actor, actorModel = 'Employee' }) {
  const recent = await POSPayment.countDocuments({
    restaurant: restaurantId,
    branchId: branchId || null,
    processedBy: actor,
    createdAt: { $gte: hourAgo() },
    status: 'failed',
  });
  if (recent < thresholds.failedPaymentsHour) return;
  await createAlert({
    restaurantId,
    branchId,
    type: 'multiple_failed_payments',
    severity: 'high',
    title: 'Multiple failed POS payments',
    message: `${recent} failed POS payments were detected for one cashier within an hour.`,
    actor,
    actorModel,
    resourceType: 'payment',
    evidence: { failedPaymentCount: recent },
    dedupeKey: `failed-payments:${restaurantId}:${actor}:${new Date().toISOString().slice(0, 13)}`,
  });
}

async function detectSalesSpike({ restaurantId, branchId }) {
  const rid = normalizeObjectId(restaurantId);
  if (!rid) return;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - 7);
  const matchBase = { restaurant: rid, ...(branchId ? { branchId: normalizeObjectId(branchId) } : {}), paymentStatus: 'paid' };
  const [todayAgg, weekAgg] = await Promise.all([
    CustomerOrder.aggregate([{ $match: { ...matchBase, createdAt: { $gte: today } } }, { $group: { _id: null, revenue: { $sum: '$grandTotal' } } }]),
    CustomerOrder.aggregate([{ $match: { ...matchBase, createdAt: { $gte: weekStart, $lt: today } } }, { $group: { _id: null, revenue: { $sum: '$grandTotal' } } }]),
  ]);
  const todayRevenue = Number(todayAgg[0]?.revenue || 0);
  const avgDaily = Number(weekAgg[0]?.revenue || 0) / 7;
  if (todayRevenue < thresholds.salesSpikeMinRevenue || avgDaily <= 0 || todayRevenue < avgDaily * thresholds.salesSpikeMultiplier) return;
  await createAlert({
    restaurantId,
    branchId,
    type: 'unusual_sales_spike',
    severity: 'medium',
    title: 'Unusual sales spike',
    message: `Today sales ${todayRevenue.toFixed(2)} are unusually higher than the 7-day average ${avgDaily.toFixed(2)}.`,
    resourceType: 'sales',
    evidence: { todayRevenue, avgDaily, multiplier: todayRevenue / avgDaily },
    dedupeKey: `sales-spike:${restaurantId}:${branchId || 'all'}:${today.toISOString().slice(0, 10)}`,
  });
}

async function detectPayrollRisk(audit) {
  if (!['payroll_delete', 'payroll_paid', 'payroll_update'].includes(audit.action)) return;
  const restaurantId = audit.details?.restaurantId;
  const actor = audit.user;
  const recent = await AuditLog.countDocuments({
    user: actor,
    action: { $in: ['payroll_delete', 'payroll_paid', 'payroll_update'] },
    timestamp: { $gte: hourAgo() },
  });
  if (audit.action === 'payroll_update' || audit.action === 'payroll_delete' || recent >= 3) {
    await createAlert({
      restaurantId,
      branchId: audit.details?.branchId,
      type: 'suspicious_payroll_edits',
      severity: audit.action === 'payroll_delete' ? 'high' : 'medium',
      title: 'Suspicious payroll activity',
      message: `${audit.action} was recorded. Recent payroll actions by actor: ${recent}.`,
      actor,
      actorModel: audit.userModel,
      resourceType: 'payroll',
      resourceId: audit.details?.payrollId,
      evidence: audit.details || {},
      dedupeKey: `payroll:${restaurantId}:${actor}:${audit.action}:${new Date().toISOString().slice(0, 13)}`,
    });
  }
}

async function detectFailedLogins(audit) {
  if (!['login_failed', 'branch_login_failed'].includes(audit.action)) return;
  const email = String(audit.details?.email || audit.details?.branchEmail || audit.details?.username || '').toLowerCase();
  const restaurantId = audit.details?.restaurantId;
  const windowStart = since(thresholds.failedLoginsMinutes);
  const query = {
    action: audit.action,
    timestamp: { $gte: windowStart },
    $or: [
      { ipAddress: audit.ipAddress },
      ...(email ? [{ 'details.email': email }, { 'details.branchEmail': email }, { 'details.username': email }] : []),
      ...(restaurantId ? [{ 'details.restaurantId': String(restaurantId) }] : []),
    ],
  };
  const count = await AuditLog.countDocuments(query);
  if (count < thresholds.failedLoginsWindow) return;

  const message = `${count} failed login attempts were detected within ${thresholds.failedLoginsMinutes} minutes.`;
  const alert = await createAlert({
    restaurantId,
    branchId: audit.details?.branchId,
    type: 'multiple_failed_login_attempts',
    severity: 'high',
    title: 'Multiple failed login attempts',
    message,
    actor: audit.user,
    actorModel: audit.userModel,
    resourceType: 'auth',
    evidence: { email, ipAddress: audit.ipAddress, count, action: audit.action },
    dedupeKey: `failed-login:${audit.action}:${email || audit.ipAddress}:${new Date().toISOString().slice(0, 13)}`,
    lockSubject: null,
  });

  const { applyLoginSecurityLocks } = require('./loginSecurityService');
  await applyLoginSecurityLocks({
    restaurantId: restaurantId || null,
    employeeId: audit.userModel === 'Employee' ? audit.user : null,
    ip: null,
    reason: message,
    lockMinutes: thresholds.lockMinutes,
    alertId: alert?._id,
  });
}

async function evaluateAuditLog(audit) {
  try {
    await Promise.all([detectFailedLogins(audit), detectPayrollRisk(audit)]);
  } catch (err) {
    console.warn('Fraud audit evaluation failed:', err.message);
  }
}

module.exports = {
  createAlert,
  detectRefundFraud,
  detectSuspiciousDiscount,
  detectDuplicateOrder,
  detectFailedPayments,
  detectSalesSpike,
  evaluateAuditLog,
};
