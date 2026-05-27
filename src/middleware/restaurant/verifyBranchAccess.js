const Branch = require('../../models/restaurant/Branch');
const { ensureDefaultBranch, normalizeObjectId } = require('../../services/branchService');
const { mergeEnabledModules } = require('../../constants/branchModules');
const { validateBranchSession, touchBranchSession } = require('../../services/branchAuthService');
const { error } = require('../../utils/apiResponse');

function requestedBranchId(req) {
  return req.headers['x-branch-id'] || req.query.branchId || req.body?.branchId || req.params.branchId;
}

async function verifyBranchAccess(req, res, next) {
  const restaurantId = normalizeObjectId(
    req.user?.scope === 'branch_user' ? req.user.restaurantId : req.user?.restaurantId || req.user?.id,
  );
  if (!restaurantId) return error(res, 'Unable to resolve restaurant for branch access', 403);

  if (req.user?.scope === 'branch_user') {
    const branchSessionScope = {
      restaurantId: req.user.restaurantId,
      branchId: req.user.branchId,
      branchAuthId: req.user.id,
    };
    const sess = await validateBranchSession(req.user.sessionId, branchSessionScope);
    if (!sess) {
      return error(res, 'Session expired or revoked', 401, { code: 'BRANCH_SESSION_INVALID' });
    }
    touchBranchSession(req.user.sessionId, branchSessionScope).catch(() => {});
  }

  let branchId = requestedBranchId(req);
  if (req.user?.scope === 'employee') {
    branchId = req.user.branchId || branchId;
  }
  if (req.user?.scope === 'branch_user') {
    branchId = req.user.branchId;
  }

  let branch = branchId
    ? await Branch.findOne({ _id: normalizeObjectId(branchId), restaurantId, isDeleted: false })
    : await ensureDefaultBranch(restaurantId);

  if (!branch) return error(res, 'Branch not found', 404);
  if (branch.status !== 'active') return error(res, `Branch is ${branch.status}`, 403, { code: 'BRANCH_INACTIVE' });

  if (req.user?.scope === 'employee') {
    const assigned = req.user.branchId ? String(req.user.branchId) : null;
    if (assigned && assigned !== String(branch._id)) {
      return error(res, 'You do not have access to this branch', 403, { code: 'BRANCH_ACCESS_DENIED' });
    }
  }

  if (req.user?.scope === 'branch_user' && String(branch._id) !== String(req.user.branchId)) {
    return error(res, 'You do not have access to this branch', 403, { code: 'BRANCH_ACCESS_DENIED' });
  }

  const plain = branch.toObject ? branch.toObject() : branch;
  plain.enabledModules = mergeEnabledModules(branch.enabledModules);
  req.restaurantId = restaurantId;
  req.branch = plain;
  req.branchId = branch._id;
  return next();
}

module.exports = verifyBranchAccess;
