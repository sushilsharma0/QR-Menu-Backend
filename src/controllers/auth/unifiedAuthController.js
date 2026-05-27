const asyncHandler = require('express-async-handler');
const Platform = require('../../models/platform/Platform');
const { error } = require('../../utils/apiResponse');
const platformAuth = require('../platform/authController');
const restaurantAuth = require('../restaurant/authController');
const employeeController = require('../restaurant/employeeController');
const branchAuthController = require('../restaurant/branchAuthController');

/**
 * Single entry login: branch (*@branch.com + restaurant id), employee (username + restaurant id),
 * platform admin (email), restaurant vendor (email).
 * @route POST /api/auth/login
 */
const unifiedLogin = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const identifier = String(body.identifier || body.email || body.username || '').trim();
  const password = body.password;
  const restaurantId = body.restaurantId != null ? String(body.restaurantId).trim() : '';

  if (!identifier || !password) {
    return error(res, 'Identifier and password are required', 400);
  }

  const lower = identifier.toLowerCase();

  if (lower.includes('@branch.com')) {
    req.body = { branchEmail: lower, restaurantId, password };
    return branchAuthController.branchEmailLogin(req, res);
  }

  if (restaurantId && !lower.includes('@')) {
    req.body = { username: identifier, password, restaurantId };
    return employeeController.employeeLogin(req, res);
  }

  if (!lower.includes('@')) {
    return error(
      res,
      'Use a valid email for vendor or platform login, *@branch.com with Restaurant ID for a branch, or staff username with Restaurant ID.',
      400,
      { code: 'LOGIN_IDENTIFIER_INVALID' },
    );
  }

  const platformAdmin = await Platform.findOne({ email: lower, isActive: true }).select('_id');
  if (platformAdmin) {
    req.body = { email: lower, password };
    return platformAuth.login(req, res);
  }

  req.body = { email: identifier, password };
  return restaurantAuth.login(req, res);
});

module.exports = { unifiedLogin };
