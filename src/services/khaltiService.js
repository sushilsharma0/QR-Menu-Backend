const trimmed = (value, fallback = '') => {
  if (value === undefined || value === null) return fallback;
  return String(value).trim() || fallback;
};

const KHALTI_BASE_URL = trimmed(process.env.KHALTI_BASE_URL, 'https://dev.khalti.com/api/v2');

const getConfig = () => ({
  secretKey: trimmed(process.env.KHALTI_SECRET_KEY),
  publicKey: trimmed(process.env.KHALTI_PUBLIC_KEY),
  returnUrl: trimmed(
    process.env.KHALTI_RETURN_URL,
    'https://qr-menu-frontend-navy.vercel.app/subscription/payment/khalti/callback',
  ),
  websiteUrl: trimmed(process.env.KHALTI_WEBSITE_URL, 'https://qr-menu-frontend-navy.vercel.app'),
});

const toPaisa = (amount) => {
  const num = Number(amount);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error('Invalid Khalti amount');
  }
  return Math.round(num * 100);
};

const requestKhalti = async (path, payload) => {
  const { secretKey } = getConfig();
  if (!secretKey) {
    const err = new Error('Khalti is not configured. Please set KHALTI_SECRET_KEY in the server .env');
    err.statusCode = 500;
    throw err;
  }

  let response;
  try {
    response = await fetch(`${KHALTI_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (networkErr) {
    const err = new Error(`Khalti gateway unreachable: ${networkErr.message}`);
    err.statusCode = 502;
    throw err;
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail =
      body.detail ||
      body.message ||
      (body.error_key ? `Khalti error: ${body.error_key}` : null) ||
      'Khalti gateway request failed';
    const err = new Error(detail);
    err.gatewayData = body;
    err.statusCode = response.status >= 400 && response.status < 500 ? 400 : 502;
    throw err;
  }
  return body;
};

const initiatePayment = async ({ amount, transactionId, planName, restaurant }) => {
  if (!transactionId) {
    throw new Error('transactionId is required to initiate Khalti payment');
  }
  if (!restaurant) {
    throw new Error('restaurant is required to initiate Khalti payment');
  }

  const { returnUrl, websiteUrl, publicKey } = getConfig();
  const payload = {
    return_url: returnUrl,
    website_url: websiteUrl,
    amount: toPaisa(amount),
    purchase_order_id: transactionId,
    purchase_order_name: planName || 'Subscription plan',
    customer_info: {
      name: restaurant.name || 'Restaurant',
      email: restaurant.email || undefined,
      phone: restaurant.phone || undefined,
    },
  };

  const data = await requestKhalti('/epayment/initiate/', payload);
  if (!data.payment_url) {
    const err = new Error('Khalti did not return a payment URL');
    err.gatewayData = data;
    err.statusCode = 502;
    throw err;
  }

  return {
    ...data,
    publicKey,
    payload,
  };
};

const lookupPayment = async (pidx) => {
  if (!pidx) {
    const err = new Error('pidx is required for Khalti lookup');
    err.statusCode = 400;
    throw err;
  }
  return requestKhalti('/epayment/lookup/', { pidx });
};

module.exports = {
  initiatePayment,
  lookupPayment,
  toPaisa,
};
