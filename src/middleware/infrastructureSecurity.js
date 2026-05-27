const { logger } = require('../utils/logger');

const isProduction = () => (process.env.NODE_ENV || 'development') === 'production';

function parseList(value = '') {
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeIp(ip = '') {
  return String(ip).replace(/^::ffff:/, '').trim();
}

function ipMatches(ip, rule) {
  if (!rule) return false;
  const cleanIp = normalizeIp(ip);
  if (rule === cleanIp) return true;
  if (rule.endsWith('*')) return cleanIp.startsWith(rule.slice(0, -1));
  if (rule.includes('/')) {
    // Lightweight prefix support for common private VPN CIDR notation.
    const [base, bitsRaw] = rule.split('/');
    const bits = Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 8 || bits > 32) return false;
    const baseParts = base.split('.').map(Number);
    const ipParts = cleanIp.split('.').map(Number);
    if (baseParts.length !== 4 || ipParts.length !== 4) return false;
    const fullOctets = Math.floor(bits / 8);
    return baseParts.slice(0, fullOctets).every((part, idx) => part === ipParts[idx]);
  }
  return false;
}

function enforceHttps(req, res, next) {
  if (!isProduction()) return next();
  if (String(process.env.ENFORCE_HTTPS || 'true').toLowerCase() === 'false') return next();
  if (req.secure || req.get('x-forwarded-proto') === 'https') return next();
  if (req.method === 'GET' || req.method === 'HEAD') {
    const host = req.get('host');
    if (host) return res.redirect(308, `https://${host}${req.originalUrl}`);
  }
  return res.status(426).json({
    success: false,
    message: 'HTTPS is required',
    timestamp: new Date().toISOString(),
  });
}

function secureCookieDefaults(req, res, next) {
  const originalCookie = res.cookie.bind(res);
  res.cookie = (name, value, options = {}) => {
    const secureDefaults = isProduction()
      ? {
          httpOnly: true,
          secure: true,
          sameSite: 'strict',
        }
      : {
          httpOnly: options.httpOnly !== false,
          sameSite: options.sameSite || 'lax',
        };
    return originalCookie(name, value, { ...secureDefaults, ...options });
  };
  next();
}

function superadminVpnRestriction(req, res, next) {
  if (!req.path.startsWith('/api/platform')) return next();
  const allowlist = parseList(process.env.SUPERADMIN_IP_ALLOWLIST || process.env.ADMIN_VPN_IP_ALLOWLIST || '');
  const enforce = String(process.env.ENFORCE_SUPERADMIN_VPN || (isProduction() ? 'true' : 'false')).toLowerCase() === 'true';
  if (!enforce) return next();
  if (!allowlist.length) {
    logger.error('SUPERADMIN_IP_ALLOWLIST is empty while superadmin VPN restriction is enforced');
    return res.status(503).json({
      success: false,
      message: 'Superadmin access is locked until VPN allowlist is configured',
      timestamp: new Date().toISOString(),
    });
  }
  const requestIps = [
    normalizeIp(req.ip),
    ...parseList(req.get('x-forwarded-for')).map(normalizeIp),
    normalizeIp(req.socket?.remoteAddress),
  ].filter(Boolean);
  const allowed = requestIps.some((ip) => allowlist.some((rule) => ipMatches(ip, rule)));
  if (allowed) return next();
  logger.warn('Blocked platform access from non-VPN IP: %s path=%s', req.ip, req.originalUrl);
  return res.status(403).json({
    success: false,
    message: 'Platform access requires the approved VPN/network',
    timestamp: new Date().toISOString(),
  });
}

function infrastructureSecurityHeaders(req, res, next) {
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self), payment=(self)');
  if (req.path.includes('/backup/download')) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Download-Options', 'noopen');
  }
  next();
}

module.exports = {
  enforceHttps,
  secureCookieDefaults,
  superadminVpnRestriction,
  infrastructureSecurityHeaders,
  normalizeIp,
};
