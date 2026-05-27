const asyncHandler = require('express-async-handler');
const FraudAlert = require('../../models/platform/FraudAlert');
const FraudLock = require('../../models/platform/FraudLock');
const { success, error } = require('../../utils/apiResponse');

const getFraudAlerts = asyncHandler(async (req, res) => {
  const {
    status = 'open',
    severity,
    type,
    restaurantId,
    page = 1,
    limit = 30,
  } = req.query;
  const query = {};
  if (status && status !== 'all') query.status = status;
  if (severity) query.severity = severity;
  if (type) query.type = type;
  if (restaurantId) query.restaurantId = restaurantId;

  const parsedPage = Math.max(1, parseInt(page, 10) || 1);
  const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const skip = (parsedPage - 1) * parsedLimit;

  const [alerts, total] = await Promise.all([
    FraudAlert.find(query)
      .populate('restaurantId', 'name email')
      .populate('branchId', 'name')
      .populate('actor', 'name username email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parsedLimit),
    FraudAlert.countDocuments(query),
  ]);

  return success(res, {
    alerts,
    pagination: {
      page: parsedPage,
      limit: parsedLimit,
      total,
      pages: Math.ceil(total / parsedLimit) || 1,
    },
  }, 'Fraud alerts retrieved');
});

const updateFraudAlert = asyncHandler(async (req, res) => {
  const { status, notes = '', assignedTo } = req.body;
  if (!['open', 'investigating', 'resolved', 'dismissed'].includes(status)) {
    return error(res, 'Invalid fraud alert status', 400);
  }

  const update = { status };
  if (status === 'investigating') {
    update['investigation.startedAt'] = new Date();
    update['investigation.assignedTo'] = assignedTo || req.user.id;
  }
  if (notes) update['investigation.notes'] = notes;

  const alert = await FraudAlert.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
  if (!alert) return error(res, 'Fraud alert not found', 404);

  if (['resolved', 'dismissed'].includes(status)) {
    await FraudLock.updateMany({ alert: alert._id }, { $set: { active: false } });
  }

  return success(res, alert, 'Fraud alert updated');
});

module.exports = { getFraudAlerts, updateFraudAlert };
