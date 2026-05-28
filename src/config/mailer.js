const nodemailer = require('nodemailer');
const dns = require('dns');

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
| FORCE IPV4
|--------------------------------------------------------------------------
| Render sometimes tries IPv6 first and Gmail SMTP rejects it.
| This forces Node.js + Nodemailer to use IPv4 only.
|--------------------------------------------------------------------------
*/

if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

function lookupIpv4Only(hostname, options, callback) {

  dns.resolve4(hostname, (resolveError, addresses) => {

    if (resolveError || !addresses || !addresses.length) {

      return dns.lookup(
        hostname,
        {
          ...options,
          family: 4
        },
        callback
      );
    }

    if (options && options.all) {

      return callback(
        null,
        addresses.map((address) => ({
          address,
          family: 4
        }))
      );
    }

    return callback(null, addresses[0], 4);
  });
}

/*
|--------------------------------------------------------------------------
| CREATE SMTP TRANSPORT
|--------------------------------------------------------------------------
*/

if (SMTP_USER && SMTP_PASS) {

  transporter = nodemailer.createTransport({

    host: SMTP_HOST,

    port: Number(SMTP_PORT),

    // 465 = true
    // 587 = false
    secure: Number(SMTP_PORT) === 465,

    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    },

    /*
    |--------------------------------------------------------------------------
    | FORCE IPV4
    |--------------------------------------------------------------------------
    */

    family: 4,
    lookup: lookupIpv4Only,

    /*
    |--------------------------------------------------------------------------
    | TIMEOUTS
    |--------------------------------------------------------------------------
    */

    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 30000,

    /*
    |--------------------------------------------------------------------------
    | TLS
    |--------------------------------------------------------------------------
    */

    tls: {
      rejectUnauthorized: false,
      family: 4
    }
  });

  /*
  |--------------------------------------------------------------------------
  | VERIFY CONNECTION
  |--------------------------------------------------------------------------
  */

  transporter.verify((error, success) => {

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
    '⚠️ Email not configured. Set SMTP_USER and SMTP_PASS in .env'
  );
}

/*
|--------------------------------------------------------------------------
| SEND EMAIL FUNCTION
|--------------------------------------------------------------------------
*/

const sendEmail = async ({
  to,
  subject,
  html,
  text
}) => {

  if (!transporter) {

    logger.warn(
      '⚠️ Email not sent - transporter not configured'
    );

    return {
      success: false,
      error: 'Email transporter not configured'
    };
  }

  try {

    const info = await transporter.sendMail({

      from:
        (SMTP_FROM && String(SMTP_FROM).trim()) ||
        SMTP_USER,

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
      `✅ Email sent successfully to ${to}: ${info.messageId}`
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
