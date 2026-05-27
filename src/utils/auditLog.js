const AuditLog = require('../models/platform/AuditLog');

const resolveAuditActor = (user = {}) => {
  const isEmployee = user.scope === 'employee' || Boolean(user.employeeId);
  return {
    user: user.employeeId || user.id,
    userModel: isEmployee ? 'Employee' : 'Restaurant',
    role: user.role || (isEmployee ? 'employee' : 'restaurant'),
    name: user.name,
    restaurantId: String(user.restaurantId || user.id || ''),
  };
};

const writeAuditLog = async (req, { action, resource = 'system', resourceId, details = {} }) => {
  try {
    const actor = resolveAuditActor(req.user);
    if (!actor.user) return;

    await AuditLog.create({
      user: actor.user,
      userModel: actor.userModel,
      action,
      resource,
      resourceId,
      details: {
        ...details,
        restaurantId: details.restaurantId || actor.restaurantId,
        actorRole: actor.role,
        actorName: actor.name,
      },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });
  } catch (err) {
    console.warn('Audit log write failed:', err.message);
  }
};

module.exports = {
  resolveAuditActor,
  writeAuditLog,
};
