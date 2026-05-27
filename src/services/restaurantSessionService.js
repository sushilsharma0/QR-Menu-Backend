const crypto = require('crypto');
const RestaurantSession = require('../models/restaurant/RestaurantSession');
const notificationService = require('./notificationService');
const { sendUnknownDeviceLoginEmail } = require('./emailService');
const { logger } = require('../utils/logger');

const SESSION_DAYS = parseInt(process.env.RESTAURANT_SESSION_DAYS, 10) || 30;
const SESSION_INACTIVITY_MINUTES = parseInt(process.env.RESTAURANT_SESSION_INACTIVITY_MINUTES, 10) || 60;
const SUSPICIOUS_SESSION_WINDOW_MINUTES =
  parseInt(process.env.RESTAURANT_SUSPICIOUS_SESSION_WINDOW_MINUTES, 10) || 10;
const SUSPICIOUS_SESSION_LIMIT =
  parseInt(process.env.RESTAURANT_SUSPICIOUS_SESSION_LIMIT, 10) || 4;
const IMPOSSIBLE_TRAVEL_KMPH = parseInt(process.env.RESTAURANT_IMPOSSIBLE_TRAVEL_KMPH, 10) || 900;

const sha256 = (value) => crypto.createHash('sha256').update(String(value || '')).digest('hex');

const normalizeIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded || req.ip || req.socket?.remoteAddress || '';
  return String(raw).split(',')[0].trim().replace(/^::ffff:/, '');
};

