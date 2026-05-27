const nodemailer = require('nodemailer');
const dns = require('dns');
const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE } = require('./env');
const { logger } = require('../utils/logger');

let transporter = null;

if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

function lookupIpv4Only(hostname, options, callback) {
  return dns.lookup(hostname, { ...options, family: 4 }, callback);
}

if (SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE || SMTP_PORT === 465,
    family: 4,
    lookup: lookupIpv4Only,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { rejectUnauthorized: false }
  });
  
  transporter.verify((error, success) => {
    if (error) {
      logger.error('❌ Email transporter error:', error);
    } else {
      logger.info('✅ Email transporter ready');
    }
  });
} else {
  logger.warn('⚠️ Email not configured. Set SMTP_USER and SMTP_PASS in .env');
}

const sendEmail = async ({ to, subject, html, text }) => {
  if (!transporter) {
    logger.warn('Email not sent - no transporter configured');
    return { success: false, error: 'Email not configured' };
  }
  
  try {
    const info = await transporter.sendMail({
      from: (SMTP_FROM && String(SMTP_FROM).trim()) || SMTP_USER,
      to,
      subject,
      html,
      text: text || html?.replace(/<[^>]*>/g, '')
    });
    logger.info(`Email sent to ${to}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    logger.error('Email send error:', error.message);
    return { success: false, error: error.message };
  }
};

module.exports = { sendEmail, transporter };
