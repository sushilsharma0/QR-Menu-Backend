const crypto = require('crypto');
const path = require('path');

const secret = () => process.env.FILE_ACCESS_SECRET || process.env.JWT_SECRET || 'development-file-access-secret';

function signFilePath(relativePath, { expiresInSeconds = 60 * 60 * 24 * 7 } = {}) {
  const cleanPath = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const payload = Buffer.from(JSON.stringify({ p: cleanPath, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyFileToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!parsed?.p || !parsed?.exp || parsed.exp < Math.floor(Date.now() / 1000)) return null;
  const normalized = path.posix.normalize(String(parsed.p).replace(/\\/g, '/'));
  if (normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return null;
  return normalized;
}

function buildSignedFileUrl(req, relativePath) {
  const ttl = Number(process.env.FILE_URL_TTL_SECONDS || 60 * 60 * 24 * 365);
  const token = signFilePath(relativePath, { expiresInSeconds: ttl });
  const base = `${req.protocol}://${req.get('host')}`;
  return `${base}/api/files/${encodeURIComponent(token)}`;
}

module.exports = { signFilePath, verifyFileToken, buildSignedFileUrl };
