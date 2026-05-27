const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const { apiLimiter, ipThrottleLimiter, writeLimiter } = require('./middleware/rateLimiter');
const {
  getRequestId,
  securityRequestLogger,
  validateJsonContentType,
  blockPrototypePollution,
  csrfOriginProtection,
  apiSignatureValidation,
  rawBodySaver,
} = require('./middleware/apiSecurity');
const {
  enforceHttps,
  secureCookieDefaults,
  superadminVpnRestriction,
  infrastructureSecurityHeaders,
} = require('./middleware/infrastructureSecurity');
const errorHandler = require('./middleware/errorHandler');
const realtimeBroadcastMiddleware = require('./middleware/realtimeBroadcastMiddleware');
const fraudLockGuard = require('./middleware/fraudLockGuard');
const { securityIpBlocker } = require('./middleware/securityIpBlocker');
const { logger } = require('./utils/logger');
const AuditLog = require('./models/platform/AuditLog');

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY || 1);

const configuredOrigins = [
  process.env.CORS_ORIGIN,
  process.env.CLIENT_URL,
  process.env.ADMIN_URL,
]
  .filter(Boolean)
  .flatMap((value) => String(value).split(','))
  .map((value) => value.trim())
  .filter((value) => value && value !== '*');

const developmentOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
];

const desktopOrigins = [
  'file://',
  'null',
];

const allowedOrigins = new Set([
  ...configuredOrigins,
  ...desktopOrigins,
  ...((process.env.NODE_ENV || 'development') === 'production' ? [] : developmentOrigins),
]);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) return callback(null, true);
    logger.warn('Blocked CORS origin: %s', origin);
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'X-Branch-Id',
    'X-Device-Id',
    'X-Device-Fingerprint',
    'X-Device-Timezone',
    'X-Device-Screen',
    'X-Geo-Latitude',
    'X-Geo-Longitude',
    'X-Geo-City',
    'X-Geo-Region',
    'X-Geo-Country',
    'X-CSRF-Token',
    'X-API-Signature',
    'X-API-Timestamp',
    'X-Request-Id',
    'X-Guest-Session',
    'X-Desktop-App',
    'Idempotency-Key',
  ],
  maxAge: 600,
};

app.use(enforceHttps);
app.use(secureCookieDefaults);
app.use(infrastructureSecurityHeaders);

// Apply CORS
app.use(cors(corsOptions));

// Handle preflight requests
app.options('*', cors(corsOptions));

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", ...Array.from(allowedOrigins)],
      formAction: ["'self'"],
    },
  },
  hsts: process.env.NODE_ENV === 'production'
    ? { maxAge: 31536000, includeSubDomains: true, preload: true }
    : false,
  frameguard: { action: 'deny' },
  noSniff: true,
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(compression());
app.use(getRequestId);
app.use(securityRequestLogger);
app.use(validateJsonContentType);
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '2mb', verify: rawBodySaver }));
app.use(express.urlencoded({ extended: true, limit: process.env.FORM_BODY_LIMIT || '1mb', verify: rawBodySaver }));
app.use(blockPrototypePollution);
app.use(csrfOriginProtection);
app.use(apiSignatureValidation);
app.use(ipThrottleLimiter);
app.use(apiLimiter);
app.use(writeLimiter);
app.use(securityIpBlocker);
app.use(fraudLockGuard);

// Logging middleware
app.use((req, res, next) => {
  logger.http(`${req.method} ${req.url} - ${req.ip} - requestId=${req.requestId}`);
  next();
});

// Activity logging for restaurant-side rejected actions (validation / forbidden / failed requests)
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (payload) => {
    try {
      const statusCode = res.statusCode;
      const isRestaurantApi = req.path.startsWith('/api/restaurant');
      const shouldTrack =
        isRestaurantApi &&
        statusCode >= 400 &&
        statusCode < 500 &&
        req.user &&
        !req.path.startsWith('/api/restaurant/logs');

      if (shouldTrack) {
        const userModel =
          req.user.scope === 'employee'
            ? 'Employee'
            : req.user.scope === 'branch_user'
              ? 'BranchAuth'
              : 'Restaurant';
        const action =
          statusCode === 403
            ? 'forbidden_action'
            : statusCode === 422
              ? 'validation_failed'
              : 'request_rejected';
        AuditLog.create({
          user: req.user.id,
          userModel,
          action,
          resource: 'system',
          details: {
            restaurantId: String(req.user.restaurantId || req.user.id),
            method: req.method,
            path: req.path,
            statusCode,
            message: payload?.message || 'Request rejected',
            code: payload?.errors?.code || null
          },
          ipAddress: req.ip,
          userAgent: req.get('User-Agent')
        }).catch((logErr) => {
          logger.warn('Failed to write rejected-activity audit log: %s', logErr.message);
        });
      }
    } catch (err) {
      logger.warn('Rejected-activity log middleware failed: %s', err.message);
    }

    return originalJson(payload);
  };
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/files', require('./routes/fileRoutes'));

