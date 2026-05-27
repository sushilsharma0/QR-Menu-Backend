const { transporter: smtpTransport } = require('../config/mailer');
const { SMTP_FROM, APP_NAME, CLIENT_URL, SUPPORT_EMAIL, SMTP_USER, SMTP_PASS } = require('../config/env');
const { logger } = require('../utils/logger');

const BRAND = {
  primary: '#166534',
  primaryDark: '#14532d',
  accent: '#0f766e',
  ink: '#111827',
  muted: '#6b7280',
  line: '#e5e7eb',
  bg: '#f3f7f4',
  panel: '#ffffff',
};

const isEmailConfigured = () => Boolean(SMTP_USER && SMTP_PASS);

const escapeHtml = (value = '') => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const plainTextFromHtml = (html = '') => html
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const actionButton = (label, href, color = BRAND.primary) => `
  <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 28px 0 8px;">
    <tr>
      <td style="border-radius: 10px; background: ${color};">
        <a href="${href}" style="display: inline-block; padding: 14px 22px; color: #ffffff; font-size: 14px; font-weight: 700; text-decoration: none; border-radius: 10px;">
          ${escapeHtml(label)}
        </a>
      </td>
    </tr>
  </table>
`;

const codeBlock = (code, tone = 'green') => {
  const palette = tone === 'blue'
    ? { bg: '#eff6ff', border: '#bfdbfe', text: '#1d4ed8' }
    : { bg: '#ecfdf5', border: '#bbf7d0', text: '#166534' };

  return `
    <div style="margin: 24px 0; padding: 22px 16px; background: ${palette.bg}; border: 1px solid ${palette.border}; border-radius: 14px; text-align: center;">
      <div style="font-size: 13px; font-weight: 700; color: ${BRAND.muted}; text-transform: uppercase; letter-spacing: 2px;">Verification code</div>
      <div style="margin-top: 10px; font-size: 36px; line-height: 1; font-weight: 800; letter-spacing: 10px; color: ${palette.text}; font-family: Arial, sans-serif;">
        ${escapeHtml(code)}
      </div>
    </div>
  `;
};

const detailTable = (rows = []) => `
  <table role="presentation" cellspacing="0" cellpadding="0" style="width: 100%; margin: 22px 0; border: 1px solid ${BRAND.line}; border-radius: 12px; overflow: hidden; border-collapse: separate; border-spacing: 0;">
    ${rows.map(([label, value], index) => `
      <tr>
        <td style="width: 42%; padding: 13px 16px; background: #f9fafb; border-top: ${index === 0 ? '0' : `1px solid ${BRAND.line}`}; color: ${BRAND.muted}; font-size: 13px; font-weight: 700;">
          ${escapeHtml(label)}
        </td>
        <td style="padding: 13px 16px; border-top: ${index === 0 ? '0' : `1px solid ${BRAND.line}`}; color: ${BRAND.ink}; font-size: 14px; font-weight: 600;">
          ${escapeHtml(value)}
        </td>
      </tr>
    `).join('')}
  </table>
`;

const noteBox = (content, tone = 'neutral') => {
  const palette = tone === 'danger'
    ? { bg: '#fef2f2', border: '#fecaca', text: '#991b1b' }
    : tone === 'success'
      ? { bg: '#ecfdf5', border: '#bbf7d0', text: '#166534' }
      : { bg: '#f8fafc', border: '#e2e8f0', text: '#334155' };

  return `
    <div style="margin: 22px 0; padding: 16px; border-radius: 12px; background: ${palette.bg}; border: 1px solid ${palette.border}; color: ${palette.text}; font-size: 14px; line-height: 1.65;">
      ${content}
    </div>
  `;
};

const signature = () => `
  <div style="margin-top: 30px; padding-top: 22px; border-top: 1px solid ${BRAND.line};">
    <p style="margin: 0 0 12px; color: ${BRAND.ink}; font-size: 14px; line-height: 1.65;">
      Warm regards,<br>
      <strong style="color: ${BRAND.primary};">${escapeHtml(APP_NAME)} Platform Team</strong>
    </p>
    <div style="display: inline-block; padding: 10px 12px; border-radius: 10px; background: #f0fdf4; color: ${BRAND.primaryDark}; font-size: 12px; font-weight: 700; letter-spacing: .3px;">
      Smart QR menus, vendor operations, and dining workflows.
    </div>
  </div>
`;

