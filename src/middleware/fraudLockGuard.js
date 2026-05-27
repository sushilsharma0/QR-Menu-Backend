const FraudLock = require('../models/platform/FraudLock');

const activeLockQuery = (subjectType, subjectId) => ({
  subjectType,
  subjectId: String(subjectId || ''),
  active: true,
  lockedUntil: { $gt: new Date() },
});

async function fraudLockGuard(req, res, next) {
  try {
    const subjects = [];
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || '')
      .split(',')[0]
      .trim();
    const isPlatformStaff =
      req.user?.scope === 'platform' || req.user?.role === 'super_admin' || req.user?.role === 'admin';

    // Do not apply restaurant/IP brute-force locks to platform admin sessions (same office IP).
    if (ip && !isPlatformStaff) {
      subjects.push(activeLockQuery('ip', ip));
    }
    if (req.user?.scope === 'restaurant') subjects.push(activeLockQuery('Restaurant', req.user.id));
    if (req.user?.scope === 'employee') subjects.push(activeLockQuery('Employee', req.user.employeeId || req.user.id));
    if (req.user?.scope === 'branch_user') subjects.push(activeLockQuery('BranchAuth', req.user.id));
    if (!subjects.length) return next();

    const lock = await FraudLock.findOne({ $or: subjects }).lean();
    if (!lock) return next();
    return res.status(423).json({
      success: false,
      message: 'Account temporarily locked due to suspicious activity',
      lockedUntil: lock.lockedUntil,
      reason: lock.reason,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = fraudLockGuard;
