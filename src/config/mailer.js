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

if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

function lookupIpv4Only(hostname, options, callback) {
  return dns.resolve4(hostname, (resolveError, addresses) => {
    if (resolveError || !addresses?.length) {
      return dns.lookup(hostname, { ...options, family: 4 }, callback);
    }

    if (options?.all) {
      return callback(null, addresses.map((address) => ({
        address,
        family: 4
      })));
    }

    return callback(null, addresses[0], 4);
  });
}

if (SMTP_USER && SMTP_PASS) {

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),

    // IMPORTANT FIX
    secure: Number(SMTP_PORT) === 465,

    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    },

    family: 4,
    lookup: lookupIpv4Only,

    connectionTimeout: 20000,
    greetingTimeout: 20000,
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
    '⚠️ Email not configured. Set SMTP_USER and SMTP_PASS'
  );
}