const renderEmail = ({
  preheader,
  badge = 'Notification',
  title,
  intro,
  body = '',
  cta,
  tone = 'green',
}) => {
  const accent = tone === 'danger' ? '#dc2626' : tone === 'blue' ? '#2563eb' : BRAND.primary;
  const safeTitle = escapeHtml(title);

  return `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${safeTitle}</title>
      </head>
      <body style="margin: 0; padding: 0; background: ${BRAND.bg}; font-family: Arial, Helvetica, sans-serif; color: ${BRAND.ink};">
        <div style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: transparent;">
          ${escapeHtml(preheader || title)}
        </div>
        <table role="presentation" cellspacing="0" cellpadding="0" style="width: 100%; background: ${BRAND.bg}; padding: 28px 12px;">
          <tr>
            <td align="center">
              <table role="presentation" cellspacing="0" cellpadding="0" style="width: 100%; max-width: 640px;">
                <tr>
                  <td style="padding: 0 0 16px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" style="width: 100%;">
                      <tr>
                        <td>
                          <div style="font-size: 20px; font-weight: 800; color: ${BRAND.primaryDark}; letter-spacing: -.2px;">
                            ${escapeHtml(APP_NAME)}
                          </div>
                          <div style="margin-top: 4px; color: ${BRAND.muted}; font-size: 12px;">
                            Vendor and platform notification
                          </div>
                        </td>
                        <td align="right">
                          <span style="display: inline-block; padding: 8px 10px; border-radius: 999px; background: #ffffff; color: ${accent}; border: 1px solid ${BRAND.line}; font-size: 12px; font-weight: 800;">
                            ${escapeHtml(badge)}
                          </span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="background: ${BRAND.panel}; border: 1px solid ${BRAND.line}; border-radius: 18px; overflow: hidden; box-shadow: 0 18px 45px rgba(15, 23, 42, .08);">
                    <div style="height: 7px; background: linear-gradient(90deg, ${BRAND.primary}, ${BRAND.accent}, #84cc16);"></div>
                    <div style="padding: 34px 30px 30px;">
                      <div style="width: 52px; height: 52px; border-radius: 14px; background: ${accent}; color: #ffffff; text-align: center; line-height: 52px; font-size: 24px; font-weight: 800;">
                        ${escapeHtml(APP_NAME).charAt(0).toUpperCase()}
                      </div>
                      <h1 style="margin: 22px 0 10px; color: ${BRAND.ink}; font-size: 28px; line-height: 1.2; letter-spacing: -.5px;">
                        ${safeTitle}
                      </h1>
                      <p style="margin: 0; color: ${BRAND.muted}; font-size: 15px; line-height: 1.7;">
                        ${intro}
                      </p>
                      ${body}
                      ${cta ? actionButton(cta.label, cta.href, cta.color || accent) : ''}
                      ${signature()}
                    </div>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 18px 8px 0; color: #6b7280; font-size: 12px; line-height: 1.6; text-align: center;">
                    This email was sent by ${escapeHtml(APP_NAME)}. Need help? Contact
                    <a href="mailto:${SUPPORT_EMAIL}" style="color: ${BRAND.primary}; text-decoration: none; font-weight: 700;">${escapeHtml(SUPPORT_EMAIL)}</a>.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;
};

const sendMail = async ({ to, subject, html, text }) => {
  if (!isEmailConfigured()) {
    logger.warn(`[EMAIL DISABLED] Would send to ${to}: ${subject}`);
    return { success: true, messageId: 'disabled' };
  }

  if (!smtpTransport) {
    logger.error('[EMAIL] SMTP_USER/SMTP_PASS set but nodemailer transporter is missing');
    return { success: false, error: 'Email transporter not initialized' };
  }

  try {
    const fromAddress =
      (SMTP_FROM && String(SMTP_FROM).trim())
      || (SMTP_USER && String(SMTP_USER).trim())
      || `noreply@${APP_NAME.toLowerCase().replace(/\s/g, '')}.com`;
    const info = await smtpTransport.sendMail({
      from: fromAddress,
      to,
      subject,
      html,
      text: text || plainTextFromHtml(html),
    });
    logger.info(`Email sent to ${to}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    logger.error('Email send error:', error.message);
    return { success: false, error: error.message };
  }
};

