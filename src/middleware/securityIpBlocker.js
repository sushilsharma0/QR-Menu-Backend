const SecurityIpBlock = require('../models/platform/SecurityIpBlock');
const { logger } = require('../utils/logger');

const cache = new Map();
const CACHE_TTL_MS = 60 * 1000;

function normalizeIp(ip = '') {
  return String(ip).replace(/^::ffff:/, '').trim();
}

async function isBlocked(ipAddress) {
  const ip = normalizeIp(ipAddress);
  if (!ip) return false;
  const cached = cache.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.blocked;

  const now = new Date();
  const block = await SecurityIpBlock.findOne({
    ipAddress: ip,
    active: true,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  }).lean();
  const blocked = Boolean(block);
  cache.set(ip, { blocked, expiresAt: Date.now() + CACHE_TTL_MS });
  return blocked;
}

function clearIpBlockCache(ipAddress) {
  if (ipAddress) cache.delete(normalizeIp(ipAddress));
  else cache.clear();
}

async function securityIpBlocker(req, res, next) {
  try {
    if (await isBlocked(req.ip)) {
      return res.status(403).json({
        success: false,
        message: 'This IP address is blocked by security operations',
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    logger.warn('Security IP block check failed: %s', err.message);
  }
  return next();
}

module.exports = {
  securityIpBlocker,
  clearIpBlockCache,
  normalizeIp,
};
