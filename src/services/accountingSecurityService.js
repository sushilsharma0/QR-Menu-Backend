const bcrypt = require('bcryptjs');
const FinancialPeriodLock = require('../models/restaurant/FinancialPeriodLock');
const AccountingApproval = require('../models/restaurant/AccountingApproval');
const Restaurant = require('../models/restaurant/Restaurant');
const Employee = require('../models/restaurant/Employee');
const BranchAuth = require('../models/restaurant/BranchAuth');

const actorId = (req) => req.user?.employeeId || req.user?.id;
const actorModel = (req) => (
  req.user?.scope === 'branch_user' ? 'BranchAuth' : req.user?.scope === 'employee' ? 'Employee' : 'Restaurant'
);

function isManagerLike(req) {
  if (req.user?.scope === 'restaurant' && req.user?.role === 'restaurant') return true;
  if (req.user?.scope === 'branch_user' && ['branch_admin', 'branch_manager'].includes(req.user.role)) return true;
  return req.user?.scope === 'employee' && ['manager', 'admin', 'accountant'].includes(req.user.role);
}

async function assertPeriodOpen({ restaurantId, branchId, date }) {
  const d = date ? new Date(date) : new Date();
  const lock = await FinancialPeriodLock.findOne({
    restaurantId,
    isActive: true,
    periodStart: { $lte: d },
    periodEnd: { $gte: d },
    $or: [{ branchId: branchId || null }, { branchId: null }, { branchId: { $exists: false } }],
  }).lean();
  if (lock) {
    const err = new Error('This financial period is locked');
    err.statusCode = 423;
    throw err;
  }
}

async function verifyApproval(req, input = {}) {
  if (isManagerLike(req) && !input.password && !input.pin && !input.managerId) {
    return { approvedBy: actorId(req), approvedByModel: actorModel(req) };
  }
  const restaurantId = req.user?.restaurantId || req.user?.id;
  const password = input.password || input.managerPassword || input.approvalPassword;
  const managerId = input.managerId || input.approvedBy;

  if (req.user?.scope === 'restaurant') {
    const restaurant = await Restaurant.findById(req.user.id).select('+password');
    if (restaurant && password && await restaurant.comparePassword(password)) {
      return { approvedBy: req.user.id, approvedByModel: 'Restaurant' };
    }
  }

  if (req.user?.scope === 'branch_user' && ['branch_admin', 'branch_manager'].includes(req.user.role)) {
    const branchUser = await BranchAuth.findById(req.user.id).select('+passwordHash');
    if (branchUser && password && bcrypt.compareSync(password, branchUser.passwordHash)) {
      return { approvedBy: req.user.id, approvedByModel: 'BranchAuth' };
    }
  }

  const manager = managerId
    ? await Employee.findOne({ _id: managerId, restaurant: restaurantId, branchId: req.branchId, role: { $in: ['manager', 'admin', 'accountant'] }, isActive: true }).select('+password')
    : null;
  if (manager && password && await manager.comparePassword(password)) {
    return { approvedBy: manager._id, approvedByModel: 'Employee' };
  }

  const err = new Error('Manager/accountant approval is required');
  err.statusCode = 403;
  throw err;
}

async function createApproval(req, { action, resourceType, resourceId, approval = {}, metadata = {} }) {
  const approved = await verifyApproval(req, approval);
  return AccountingApproval.create({
    restaurantId: req.user?.restaurantId || req.user?.id,
    branchId: req.branchId || null,
    action,
    resourceType,
    resourceId,
    requestedBy: actorId(req),
    requestedByModel: actorModel(req),
    approvedBy: approved.approvedBy,
    approvedByModel: approved.approvedByModel,
    reason: approval.reason || '',
    metadata,
    status: 'approved',
  });
}

module.exports = {
  actorId,
  actorModel,
  assertPeriodOpen,
  createApproval,
};