const parseUserAgent = (ua = '') => {
  const value = String(ua);
  let browser = 'Unknown browser';
  let operatingSystem = 'Unknown OS';
  let deviceType = 'Desktop';

  if (/Edg\//i.test(value)) browser = 'Microsoft Edge';
  else if (/Chrome\//i.test(value) && !/Chromium/i.test(value)) browser = 'Chrome';
  else if (/Firefox\//i.test(value)) browser = 'Firefox';
  else if (/Safari\//i.test(value) && !/Chrome\//i.test(value)) browser = 'Safari';
  else if (/OPR\//i.test(value) || /Opera/i.test(value)) browser = 'Opera';

  if (/Windows NT/i.test(value)) operatingSystem = 'Windows';
  else if (/Android/i.test(value)) operatingSystem = 'Android';
  else if (/iPhone|iPad|iPod/i.test(value)) operatingSystem = 'iOS';
  else if (/Mac OS X/i.test(value)) operatingSystem = 'macOS';
  else if (/Linux/i.test(value)) operatingSystem = 'Linux';

  if (/iPad|Tablet/i.test(value)) deviceType = 'Tablet';
  else if (/Mobi|Android|iPhone|iPod/i.test(value)) deviceType = 'Mobile';

  return { browser, operatingSystem, deviceType };
};

const getLocationFromHeaders = (req) => {
  const latitude = Number(req.headers['x-geo-latitude']);
  const longitude = Number(req.headers['x-geo-longitude']);
  return {
    city: String(req.headers['x-geo-city'] || '').slice(0, 80),
    region: String(req.headers['x-geo-region'] || '').slice(0, 80),
    country: String(req.headers['x-geo-country'] || '').slice(0, 80),
    latitude: Number.isFinite(latitude) ? latitude : undefined,
    longitude: Number.isFinite(longitude) ? longitude : undefined,
    source: req.headers['x-geo-country'] ? 'proxy-header' : 'ip',
  };
};

const distanceKm = (from, to) => {
  if (![from?.latitude, from?.longitude, to?.latitude, to?.longitude].every(Number.isFinite)) return null;
  const toRad = (degrees) => degrees * Math.PI / 180;
  const earthKm = 6371;
  const dLat = toRad(to.latitude - from.latitude);
  const dLon = toRad(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.latitude)) * Math.cos(toRad(to.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthKm * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const buildDeviceFingerprint = (req) => {
  const supplied = req.headers['x-device-fingerprint'];
  if (supplied) return sha256(String(supplied).slice(0, 500));
  const ua = req.get('User-Agent') || '';
  const language = req.headers['accept-language'] || '';
  return sha256(`${ua}|${language}`);
};

const getDeviceId = (req) => {
  const supplied = String(req.headers['x-device-id'] || req.body?.deviceId || '').trim();
  if (supplied) return supplied.slice(0, 120);
  return crypto.randomUUID();
};

const makeRefreshToken = () => crypto.randomBytes(48).toString('hex');

async function inspectLoginRisk(restaurantId, location) {
  const recentSessions = await RestaurantSession.find({
    restaurantId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  }).sort({ lastActiveAt: -1 }).limit(10).lean();

  const lastSessionWithLocation = recentSessions.find((session) =>
    Number.isFinite(session?.loginLocation?.latitude) &&
    Number.isFinite(session?.loginLocation?.longitude)
  );
  let impossibleTravel = false;
  if (lastSessionWithLocation) {
    const km = distanceKm(lastSessionWithLocation.loginLocation, location);
    const hours = Math.max(
      (Date.now() - new Date(lastSessionWithLocation.lastActiveAt).getTime()) / (1000 * 60 * 60),
      0.25,
    );
    impossibleTravel = km != null && (km / hours) > IMPOSSIBLE_TRAVEL_KMPH;
  }

  const concurrentWindow = new Date(Date.now() - SUSPICIOUS_SESSION_WINDOW_MINUTES * 60 * 1000);
  const recentActiveCount = recentSessions.filter((session) =>
    new Date(session.lastActiveAt) >= concurrentWindow
  ).length;

  return {
    impossibleTravel,
    suspiciousConcurrentSessions: recentActiveCount >= SUSPICIOUS_SESSION_LIMIT,
    activeSessionCount: recentSessions.length,
  };
}

async function createRestaurantSession(req, restaurant) {
  const now = new Date();
  const deviceId = getDeviceId(req);
  const deviceFingerprint = buildDeviceFingerprint(req);
  const ipAddress = normalizeIp(req);
  const userAgent = req.get('User-Agent') || '';
  const { browser, operatingSystem, deviceType } = parseUserAgent(userAgent);
  const loginLocation = getLocationFromHeaders(req);
  const timezone = String(req.headers['x-device-timezone'] || '').slice(0, 80);
  const screenResolution = String(req.headers['x-device-screen'] || '').slice(0, 40);
  const refreshToken = makeRefreshToken();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const knownDevice = await RestaurantSession.exists({
    restaurantId: restaurant._id,
    $or: [
      { deviceId, deviceFingerprint },
      {
        deviceFingerprint,
        userAgent,
        timezone,
        screenResolution,
      },
    ],
  });

  await RestaurantSession.updateMany(
    {
      restaurantId: restaurant._id,
      revokedAt: null,
      expiresAt: { $gt: now },
      $or: [
        { deviceId },
        {
          deviceFingerprint,
          userAgent,
          timezone,
          screenResolution,
        },
      ],
    },
    {
      $set: {
        revokedAt: now,
        revokedReason: 'superseded_by_same_device_login',
        refreshTokenBlacklistedAt: now,
      },
      $inc: { tokenVersion: 1 },
    },
  );

  const risk = await inspectLoginRisk(restaurant._id, loginLocation);

  const session = await RestaurantSession.create({
    restaurantId: restaurant._id,
    deviceId,
    deviceFingerprint,
    browser,
    operatingSystem,
    deviceType,
    timezone,
    screenResolution,
    ipAddress,
    loginLocation,
    userAgent,
    lastActiveAt: now,
    expiresAt,
    refreshTokenHash: sha256(refreshToken),
    loginAlerts: {
      unknownDevice: !knownDevice,
      impossibleTravel: risk.impossibleTravel,
      suspiciousConcurrentSessions: risk.suspiciousConcurrentSessions,
    },
  });

  if (!knownDevice || risk.impossibleTravel || risk.suspiciousConcurrentSessions) {
    await notifyLoginAlert(restaurant, session);
  }

  return { session, refreshToken };
}

async function notifyLoginAlert(restaurant, session) {
  const alertParts = [];
  if (session.loginAlerts.unknownDevice) alertParts.push('unknown device');
  if (session.loginAlerts.impossibleTravel) alertParts.push('impossible travel');
  if (session.loginAlerts.suspiciousConcurrentSessions) alertParts.push('many simultaneous sessions');
  const reason = alertParts.join(', ') || 'new sign-in';

  notificationService.sendNotification({
    recipientType: 'restaurant',
    recipientId: restaurant._id,
    type: 'auth_security_alert',
    category: 'auth',
    priority: session.loginAlerts.unknownDevice ? 'high' : 'medium',
    title: 'Security alert: new login',
    message: `A login was detected from ${session.browser} on ${session.operatingSystem}. Reason: ${reason}.`,
    metadata: {
      ipAddress: session.ipAddress,
      deviceId: session.deviceId,
      loginLocation: session.loginLocation,
      reason,
    },
    actionUrl: '/notifications',
  }).catch((err) => logger.warn('Login security notification failed: %s', err.message));

  sendUnknownDeviceLoginEmail(restaurant.email, restaurant.name, {
    reason,
    browser: session.browser,
    operatingSystem: session.operatingSystem,
    ipAddress: session.ipAddress,
    loginLocation: session.loginLocation,
    lastActiveAt: session.lastActiveAt,
  }).catch((err) => logger.warn('Login security email failed: %s', err.message));
}

async function validateRestaurantSession(decoded, req) {
  if (!decoded.sessionId || !decoded.tokenVersion) return { valid: false };

  const session = await RestaurantSession.findOne({
    _id: decoded.sessionId,
    restaurantId: decoded.id,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  }).lean();
  if (!session) return { valid: false };
  if (Number(session.tokenVersion) !== Number(decoded.tokenVersion)) return { valid: false };
  const requestFingerprint = buildDeviceFingerprint(req);
  if (session.deviceFingerprint !== requestFingerprint) {
    const requestDeviceId = getDeviceId(req);
    if (requestDeviceId && requestDeviceId === session.deviceId) {
      await RestaurantSession.updateOne(
        { _id: session._id, restaurantId: decoded.id },
        { $set: { deviceFingerprint: requestFingerprint } },
      );
    } else {
      return { valid: false, fingerprintMismatch: true };
    }
  }

  const inactiveMs = Date.now() - new Date(session.lastActiveAt).getTime();
  if (inactiveMs > SESSION_INACTIVITY_MINUTES * 60 * 1000) {
    await RestaurantSession.updateOne(
      { _id: session._id, restaurantId: decoded.id },
      { $set: { revokedAt: new Date(), revokedReason: 'inactivity_timeout', refreshTokenBlacklistedAt: new Date() } },
    );
    return { valid: false, timeout: true };
  }

  await RestaurantSession.updateOne(
    { _id: session._id, restaurantId: decoded.id },
    { $set: { lastActiveAt: new Date(), ipAddress: normalizeIp(req) } },
  );
  return { valid: true, session };
}

module.exports = {
  createRestaurantSession,
  validateRestaurantSession,
  parseUserAgent,
  normalizeIp,
  buildDeviceFingerprint,
  sha256,
  SESSION_DAYS,
};