const sendWelcomeEmail = async (to, name) => {
  const subject = `Welcome to ${APP_NAME}`;
  const html = renderEmail({
    badge: 'Vendor ready',
    title: `Welcome, ${name}`,
    preheader: 'Your vendor account is ready. Complete your profile and build your digital menu.',
    intro: `Your ${APP_NAME} vendor account is now active. Start by completing your restaurant profile, adding your menu, and inviting staff.`,
    body: noteBox('Tip: complete KYC early so menu, table, staff, and order actions stay fully available during onboarding.', 'success'),
    cta: { label: 'Open vendor dashboard', href: `${CLIENT_URL}/vendor/login` },
  });
  return sendMail({ to, subject, html });
};

const sendWelcomeEmailForPlatform = async (to, name) => {
  const subject = `Welcome to ${APP_NAME} Platform`;
  const html = renderEmail({
    badge: 'Admin access',
    title: `Welcome, ${name}`,
    preheader: 'Your platform admin account has been created.',
    intro: `Your ${APP_NAME} platform admin account has been created. You can manage restaurants, subscriptions, KYC reviews, CMS content, and operational settings.`,
    cta: { label: 'Open platform dashboard', href: `${CLIENT_URL}/platform/login`, color: '#1f2937' },
    tone: 'blue',
  });
  return sendMail({ to, subject, html });
};

const sendPasswordResetEmail = async (to, otp, name) => {
  const subject = `${APP_NAME} password reset code`;
  const html = renderEmail({
    badge: 'Password reset',
    title: 'Reset your password',
    preheader: 'Use this code to validate your password reset request.',
    intro: `Hi ${escapeHtml(name)}, use the code below to validate your password reset request. You will be asked to create a new password after the code is verified.`,
    body: `
      ${codeBlock(otp, 'blue')}
      ${noteBox('This code is valid for 10 minutes. If you did not request a password reset, you can safely ignore this email.', 'neutral')}
    `,
    cta: { label: 'Continue password reset', href: `${CLIENT_URL}/reset-password?email=${encodeURIComponent(to)}`, color: '#2563eb' },
    tone: 'blue',
  });
  return sendMail({ to, subject, html });
};

const sendVendorVerificationEmail = async (to, otp, restaurantName) => {
  const subject = `Verify your ${APP_NAME} vendor account`;
  const html = renderEmail({
    badge: 'Email verification',
    title: 'Verify your vendor account',
    preheader: 'Enter this code to activate your restaurant vendor account.',
    intro: `Hi ${escapeHtml(restaurantName)}, enter this code to finish registering your restaurant vendor account.`,
    body: `
      ${codeBlock(otp)}
      ${noteBox('This code is valid for 10 minutes. Your vendor account becomes active only after email verification.', 'success')}
    `,
    cta: { label: 'Return to vendor registration', href: `${CLIENT_URL}/vendor/register` },
  });
  return sendMail({ to, subject, html });
};

const formatLocation = (location = {}) => {
  const parts = [location.city, location.region, location.country].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Approximate location unavailable';
};

const sendUnknownDeviceLoginEmail = async (to, restaurantName, details = {}) => {
  const subject = `${APP_NAME} security alert - new restaurant login`;
  const html = renderEmail({
    badge: 'Security alert',
    title: 'New restaurant login detected',
    preheader: 'Review this sign-in to keep your restaurant account secure.',
    intro: `Hi ${escapeHtml(restaurantName)}, we detected a restaurant dashboard login that may need your attention.`,
    body: `
      ${detailTable([
        ['Reason', details.reason || 'New login'],
        ['Browser', details.browser || 'Unknown browser'],
        ['Operating system', details.operatingSystem || 'Unknown OS'],
        ['IP address', details.ipAddress || 'Unknown IP'],
        ['Location', formatLocation(details.loginLocation)],
        ['Time', details.lastActiveAt ? new Date(details.lastActiveAt).toLocaleString() : new Date().toLocaleString()],
      ])}
      ${noteBox('If this was you, no action is needed. If you do not recognize it, open Active Devices and revoke other sessions immediately.', 'danger')}
    `,
    cta: { label: 'Review active devices', href: `${CLIENT_URL}/vendor/login`, color: '#dc2626' },
    tone: 'danger',
  });
  return sendMail({ to, subject, html });
};

