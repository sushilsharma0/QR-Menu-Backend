const mongoose = require('mongoose');
const resolveRestaurantId = require('../middleware/restaurant/resolveRestaurantId');

const toObjectId = (value) => {
  if (!value) return value;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (!mongoose.Types.ObjectId.isValid(String(value))) return value;
  return new mongoose.Types.ObjectId(String(value));
};

const requireRestaurantId = (req) => {
  const restaurantId = resolveRestaurantId(req) || req.restaurantId;
  if (!restaurantId) {
    const err = new Error('Tenant restaurant could not be resolved');
    err.statusCode = 403;
    throw err;
  }
  return toObjectId(restaurantId);
};

const requireBranchId = (req) => {
  if (!req.branchId) {
    const err = new Error('Tenant branch could not be resolved');
    err.statusCode = 403;
    throw err;
  }
  return toObjectId(req.branchId);
};

const tenantScope = (req, options = {}) => {
  const {
    restaurantField = 'restaurantId',
    branchField = 'branchId',
    includeBranch = true,
  } = options;
  const scope = { [restaurantField]: requireRestaurantId(req) };
  if (includeBranch) scope[branchField] = requireBranchId(req);
  return scope;
};

const legacyRestaurantScope = (req, options = {}) =>
  tenantScope(req, { restaurantField: 'restaurant', ...options });

const withId = (req, id, options = {}) => ({
  _id: id,
  ...tenantScope(req, options),
});

const withLegacyId = (req, id, options = {}) => ({
  _id: id,
  ...legacyRestaurantScope(req, options),
});

const assertSameBranch = (req, doc) => {
  if (!doc) return false;
  const expected = String(requireBranchId(req));
  const actual = String(doc.branchId || '');
  return expected === actual;
};

module.exports = {
  toObjectId,
  requireRestaurantId,
  requireBranchId,
  tenantScope,
  legacyRestaurantScope,
  withId,
  withLegacyId,
  assertSameBranch,
};
