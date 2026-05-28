const SibApiV3Sdk = require('sib-api-v3-sdk');
const { logger } = require('../utils/logger');

const {
  BREVO_API_KEY,
  BREVO_SENDER_EMAIL,
  BREVO_SENDER_NAME
} = require('./env');

/* ---------------------------
   INIT BREVO CLIENT
---------------------------- */

const client = SibApiV3Sdk.ApiClient.instance;
client.authentications['api-key'].apiKey = BREVO_API_KEY;

const emailApi = new SibApiV3Sdk.TransactionalEmailsApi();

/* ---------------------------
   SEND EMAIL FUNCTION
---------------------------- */

const sendEmail = async ({ to, subject, html, text }) => {
  if (!BREVO_API_KEY) {
    return {
      success: false,
      error: 'Brevo API key not configured'
    };
  }

  try {
    const response = await emailApi.sendTransacEmail({
      sender: {
        email: BREVO_SENDER_EMAIL,
        name: BREVO_SENDER_NAME || 'QRRESTRONEPAL'
      },
      to: [
        {
          email: to
        }
      ],
      subject,
      htmlContent: html,
      textContent: text || (html ? html.replace(/<[^>]*>/g, '') : '')
    });

    logger.info(`✅ Email sent to ${to}`);

    return {
      success: true,
      messageId: response.messageId
    };

  } catch (error) {
    logger.error(
      '❌ Brevo API email error: %s',
      error.response?.text || error.message
    );

    return {
      success: false,
      error: error.message
    };
  }
};

module.exports = {
  sendEmail
};