const sendKYCStatusEmail = async (to, restaurantName, status, reason = null) => {
  const approved = status === 'approved';
  const subject = approved ? 'KYC approved' : 'KYC update required';
  const html = renderEmail({
    badge: approved ? 'KYC approved' : 'KYC review',
    title: approved ? 'Your KYC is approved' : 'KYC update required',
    preheader: approved ? 'Your restaurant verification is approved.' : 'Please review and update your KYC submission.',
    intro: `Hi ${escapeHtml(restaurantName)}, your KYC verification status is now ${escapeHtml(status)}.`,
    body: `
      ${reason ? noteBox(`<strong>Reason:</strong> ${escapeHtml(reason)}`, 'danger') : ''}
      ${noteBox(approved ? 'You can now access all restaurant features that require verified ownership.' : 'Please update your submitted information so the platform team can review it again.', approved ? 'success' : 'danger')}
    `,
    cta: { label: approved ? 'Open vendor dashboard' : 'Update KYC', href: `${CLIENT_URL}/vendor/login`, color: approved ? BRAND.primary : '#dc2626' },
    tone: approved ? 'green' : 'danger',
  });
  return sendMail({ to, subject, html });
};

const sendEmployeeCredentialsEmail = async (
  to,
  employeeName,
  { restaurantName, restaurantId, username, temporaryPassword }
) => {
  const subject = `Your ${APP_NAME} staff account`;
  const html = renderEmail({
    badge: 'Staff access',
    title: `Welcome, ${employeeName}`,
    preheader: `Your staff account for ${restaurantName} has been created.`,
    intro: `Your account at ${escapeHtml(restaurantName)} has been created. Use the credentials below to sign in as staff.`,
    body: `
      ${detailTable([
        ['Restaurant ID', restaurantId],
        ['Username', username],
        ['Temporary password', temporaryPassword],
      ])}
      ${noteBox('Important: you will be asked to change this temporary password on your first login.', 'neutral')}
    `,
    cta: { label: 'Sign in as staff', href: `${CLIENT_URL}/staff/login`, color: '#0284c7' },
    tone: 'blue',
  });
  return sendMail({ to, subject, html });
};

const sendBranchOwnerOtpEmail = async (to, restaurantName, otp, expiresInMinutes) => {
  const subject = `${APP_NAME} — verify branch owner Gmail`;
  const html = renderEmail({
    badge: 'Branch setup',
    title: 'Verification code',
    preheader: `Confirm your Gmail to finish creating a branch for ${restaurantName}.`,
    intro: `You are verifying this Gmail as the branch owner for <strong>${escapeHtml(restaurantName)}</strong>. Enter the code below in the dashboard form to continue.`,
    body: `
      ${codeBlock(otp, 'blue')}
      ${noteBox(`This code expires in ${expiresInMinutes} minutes. If you did not request it, you can ignore this email.`, 'neutral')}
    `,
    cta: { label: 'Open vendor dashboard', href: `${CLIENT_URL}/vendor/login`, color: BRAND.primary },
    tone: 'blue',
  });
  return sendMail({ to, subject, html });
};

const sendBranchOwnerWelcomeEmail = async (to, details = {}) => {
  const {
    restaurantName,
    branchName,
    branchEmail,
    username,
    password,
    publicRestaurantId,
    restaurantId,
    branchPortalKey,
    loginPath,
    publicBranchId,
    branchSlug,
  } = details;
  const subject = `${APP_NAME} — your branch is ready: ${branchName || 'Outlet'}`;
  const loginUrl = loginPath && CLIENT_URL ? `${String(CLIENT_URL).replace(/\/$/, '')}${loginPath}` : `${CLIENT_URL}/login?role=restaurant`;
  const html = renderEmail({
    badge: 'Branch access',
    title: `Welcome, ${escapeHtml(branchName || 'Branch')}`,
    preheader: 'Your branch portal login details and outlet information.',
    intro: `Your branch <strong>${escapeHtml(branchName || '')}</strong> at <strong>${escapeHtml(restaurantName || '')}</strong> has been created. Save these credentials securely.`,
    body: `
      ${detailTable([
        ['Branch login (username)', branchEmail || username || '—'],
        ['Restaurant ID (for sign-in)', publicRestaurantId || restaurantId || '—'],
        ['Branch owner Gmail', to],
        ['Temporary password', password || '—'],
        ['Public branch ID', publicBranchId || '—'],
        ['Branch slug', branchSlug || '—'],
        ['Portal security key', branchPortalKey || '—'],
      ])}
      ${noteBox('Sign in from the main login page: use your branch login ending with <strong>@branch.com</strong>, your Restaurant ID, and your password.', 'success')}
    `,
    cta: { label: 'Open sign-in page', href: `${CLIENT_URL}/login?role=restaurant`, color: BRAND.primary },
    tone: 'green',
  });
  const text = plainTextFromHtml(html);
  return sendMail({ to, subject, html, text: `${text}\nLegacy portal link: ${loginUrl}` });
};

