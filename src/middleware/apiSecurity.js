const crypto = require('crypto');
const { logger } = require('../utils/logger');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const parseAllowedOrigins = () => [
  process.env.CORS_ORIGIN,
  process.env.CLIENT_URL,
  process.env.ADMIN_URL,
  'file://',
  'null',
  ...((process.env.NODE_ENV || 'development') === 'production'
    ? []
    : [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:5173',
        'http://localhost:5174',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:5173',
      ]),
]
  .filter(Boolean)
  .flatMap((value) => String(value).split(','))
  .map((value) => value.trim())
  .filter((value) => value && value !== '*');

function getRequestId(req, res, next) {
  const incoming = String(req.get('X-Request-Id') || '').trim();
  req.requestId = incoming && incoming.length <= 120 ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

function securityRequestLogger(req, res, next) {
  const startedAt = Date.now();
  res.on('finish', () => {
    logger.http(
      `${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - startedAt}ms requestId=${req.requestId} ip=${req.ip}`
    );
  });
  next();
}

function validateJsonContentType(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const hasBody =
    Number(req.get('Content-Length') || 0) > 0 ||
    Boolean(req.get('Transfer-Encoding'));
  if (!hasBody) return next();
  if (!req.is('application/json') && !req.is('multipart/form-data') && !req.is('application/x-www-form-urlencoded')) {
    return res.status(415).json({
      success: false,
      message: 'Unsupported content type',
      requestId: req.requestId,
    });
  }
  return next();
}

function hasBlockedKey(value, depth = 0) {
  if (!value || typeof value !== 'object') return false;
  if (depth > 30) return true;
  if (Array.isArray(value)) return value.some((item) => hasBlockedKey(item, depth + 1));
  return Object.keys(value).some((key) => BLOCKED_KEYS.has(key) || hasBlockedKey(value[key], depth + 1));
}

function blockPrototypePollution(req, res, next) {
  if (hasBlockedKey(req.body) || hasBlockedKey(req.query) || hasBlockedKey(req.params)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid request payload',
      requestId: req.requestId,
    });
  }
  return next();
}

function csrfOriginProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.get('X-Desktop-App') === 'qr-menu-desktop') return next();

  const origin = req.get('Origin');
  const referer = req.get('Referer');
  const allowedOrigins = new Set(parseAllowedOrigins());
  const isBrowserRequest = Boolean(origin || referer || req.get('Sec-Fetch-Site'));

  if (!isBrowserRequest) return next();

  const requestOrigin = origin || (() => {
    try {
      return referer ? new URL(referer).origin : '';
    } catch {
      return '';
    }
  })();

  if (requestOrigin && allowedOrigins.has(requestOrigin)) return next();

  return res.status(403).json({
    success: false,
    message: 'CSRF origin check failed',
    requestId: req.requestId,
  });
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function apiSignatureValidation(req, res, next) {
  const secret = process.env.API_SIGNATURE_SECRET;
  const requireSignature = String(process.env.REQUIRE_API_SIGNATURE || '').toLowerCase() === 'true';
  const signature = req.get('X-API-Signature');
  const timestamp = req.get('X-API-Timestamp');

  if (!secret) return next();
  if (!signature && !requireSignature) return next();
  if (!signature || !timestamp) {
    return res.status(401).json({ success: false, message: 'API signature required', requestId: req.requestId });
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
    return res.status(401).json({ success: false, message: 'API signature timestamp invalid', requestId: req.requestId });
  }

  const body = req.rawBody || '';
  const canonical = `${req.method.toUpperCase()}\n${req.originalUrl}\n${timestamp}\n${body}`;
  const expected = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
  if (!timingSafeEqualString(signature, expected)) {
    return res.status(401).json({ success: false, message: 'API signature invalid', requestId: req.requestId });
  }
  return next();
}

function rawBodySaver(req, res, buf) {
  if (buf && buf.length) req.rawBody = buf.toString('utf8');
}

module.exports = {
  getRequestId,
  securityRequestLogger,
  validateJsonContentType,
  blockPrototypePollution,
  csrfOriginProtection,
  apiSignatureValidation,
  rawBodySaver,
};
