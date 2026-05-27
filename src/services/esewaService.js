const crypto = require('crypto');

const trimmed = (value, fallback = '') => {
  if (value === undefined || value === null) return fallback;
  return String(value).trim() || fallback;
};

const ESEWA_PAYMENT_URL = trimmed(
  process.env.ESEWA_PAYMENT_URL,
  'https://rc-epay.esewa.com.np/api/epay/main/v2/form',
);
const ESEWA_STATUS_URL = trimmed(
  process.env.ESEWA_STATUS_URL,
  'https://rc.esewa.com.np/api/epay/transaction/status/',
);

const getConfig = () => ({
  merchantId: trimmed(process.env.ESEWA_MERCHANT_ID, 'EPAYTEST'),
  secretKey: trimmed(
    process.env.ESEWA_SECRET_KEY,
    (process.env.NODE_ENV || 'development') === 'production' ? '' : '8gBm/:&EnhH.1/q',
  ),
  successUrl: trimmed(
    process.env.ESEWA_SUCCESS_URL,
    'https://qr-menu-frontend-navy.vercel.app/subscription/payment/esewa/success',
  ),
  failureUrl: trimmed(
    process.env.ESEWA_FAILURE_URL,
    'https://qr-menu-frontend-navy.vercel.app/subscription/payment/esewa/failure',
  ),
});

const requireSecretKey = () => {
  const config = getConfig();
  if (!config.secretKey) {
    const err = new Error('ESEWA_SECRET_KEY is required');
    err.statusCode = 500;
    throw err;
  }
  return config;
};

const formatAmount = (value) => {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error('Invalid eSewa amount');
  }
  return num.toFixed(2);
};

const sign = (message, secretKey) =>
  crypto.createHmac('sha256', secretKey).update(message).digest('base64');

const buildSignature = ({ totalAmount, transactionUuid, productCode }) => {
  const { secretKey } = requireSecretKey();
  return sign(
    `total_amount=${formatAmount(totalAmount)},transaction_uuid=${transactionUuid},product_code=${productCode}`,
    secretKey,
  );
};

const buildCancelToken = (transactionId) => {
  const { secretKey } = requireSecretKey();
  return sign(`cancel:${transactionId}`, secretKey);
};

const verifyCancelToken = (transactionId, token) => {
  if (!transactionId || !token) return false;
  try {
    const expected = buildCancelToken(transactionId);
    const expectedBuf = Buffer.from(expected);
    const tokenBuf = Buffer.from(String(token));
    if (expectedBuf.length !== tokenBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, tokenBuf);
  } catch {
    return false;
  }
};

const createPaymentPayload = ({ amount, transactionId }) => {
  if (!transactionId) {
    throw new Error('transactionId is required to create eSewa payload');
  }

  const { merchantId, successUrl, failureUrl } = getConfig();
  const totalAmount = formatAmount(amount);
  const cancelToken = buildCancelToken(transactionId);
  const failureUrlWithToken = `${failureUrl}${
    failureUrl.includes('?') ? '&' : '?'
  }transaction_uuid=${encodeURIComponent(transactionId)}&cancel_token=${encodeURIComponent(cancelToken)}`;

  const payload = {
    amount: totalAmount,
    tax_amount: '0',
    total_amount: totalAmount,
    transaction_uuid: transactionId,
    product_code: merchantId,
    product_service_charge: '0',
    product_delivery_charge: '0',
    success_url: successUrl,
    failure_url: failureUrlWithToken,
    signed_field_names: 'total_amount,transaction_uuid,product_code',
  };

  payload.signature = buildSignature({
    totalAmount,
    transactionUuid: transactionId,
    productCode: merchantId,
  });

  return {
    paymentUrl: ESEWA_PAYMENT_URL,
    method: 'POST',
    payload,
  };
};

const decodeCallbackData = (rawData) => {
  if (!rawData) return null;
  try {
    const decoded = Buffer.from(String(rawData), 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
};

const verifyCallbackSignature = (data) => {
  if (!data || typeof data !== 'object') return false;
  const { secretKey } = requireSecretKey();
  const signedFields = String(data.signed_field_names || '')
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);
  if (!signedFields.length || !data.signature) return false;

  const message = signedFields.map((field) => `${field}=${data[field]}`).join(',');
  const expected = sign(message, secretKey);
  try {
    const expectedBuf = Buffer.from(expected);
    const sigBuf = Buffer.from(String(data.signature));
    if (expectedBuf.length !== sigBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, sigBuf);
  } catch {
    return false;
  }
};

const verifyTransaction = async ({ transactionId, totalAmount }) => {
  if (!transactionId) {
    throw new Error('transactionId is required for eSewa status check');
  }
  const { merchantId } = getConfig();
  const url = new URL(ESEWA_STATUS_URL);
  url.searchParams.set('product_code', merchantId);
  url.searchParams.set('total_amount', formatAmount(totalAmount));
  url.searchParams.set('transaction_uuid', transactionId);

  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(body.message || 'eSewa transaction verification failed');
    err.gatewayData = body;
    err.statusCode = response.status >= 400 && response.status < 500 ? 400 : 502;
    throw err;
  }
  return body;
};

module.exports = {
  createPaymentPayload,
  decodeCallbackData,
  verifyCancelToken,
  verifyCallbackSignature,
  verifyTransaction,
};
