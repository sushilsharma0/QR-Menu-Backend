const rateLimit = require('express-rate-limit');

const isProduction = process.env.NODE_ENV === 'production';

function authIdentifier(req) {
  const body = req.body || {};
  const identifier = body.email || body.username || body.identifier || body.branchEmail || body.restaurantId || '';
  const role = body.role || req.query?.role || '';
  return String(`${role}:${identifier}`).trim().toLowerCase().slice(0, 160) || 'anonymous';
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX || (isProduction ? 8 : 50)),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${authIdentifier(req)}`,
  message: { success: false, message: 'Too many login attempts, please try again after 15 minutes' },
  skipSuccessfulRequests: true,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_MAX || (isProduction ? 100 : 1000)),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please slow down' }
});

const ipThrottleLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.IP_THROTTLE_LIMIT_MAX || (isProduction ? 180 : 1500)),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  message: { success: false, message: 'Too many requests from this IP' },
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method),
  message: { success: false, message: 'Too many write requests, please slow down' },
});

const strictLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many requests, please try again later' }
});

const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { success: false, message: 'Too many password reset attempts, please try again after 15 minutes' },
  skipSuccessfulRequests: false
});

module.exports = { authLimiter, apiLimiter, ipThrottleLimiter, writeLimiter, strictLimiter, passwordResetLimiter };