const sendNewTicketNotification = async (recipients, restaurantName, ticketNumber, subjectText) => {
  const subject = `New support ticket: ${ticketNumber}`;
  const html = renderEmail({
    badge: 'New ticket',
    title: 'New support ticket received',
    preheader: `${restaurantName} submitted a new support ticket.`,
    intro: `A new support ticket has been submitted by ${escapeHtml(restaurantName)}. Please review it from the platform support area.`,
    body: detailTable([
      ['Ticket number', ticketNumber],
      ['Subject', subjectText],
      ['Restaurant', restaurantName],
    ]),
    cta: { label: 'View ticket', href: `${CLIENT_URL}/platform/tickets`, color: '#1f2937' },
    tone: 'blue',
  });
  return sendMail({ to: Array.isArray(recipients) ? recipients.join(',') : recipients, subject, html });
};

const sendTicketReplyNotification = async (to, recipientName, ticketNumber, responderName, restaurantReply) => {
  const subject = `New reply on ticket ${ticketNumber}`;
  const senderLabel = restaurantReply ? 'restaurant' : 'admin';
  const html = renderEmail({
    badge: 'Ticket reply',
    title: 'New support ticket reply',
    preheader: `A new ${senderLabel} reply was added to ticket ${ticketNumber}.`,
    intro: `Hi ${escapeHtml(recipientName)}, a new ${senderLabel} reply has been added by ${escapeHtml(responderName)}.`,
    body: detailTable([
      ['Ticket number', ticketNumber],
      ['Responder', responderName],
      ['Reply type', senderLabel],
    ]),
    cta: { label: 'Open ticket', href: `${CLIENT_URL}/vendor/login`, color: BRAND.accent },
  });
  return sendMail({ to, subject, html });
};

const sendTicketStatusChangeNotification = async (to, restaurantName, ticketNumber, status) => {
  const statusLabel = String(status).replace('_', ' ');
  const subject = `Ticket ${ticketNumber} status updated`;
  const html = renderEmail({
    badge: 'Ticket update',
    title: 'Support ticket status updated',
    preheader: `Ticket ${ticketNumber} is now ${statusLabel}.`,
    intro: `Hi ${escapeHtml(restaurantName)}, your support ticket status has changed.`,
    body: detailTable([
      ['Ticket number', ticketNumber],
      ['New status', statusLabel],
    ]),
    cta: { label: 'View support tickets', href: `${CLIENT_URL}/vendor/login`, color: BRAND.accent },
  });
  return sendMail({ to, subject, html });
};

const sendPackageExpiryEmail = async (to, name, daysLeft) => {
  const subject = 'Subscription expiring soon';
  const html = renderEmail({
    badge: 'Subscription',
    title: 'Subscription expiring soon',
    preheader: `Your subscription expires in ${daysLeft} days.`,
    intro: `Hi ${escapeHtml(name)}, your subscription will expire in ${escapeHtml(daysLeft)} days. Renew before it ends to keep restaurant access uninterrupted.`,
    body: noteBox('Renewing early keeps menu, table, staff, order, and billing workflows available without interruption.', 'neutral'),
    cta: { label: 'Review subscription', href: `${CLIENT_URL}/vendor/login`, color: '#dc2626' },
    tone: 'danger',
  });
  return sendMail({ to, subject, html });
};

