const asyncHandler = require('express-async-handler');
const Branch = require('../../models/restaurant/Branch');
const Restaurant = require('../../models/restaurant/Restaurant');
const { success, error } = require('../../utils/apiResponse');
const { mergeEnabledModules } = require('../../constants/branchModules');
const { readNumber, readObjectId, readSearchRegex, readString } = require('../../utils/inputValidation');

const listBranches = asyncHandler(async (req, res) => {
  const page = readNumber(req.query.page, { min: 1, max: 10000, integer: true, fallback: 1 });
  const limit = readNumber(req.query.limit, { min: 1, max: 100, integer: true, fallback: 20 });
  const filter = { isDeleted: false };
  const status = readString(req.query.status, { max: 32 });
  const restaurantId = readObjectId(req.query.restaurantId);
  const q = readSearchRegex(req.query.q);
  if (status) filter.status = status;
  if (restaurantId) filter.restaurantId = restaurantId;
  if (q) {
    filter.$or = [
      { name: q },
      { publicBranchId: q },
      { branchCode: q },
    ];
  }

  const [items, total] = await Promise.all([
    Branch.find(filter)
      .populate('restaurantId', 'name slug email status')
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Branch.countDocuments(filter),
  ]);

  const shaped = items.map((b) => ({
    ...b,
    enabledModules: mergeEnabledModules(b.enabledModules),
  }));

  return success(res, { items: shaped, pagination: { page, limit, total, pages: Math.ceil(total / limit) } }, 'OK');
});

const suspendBranch = asyncHandler(async (req, res) => {
  const branch = await Branch.findOne({ _id: req.params.id, isDeleted: false });
  if (!branch) return error(res, 'Branch not found', 404);
  branch.status = 'suspended';
  await branch.save();
  return success(res, branch, 'Branch suspended');
});

module.exports = { listBranches, suspendBranch };
