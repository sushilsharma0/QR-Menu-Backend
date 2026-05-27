require('dotenv').config();

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';
const jwtSecret = process.env.JWT_SECRET;
const jwtAlgorithm = process.env.JWT_ALGORITHM || 'HS256';
const allowedJwtAlgorithms = new Set(['HS256']);

if (!allowedJwtAlgorithms.has(jwtAlgorithm)) {
  throw new Error('JWT_ALGORITHM must be HS256');
}

if (isProduction && (!jwtSecret || jwtSecret.length < 32)) {
  throw new Error('JWT_SECRET must be set to at least 32 characters in production');
}

if (!isProduction && (!jwtSecret || jwtSecret === 'your-super-secret-jwt-key')) {
  process.env.JWT_SECRET = 'development-only-change-me-32-characters-minimum';
}

module.exports = {
  // Server
  PORT: process.env.PORT || 5000,
  NODE_ENV,
  
  // Database
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/qr-menu-saas',
  
  // JWT
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  JWT_ALGORITHM: jwtAlgorithm,
  JWT_ISSUER: process.env.JWT_ISSUER || 'mero-qr-api',
  JWT_AUDIENCE: process.env.JWT_AUDIENCE || 'mero-qr-client',

  // QR ordering
  QR_TOKEN_SECRET: process.env.QR_TOKEN_SECRET || process.env.JWT_SECRET,
  QR_TOKEN_EXPIRES_IN: process.env.QR_TOKEN_EXPIRES_IN || '180d',
  ALLOW_LEGACY_QR_TOKENS: String(process.env.ALLOW_LEGACY_QR_TOKENS || '').toLowerCase() === 'true',
  
  // Email
  SMTP_HOST: process.env.SMTP_HOST || 'smtp.gmail.com',
  SMTP_PORT: parseInt(process.env.SMTP_PORT) || 587,
  SMTP_SECURE: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  // Leave empty to send "From" as SMTP_USER (required for Gmail / most consumer SMTP).
  SMTP_FROM: process.env.SMTP_FROM || '',
  
  // URLs
  CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:3000',
  ADMIN_URL: process.env.ADMIN_URL || 'http://localhost:3001',
  
  // File Upload
  UPLOAD_PATH: process.env.UPLOAD_PATH || './secure_uploads',
  SECURE_UPLOAD_PATH: process.env.SECURE_UPLOAD_PATH || './secure_uploads',
  FILE_ACCESS_SECRET: process.env.FILE_ACCESS_SECRET || process.env.JWT_SECRET,
  MAX_FILE_SIZE: parseInt(process.env.MAX_FILE_SIZE, 10) || 1 * 1024 * 1024,
  
  // App
  APP_NAME: process.env.APP_NAME || 'QR Menu SaaS',
  COMPANY_NAME: process.env.COMPANY_NAME || 'QR Menu SaaS',
  SUPPORT_EMAIL: process.env.SUPPORT_EMAIL || 'support@qrmenu.com',

  // cloudinary
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,

  // Payment gateways
  ESEWA_MERCHANT_ID: process.env.ESEWA_MERCHANT_ID,
  ESEWA_SECRET_KEY: process.env.ESEWA_SECRET_KEY,
  ESEWA_SUCCESS_URL: process.env.ESEWA_SUCCESS_URL,
  ESEWA_FAILURE_URL: process.env.ESEWA_FAILURE_URL,
  KHALTI_SECRET_KEY: process.env.KHALTI_SECRET_KEY,
  KHALTI_PUBLIC_KEY: process.env.KHALTI_PUBLIC_KEY,
  KHALTI_RETURN_URL: process.env.KHALTI_RETURN_URL,
  KHALTI_WEBSITE_URL: process.env.KHALTI_WEBSITE_URL
};
