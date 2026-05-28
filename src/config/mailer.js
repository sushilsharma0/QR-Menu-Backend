const nodemailer = require('nodemailer');

const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM
} = require('./env');

const { logger } = require('../utils/logger');

let transporter = null;

/*
|--------------------------------------------------------------------------
| CREATE SMTP TRANSPORT
|--------------------------------------------------------------------------
*/

if (SMTP_USER && SMTP_PASS) {

  transporter = nodemailer.createTransport({

    host: SMTP_HOST,

    port: Number(SMTP_PORT),

    secure: false,

    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    },

    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 30000,

    tls: {
      rejectUnauthorized: false
    }
  });

  transporter.verify((error) => {

    if (error) {

      logger.error(
        '❌ Email transporter error: %s',
        error.stack || error.message
      );

    } else {

      logger.info('✅ Email transporter ready');
    }
  });

} else {

  logger.warn(
    '⚠️ Email not configured. Set SMTP credentials'
  );
}

/*
|--------------------------------------------------------------------------
| SEND EMAIL
|--------------------------------------------------------------------------
*/

const sendEmail = async ({
  to,
  subject,
  html,
  text
}) => {

  if (!transporter) {

    return {
      success: false,
      error: 'Email transporter not configured'
    };
  }

  try {

    const info = await transporter.sendMail({

      from: SMTP_FROM,

      to,

      subject,

      html,

      text:
        text ||
        (html
          ? html.replace(/<[^>]*>/g, '')
          : '')
    });

    logger.info(
      `✅ Email sent to ${to}`
    );

    return {
      success: true,
      messageId: info.messageId
    };

  } catch (error) {

    logger.error(
      '❌ Email send error: %s',
      error.stack || error.message
    );

    return {
      success: false,
      error: error.message
    };
  }
};

module.exports = {
  transporter,
  sendEmail
};
