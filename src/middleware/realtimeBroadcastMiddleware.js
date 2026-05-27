const {
  emitRestaurantDataChanged,
  emitBranchDataChanged,
  emitPlatformDataChanged,
  resolveRestaurantIdFromRequest,
  resolveBranchIdFromRequest,
  resolveTopicsFromPath,
  shouldSkipRealtimeBroadcast,
} = require('../services/realtimeBroadcastService');

function isSuccessfulResponse(statusCode, body) {
  if (statusCode < 200 || statusCode >= 300) return false;
  if (body && typeof body === 'object' && body.success === false) return false;
  return true;
}

function realtimeBroadcastMiddleware(req, res, next) {
  const originalJson = res.json.bind(res);

  res.json = function realtimeJson(body) {
    const result = originalJson(body);

    if (!shouldSkipRealtimeBroadcast(req.originalUrl || req.path)) {
      const method = req.method;
      const topics = resolveTopicsFromPath(req.originalUrl || req.path, method);

      if (topics.length && isSuccessfulResponse(res.statusCode, body)) {
        const path = req.originalUrl || req.path || '';

        setImmediate(() => {
          const restaurantId = resolveRestaurantIdFromRequest(req);
          const branchId = resolveBranchIdFromRequest(req);

          if (restaurantId) {
            emitRestaurantDataChanged(restaurantId, topics, {
              method,
              path,
            }).catch(() => undefined);
          }

          if (branchId) {
            emitBranchDataChanged(branchId, topics, { method, path });
          }

          if (path.startsWith('/api/platform')) {
            emitPlatformDataChanged(topics, { method, path, source: 'platform' });
          }
        });
      }
    }

    return result;
  };

  next();
}

module.exports = realtimeBroadcastMiddleware;
