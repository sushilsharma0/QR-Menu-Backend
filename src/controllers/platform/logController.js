const asyncHandler = require('express-async-handler');
const AuditLog = require('../../models/platform/AuditLog');
const { success } = require('../../utils/apiResponse');

const failedActionQuery = [
  { action: { $in: ['login_failed', 'branch_login_failed', 'validation_failed', 'forbidden_action', 'request_rejected'] } },
  { action: /failed|rejected|forbidden/i }
];

const getRestaurantActivityLogs = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    action,
    restaurantId,
    status
  } = req.query;

  const query = {
    userModel: { $in: ['Restaurant', 'Employee'] }
  };

  if (restaurantId) {
    query['details.restaurantId'] = restaurantId;
  }

  if (status === 'failed') {
    query.$or = failedActionQuery;
  } else if (status === 'success') {
    query.$nor = failedActionQuery;
  }

  if (action) {
    query.action = action;
    delete query.$or;
    delete query.$nor;
  }

  const parsedPage = Math.max(parseInt(page, 10) || 1, 1);
  const parsedLimit = Math.max(parseInt(limit, 10) || 20, 1);
  const skip = (parsedPage - 1) * parsedLimit;

  const [logs, total] = await Promise.all([
    AuditLog.find(query)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(parsedLimit)
      .populate('user', 'name email username role')
      .lean(),
    AuditLog.countDocuments(query)
  ]);

  return success(res, {
    logs,
    pagination: {
      page: parsedPage,
      limit: parsedLimit,
      total,
      pages: Math.ceil(total / parsedLimit)
    }
  }, 'Restaurant activity logs retrieved');
});

module.exports = {
  getRestaurantActivityLogs
};