// Platform Routes
app.use(superadminVpnRestriction);
app.use('/api/platform/auth', require('./routes/platform/authRoutes'));
app.use('/api/platform/admins', require('./routes/platform/adminRoutes'));
app.use('/api/platform/restaurants', require('./routes/platform/restaurantRoutes'));
app.use('/api/platform/subscriptions', require('./routes/platform/subscriptionRoutes'));
app.use('/api/platform/plan-access-settings', require('./routes/platform/planAccessSettingsRoutes'));
app.use('/api/platform/billing', require('./routes/platform/billingRoutes'));
app.use('/api/platform/kyc', require('./routes/platform/kycRoutes'));
app.use('/api/platform/dashboard', require('./routes/platform/dashboardRoutes'));
app.use('/api/platform/cms', require('./routes/platform/cmsRoutes'));
app.use('/api/platform/feedback', require('./routes/platform/feedbackRoutes'));
app.use('/api/platform/settings', require('./routes/platform/settingsRoutes'));
app.use('/api/platform/tickets', require('./routes/platform/ticketRoutes'));
app.use('/api/platform/logs', require('./routes/platform/logRoutes'));
app.use('/api/platform/fraud', require('./routes/platform/fraudRoutes'));
app.use('/api/platform/security', require('./routes/platform/securityRoutes'));
app.use('/api/platform/payroll', require('./routes/platform/platformPayrollRoutes'));
app.use('/api/platform/finance', require('./routes/platform/platformFinanceRoutes'));
app.use('/api/platform/branches', require('./routes/platform/branchRoutes'));

// Socket.IO realtime invalidation for mutating restaurant/platform APIs
app.use('/api/restaurant', realtimeBroadcastMiddleware);
app.use('/api/platform', realtimeBroadcastMiddleware);

// Restaurant Routes
app.use('/api/restaurant/auth', require('./routes/restaurant/authRoutes'));
app.use('/api/restaurant/branch-auth', require('./routes/restaurant/branchAuthRoutes'));
app.use('/api/restaurant/branches', require('./routes/restaurant/branchRoutes'));
app.use('/api/restaurant/menu', require('./routes/restaurant/menuRoutes'));
app.use('/api/restaurant/recipes', require('./routes/restaurant/recipeRoutes'));
app.use('/api/restaurant/orders', require('./routes/restaurant/orderRoutes'));
app.use('/api/restaurant/customer-orders', require('./routes/restaurant/customerOrderRoutes'));
app.use('/api/restaurant/credit-customers', require('./routes/restaurant/creditCustomerRoutes'));
app.use('/api/restaurant/employees', require('./routes/restaurant/employeeRoutes'));
app.use('/api/restaurant/attendance', require('./routes/restaurant/attendanceRoutes'));
app.use('/api/restaurant/tables', require('./routes/restaurant/tableRoutes'));
app.use('/api/restaurant/reservations', require('./routes/restaurant/reservationRoutes'));
app.use('/api/restaurant/kyc', require('./routes/restaurant/kycRoutes'));
app.use('/api/restaurant/package', require('./routes/restaurant/packageRoutes'));
app.use('/api', require('./routes/subscriptionPaymentRoutes'));
app.use('/api/restaurant/billing', require('./routes/restaurant/billingRoutes'));
app.use('/api/restaurant/cashier', require('./routes/restaurant/cashierRoutes'));
app.use('/api/restaurant/pos', require('./routes/restaurant/posRoutes'));
app.use('/api/restaurant/dashboard', require('./routes/restaurant/dashboardRoutes'));
app.use('/api/restaurant/insights', require('./routes/restaurant/insightsRoutes'));
app.use('/api/restaurant/crm', require('./routes/restaurant/crmRoutes'));
app.use('/api/restaurant/tickets', require('./routes/restaurant/ticketRoutes'));
app.use('/api/restaurant/promotions', require('./routes/restaurant/promotionRoutes'));
app.use('/api/restaurant/logs', require('./routes/restaurant/logRoutes'));
app.use('/api/restaurant/finance', require('./routes/restaurant/financeRoutes'));
app.use('/api/restaurant/inventory', require('./routes/restaurant/inventoryRoutes'));
app.use('/api/restaurant/payroll', require('./routes/restaurant/payrollRoutes'));
app.use('/api/restaurant/invoices', require('./routes/restaurant/invoiceRoutes'));
app.use('/api/restaurant/backup', require('./routes/restaurant/backupRoutes'));

// Public reference data (countries/states/districts for settings forms)
app.use('/api/public/locations', require('./routes/publicLocationRoutes'));

// Customer Routes
app.use('/api/customer', require('./routes/customerRoutes'));
app.use('/api/notifications', require('./routes/notificationRoutes'));

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: 'API endpoint not found' });
});

// Error handler
app.use(errorHandler);

module.exports = app;
