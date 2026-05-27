const asyncHandler = require('express-async-handler');
const AuditLog = require('../../models/platform/AuditLog');
const { success } = require('../../utils/apiResponse');

const failedActionQuery = [
  { action: { $in: ['login_failed', 'branch_login_failed', 'validation_failed', 'forbidden_action', 'request_rejected'] } },
  { action: /failed|rejected|forbidden/i }
];
const operationActions = [
  'order_status_update',
  'order_cancelled',
  'payment_received',
  'payment_refunded',
  'pos_order_created',
  'pos_payment',
  'pos_refund',
  'pos_shift_open',
  'pos_shift_close',
  'order_credit_linked'
];

const getEmployeeActivityLogs = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    action,
    status
  } = req.query;

  const restaurantId = String(req.user.id);
  const query = {
    userModel: { $in: ['Employee', 'Restaurant'] },
    'details.restaurantId': restaurantId
  };

  if (status === 'failed') {
    query.$or = failedActionQuery;
  } else if (status === 'success') {
    query.$nor = failedActionQuery;
  } else if (status === 'operation') {
    query.action = { $in: operationActions };
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
  }, 'Employee activity logs retrieved');
});

module.exports = {
  getEmployeeActivityLogs
};