const sendSubscriptionPaymentEmail = async (to, restaurantName, details = {}) => {
  const subject = details.subject || 'Subscription payment update';
  const html = renderEmail({
    badge: 'Subscription',
    title: details.title || subject,
    preheader: details.message || subject,
    intro: `Hi ${escapeHtml(restaurantName)}, ${escapeHtml(details.message || 'there is an update on your subscription payment.')}`,
    body: `
      ${detailTable([
        ['Plan', details.planName || 'Subscription plan'],
        ['Amount', `Rs. ${Number(details.amount || 0).toFixed(2)}`],
        ['Transaction ID', details.transactionId || 'N/A'],
        ['Status', String(details.status || 'pending').replace(/_/g, ' ')],
      ])}
      ${noteBox('Payments are reviewed by the platform team before a plan is activated. Gateway success alone does not activate restaurant features.', 'neutral')}
    `,
    cta: { label: 'Review subscription', href: `${CLIENT_URL}/vendor/login`, color: BRAND.accent },
    tone: details.status === 'rejected' ? 'danger' : 'green',
  });
  return sendMail({ to, subject, html });
};

const sendOrderConfirmationEmail = async (to, orderNumber, orderItems = [], grandTotal = 0) => {
  const subject = `Order ${orderNumber} confirmed`;
  const itemRows = orderItems.map((item) => [
    `${item.quantity || 1} x ${item.name || 'Menu item'}`,
    `Rs. ${Number(item.subtotal || 0).toFixed(2)}`,
  ]);
  const html = renderEmail({
    badge: 'Order received',
    title: 'Your order is confirmed',
    preheader: `Order ${orderNumber} has been received by the restaurant.`,
    intro: `Thanks for your order. The restaurant has received order ${escapeHtml(orderNumber)} and will start preparing it shortly.`,
    body: `
      ${detailTable([
        ['Order number', orderNumber],
        ...itemRows,
        ['Grand total', `Rs. ${Number(grandTotal || 0).toFixed(2)}`],
      ])}
      ${noteBox('Keep this email for your order reference. You can ask restaurant staff for updates using your order number.', 'success')}
    `,
    cta: { label: 'Open menu', href: CLIENT_URL },
  });
  return sendMail({ to, subject, html });
};

const sendCreditCheckoutOtpEmail = async (to, code, restaurantName) => {
  const subject = `Your verification code — ${restaurantName || 'Restaurant'}`;
  const html = renderEmail({
    badge: 'Secure checkout',
    title: 'Verify it’s you',
    preheader: 'Use this code to confirm credit checkout.',
    intro: `You requested to place an order on credit at ${escapeHtml(restaurantName || 'the restaurant')}. Enter this one-time code to continue.`,
    body: `
      ${codeBlock(String(code), 'blue')}
      ${noteBox('If you did not request this, ignore this email. The code expires in 10 minutes.', 'neutral')}
    `,
    tone: 'blue',
  });
  return sendMail({ to, subject, html });
};

const sendCustomerIdentityOtpEmail = async (to, code, { restaurantName, purpose = 'signup' } = {}) => {
  const isLogin = purpose === 'login';
  const isReset = purpose === 'reset';
  const subject = `${isReset ? 'Reset password' : isLogin ? 'Login' : 'Create customer ID'} code - ${restaurantName || 'Restaurant'}`;
  const html = renderEmail({
    badge: isReset ? 'Password reset' : isLogin ? 'Customer login' : 'Customer ID',
    title: isReset ? 'Reset your customer password' : isLogin ? 'Verify your customer login' : 'Verify your customer ID',
    preheader: 'Use this one-time code to continue.',
    intro: `Enter this code at ${escapeHtml(restaurantName || 'the restaurant')} to ${isReset ? 'reset your customer password' : isLogin ? 'login to your customer ID' : 'create your customer ID and merge your guest history'}.`,
    body: `
      ${codeBlock(String(code), 'blue')}
      ${noteBox('If you did not request this, ignore this email. The code expires in 10 minutes.', 'neutral')}
    `,
    tone: 'blue',
  });
  return sendMail({ to, subject, html });
};

