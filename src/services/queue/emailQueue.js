const nodemailer = require('nodemailer');
const dns = require('dns');
const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE } = require('../../config/env');

let transporter = null;

if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

if (SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT || 587,
    secure: SMTP_SECURE || Number(SMTP_PORT) === 465,
    family: 4,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { rejectUnauthorized: false },
  });
  console.log('✅ Email transporter initialized');
}

class EmailQueue {
  async sendEmail(to, subject, html) {
    if (!transporter) {
      console.log('📧 Email not sent - no transporter configured');
      return { success: false };
    }
    try {
      const info = await transporter.sendMail({
        from: (SMTP_FROM && String(SMTP_FROM).trim()) || SMTP_USER,
        to,
        subject,
        html,
      });
      console.log(`📧 Email sent to ${to}`);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('Email error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async sendKYCStatusEmail(email, restaurantName, status, reason = null) {
    return this.sendEmail(email, `KYC ${status}`, `<h2>KYC ${status}</h2><p>Restaurant: ${restaurantName}</p>${reason ? `<p>Reason: ${reason}</p>` : ''}`);
  }

  async sendPackageApprovalEmail(email, restaurantName, packageName, expiryDate) {
    return this.sendEmail(email, 'Package Approved', `<h2>Package Approved</h2><p>${restaurantName}, your ${packageName} package is active</p>`);
  }

  async sendPackageRejectionEmail(email, restaurantName, reason) {
    return this.sendEmail(email, 'Package Request Update', `<h2>Package Request</h2><p>${restaurantName}, your request was not approved.</p><p>Reason: ${reason}</p>`);
  }

  async close() {
    // Nothing to close
  }
}

module.exports = new EmailQueue();
