const { SENSITIVE_KEYS, SANITIZE_ALLOWLIST } = require('../../constants/backupConstants');

function shouldRedactKey(key) {
  if (SANITIZE_ALLOWLIST.has(key)) return false;
  if (SENSITIVE_KEYS.has(key)) return true;
  return /password|secret|otp|session/i.test(key) && !SANITIZE_ALLOWLIST.has(key);
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (shouldRedactKey(key)) continue;
    out[key] = sanitize(item);
  }
  return out;
}

function collectMediaRefs(data) {
  const refs = [];
  const urlPattern = /cloudinary\.com|res\.cloudinary/i;
  const walk = (obj, pathPrefix = '') => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach((item, i) => walk(item, `${pathPrefix}[${i}]`));
      return;
    }
    for (const [key, val] of Object.entries(obj)) {
      const p = pathPrefix ? `${pathPrefix}.${key}` : key;
      if (typeof val === 'string' && urlPattern.test(val)) {
        refs.push({ path: p, url: val, type: key.includes('qr') ? 'qr' : key.includes('logo') ? 'logo' : 'image' });
      } else if (val && typeof val === 'object') walk(val, p);
    }
  };
  for (const [collection, rows] of Object.entries(data)) {
    const arr = Array.isArray(rows) ? rows : rows ? [rows] : [];
    arr.forEach((row, i) => walk(row, `${collection}[${i}]`));
  }
  return refs;
}

module.exports = { sanitize, collectMediaRefs, shouldRedactKey };
