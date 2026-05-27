const twilio = require('twilio');

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  SMS_ENABLED,
} = process.env;

const smsConfigured = Boolean(
  TWILIO_ACCOUNT_SID &&
    TWILIO_AUTH_TOKEN &&
    TWILIO_FROM_NUMBER &&
    String(SMS_ENABLED || '').toLowerCase() !== 'false',
);

let client = null;

const getClient = () => {
  if (!smsConfigured) return null;
  if (!client) client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  return client;
};

async function sendSms(to, body) {
  const phone = String(to || '').trim();
  const text = String(body || '').trim();
  if (!phone || !text) return { sent: false, skipped: true, reason: 'missing_phone_or_body' };

  const smsClient = getClient();
  if (!smsClient) return { sent: false, skipped: true, reason: 'sms_not_configured' };

  const message = await smsClient.messages.create({
    to: phone,
    from: TWILIO_FROM_NUMBER,
    body: text,
  });

  return { sent: true, sid: message.sid };
}

async function sendOrderReceivedSms({ phone, restaurantName, orderNumber, editMinutes = 5 }) {
  return sendSms(
    phone,
    `Your order ${orderNumber} at ${restaurantName || 'the restaurant'} was received. Please check all items. You can edit it for ${editMinutes} minutes before preparation starts.`,
  );
}

async function sendOrderReadySms({ phone, restaurantName, orderNumber }) {
  return sendSms(
    phone,
    `Good news! Order ${orderNumber} at ${restaurantName || 'the restaurant'} is ready. Please collect it when convenient.`,
  );
}

module.exports = {
  sendSms,
  sendOrderReceivedSms,
  sendOrderReadySms,
};