const sendCreditBillEmail = async (to, { restaurantName, orderNumber, grandTotal, items = [], isCreditSale }) => {
  const subject = `${isCreditSale ? 'Credit bill' : 'Payment receipt'} — ${orderNumber}`;
  const itemRows = items.map((item) => [
    `${item.quantity || 1} × ${item.name || 'Item'}`,
    `Rs. ${Number(item.subtotal || 0).toFixed(2)}`,
  ]);
  const html = renderEmail({
    badge: isCreditSale ? 'Account credit' : 'Receipt',
    title: isCreditSale ? 'Your credit bill' : 'Thanks for your payment',
    preheader: `Order ${orderNumber}`,
    intro: isCreditSale
      ? `This amount is recorded on your approved house account at ${escapeHtml(restaurantName || 'the restaurant')}. Please settle per your agreement with the restaurant.`
      : `Thank you. Here is a copy of your bill for order ${escapeHtml(orderNumber)}.`,
    body: `
      ${detailTable([
        ['Restaurant', restaurantName || '—'],
        ['Order number', orderNumber],
        ...itemRows,
        ['Total', `Rs. ${Number(grandTotal || 0).toFixed(2)}`],
      ])}
      ${isCreditSale ? noteBox('This is not a payment confirmation — balance remains due until the restaurant records payment.', 'neutral') : noteBox('Retain this email for your records.', 'success')}
    `,
    cta: { label: 'Open customer menu', href: CLIENT_URL, color: BRAND.accent },
  });
  return sendMail({ to, subject, html });
};

const sendCreditAccountNotificationEmail = async (to, { restaurantName, status, message }) => {
  const subject =
    status === 'approved'
      ? `Credit account approved — ${restaurantName || 'Restaurant'}`
      : `Credit account update — ${restaurantName || 'Restaurant'}`;
  const html = renderEmail({
    badge: 'House account',
    title: status === 'approved' ? 'You can use credit checkout' : 'Account update',
    preheader: subject,
    intro: escapeHtml(message || ''),
    body: noteBox(
      status === 'approved'
        ? 'When you order via QR, choose “Pay later (credit)” at checkout and verify your email with the code we send.'
        : 'Contact the restaurant if you have questions.',
      status === 'approved' ? 'success' : 'neutral',
    ),
    tone: status === 'approved' ? 'green' : 'blue',
  });
  return sendMail({ to, subject, html });
};

const sendBulkMail = async (recipients, subject, html) => {
  const results = [];
  const brandedHtml = renderEmail({
    badge: 'Platform update',
    title: subject,
    preheader: subject,
    intro: 'A platform update has been sent to you.',
    body: html,
    cta: { label: `Open ${APP_NAME}`, href: CLIENT_URL },
  });

  for (const to of recipients) {
    const result = await sendMail({ to, subject, html: brandedHtml });
    results.push({ to, ...result });
  }
  return results;
};

const sendBackupRestoreOtpEmail = async (to, restaurantName, otp, purpose = 'restore', ttlMinutes = 10) => {
  const subject = `${APP_NAME} — Backup restore verification`;
  const html = renderEmail({
    title: 'Authorize backup restore',
    preheader: `Your ${purpose} verification code`,
    intro: `Hello ${restaurantName || 'there'},`,
    body: `
      <p style="margin:0 0 16px;color:${BRAND.ink};font-size:15px;line-height:1.6;">
        Use this code to confirm the <strong>${escapeHtml(purpose)}</strong> operation on your restaurant account.
      </p>
      ${codeBlock(otp, 'green')}
      ${noteBox(`This code expires in <strong>${ttlMinutes} minutes</strong>. If you did not request this, secure your account immediately.`, 'danger')}
    `,
  });
  return sendMail({ to, subject, html });
};

module.exports = {
  sendBackupRestoreOtpEmail,
  sendWelcomeEmail,
  sendWelcomeEmailForPlatform,
  sendPasswordResetEmail,
  sendVendorVerificationEmail,
  sendUnknownDeviceLoginEmail,
  sendKYCStatusEmail,
  sendEmployeeCredentialsEmail,
  sendBranchOwnerOtpEmail,
  sendBranchOwnerWelcomeEmail,
  sendNewTicketNotification,
  sendTicketReplyNotification,
  sendTicketStatusChangeNotification,
  sendPackageExpiryEmail,
  sendSubscriptionPaymentEmail,
  sendOrderConfirmationEmail,
  sendCreditCheckoutOtpEmail,
  sendCustomerIdentityOtpEmail,
  sendCreditBillEmail,
  sendCreditAccountNotificationEmail,
  sendBulkMail,
  isEmailConfigured,
};
