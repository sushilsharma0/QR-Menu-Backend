const QRCode = require('qrcode');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { generateRandomToken } = require('../utils/generateToken');
const {
  CLIENT_URL,
  JWT_ALGORITHM,
  QR_TOKEN_SECRET,
  QR_TOKEN_EXPIRES_IN,
  ALLOW_LEGACY_QR_TOKENS,
} = require('../config/env');

const hashToken = (token) =>
  crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');

const signCompactToken = (value) =>
  crypto
    .createHmac('sha256', QR_TOKEN_SECRET)
    .update(String(value), 'utf8')
    .digest('base64url')
    .slice(0, 22);

const addDays = (days) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
};

const parseDurationToDate = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  const match = raw.match(/^(\d+)\s*([smhd])$/);
  if (!match) return addDays(180);
  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  return new Date(Date.now() + amount * multipliers[unit]);
};

const parseExpiry = (decoded) => (decoded?.exp ? new Date(decoded.exp * 1000) : null);

const signCompactTableQrToken = ({ expiresIn = QR_TOKEN_EXPIRES_IN } = {}) => {
  const body = crypto.randomBytes(18).toString('base64url');
  const sig = signCompactToken(body);
  const token = `q1_${body}_${sig}`;
  return {
    token,
    tokenHash: hashToken(token),
    issuedAt: new Date(),
    expiresAt: parseDurationToDate(expiresIn),
  };
};

/** Parse `q1_<body>_<sig>` — body may contain `_` (base64url), so only split on the last `_`. */
const parseCompactTableQrToken = (token) => {
  const raw = String(token || '');
  if (!raw.startsWith('q1_')) return null;
  const rest = raw.slice(3);
  const lastUnderscore = rest.lastIndexOf('_');
  if (lastUnderscore <= 0) return null;
  const body = rest.slice(0, lastUnderscore);
  const sig = rest.slice(lastUnderscore + 1);
  if (!body || !sig) return null;
  return { body, sig };
};

const verifyCompactTableQrToken = (token) => {
  const parsed = parseCompactTableQrToken(token);
  if (!parsed) return false;
  const expected = signCompactToken(parsed.body);
  try {
    return crypto.timingSafeEqual(Buffer.from(parsed.sig), Buffer.from(expected));
  } catch {
    return false;
  }
};

const signTableQrToken = ({
  restaurantId,
  branchId,
  tableId,
  tableNumber,
  version = 1,
  expiresIn = QR_TOKEN_EXPIRES_IN,
}) => {
  if (!restaurantId || !tableId) {
    throw new Error('restaurantId and tableId are required to sign a table QR token');
  }

  const token = jwt.sign(
    {
      purpose: 'table_qr',
      rid: String(restaurantId),
      bid: branchId ? String(branchId) : null,
      tid: String(tableId),
      tableNumber: String(tableNumber || ''),
      ver: Number(version) || 1,
      nonce: crypto.randomBytes(24).toString('hex'),
    },
    QR_TOKEN_SECRET,
    {
      algorithm: JWT_ALGORITHM,
      expiresIn,
      issuer: 'mero-qr-api',
      audience: 'mero-qr-customer',
    }
  );

  const decoded = jwt.decode(token);
  return {
    token,
    tokenHash: hashToken(token),
    issuedAt: decoded?.iat ? new Date(decoded.iat * 1000) : new Date(),
    expiresAt: parseExpiry(decoded),
  };
};

const verifyTableQrToken = (token) => {
  const decoded = jwt.verify(token, QR_TOKEN_SECRET, {
    algorithms: [JWT_ALGORITHM],
    issuer: 'mero-qr-api',
    audience: 'mero-qr-customer',
  });

  if (decoded?.purpose !== 'table_qr' || !decoded.rid || !decoded.tid) {
    throw new Error('Invalid QR token purpose');
  }

  return decoded;
};

const resolveTableFromQrToken = async (token, { populateRestaurant = false } = {}) => {
  if (!token) return null;
  const Table = require('../models/restaurant/Table');
  let query = null;

  if (parseCompactTableQrToken(token)) {
    // Compact QR tokens are persisted only as hashes, so the DB hash is the
    // durable source of truth. Requiring the HMAC here would invalidate printed
    // QR codes whenever QR_TOKEN_SECRET changes.
    query = Table.findOne({
      qrTokenHash: hashToken(token),
      isActive: true,
      isDeleted: false,
    });
  } else {
    try {
      const decoded = verifyTableQrToken(token);
      query = Table.findOne({
        _id: decoded.tid,
        restaurant: decoded.rid,
        branchId: decoded.bid || null,
        qrTokenHash: hashToken(token),
        qrTokenVersion: Number(decoded.ver) || 1,
        isActive: true,
        isDeleted: false,
      });
    } catch (err) {
      if (!ALLOW_LEGACY_QR_TOKENS) return null;
      query = Table.findOne({
        qrToken: token,
        isActive: true,
        isDeleted: false,
      });
    }
  }

  if (populateRestaurant) {
    require('../models/restaurant/Restaurant');
    query = query.populate('restaurant', 'name slug logo favicon backgroundPhoto brandBackgroundImage settings isActive');
  }

  const table = await query;
  if (!table) return null;
  if (table.qrExpiresAt && table.qrExpiresAt < new Date()) return null;
  return table;
};

const generateTableQR = async (input, legacyTableNumber = null, baseUrl = null) => {
  const options = typeof input === 'object'
    ? input
    : {
        restaurantSlug: input,
        tableNumber: legacyTableNumber,
        baseUrl,
      };

  const url = options.baseUrl || CLIENT_URL || 'http://localhost:3000';
  const signed = options.restaurantId && options.tableId
    ? signCompactTableQrToken(options)
    : {
        token: generateRandomToken(32),
        tokenHash: null,
        issuedAt: new Date(),
        expiresAt: null,
      };
  const token = signed.token;
  const qrData = `${url}/home/${options.restaurantSlug}/${encodeURIComponent(token)}`;
  
  const qrCode = await QRCode.toDataURL(qrData, {
    width: 300,
    margin: 2,
    errorCorrectionLevel: 'H',
    color: { dark: '#000000', light: '#ffffff' }
  });
  
  return {
    qrCode,
    qrToken: token,
    qrTokenHash: signed.tokenHash,
    qrIssuedAt: signed.issuedAt,
    qrExpiresAt: signed.expiresAt,
    qrUrl: qrData,
  };
};

const generateOrderQR = async (orderId, orderNumber, baseUrl = null) => {
  const token = generateRandomToken(32);
  const url = baseUrl || process.env.CLIENT_URL || 'http://localhost:3000';
  const qrData = `${url}/track-order/${token}`;
  
  const qrCode = await QRCode.toDataURL(qrData, {
    width: 200,
    margin: 1,
    errorCorrectionLevel: 'H'
  });
  
  return { qrCode, qrToken: token, qrUrl: qrData };
};

module.exports = {
  generateTableQR,
  generateOrderQR,
  hashToken,
  verifyTableQrToken,
  resolveTableFromQrToken,
};
