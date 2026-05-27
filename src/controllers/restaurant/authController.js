const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const Restaurant = require('../../models/restaurant/Restaurant');
const PendingRestaurantRegistration = require('../../models/restaurant/PendingRestaurantRegistration');
const RestaurantSession = require('../../models/restaurant/RestaurantSession');
const { generateToken, generateOTP } = require('../../utils/generateToken');
const { success, error } = require('../../utils/apiResponse');
const validatePassword = require('../../utils/validatePassword');
const { logger } = require('../../utils/logger');
const {
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendVendorVerificationEmail,
  isEmailConfigured
} = require('../../services/emailService');
const slugify = require('slugify');
const AuditLog = require('../../models/platform/AuditLog');
const notificationService = require('../../services/notificationService');
const resolveRestaurantId = require('../../middleware/restaurant/resolveRestaurantId');
const { ensurePublicRestaurantId } = require('../../services/restaurantPublicIdService');
const {
  createRestaurantSession,
  sha256,
} = require('../../services/restaurantSessionService');
const { mergeFeatureFlags } = require('../../utils/planFeatureHelpers');
const RestaurantReferral = require('../../models/restaurant/RestaurantReferral');
const {
  ensureRestaurantReferralCode,
  findReferrerByCode,
  generateUniqueReferralCode,
  notifyReferralCreated,
  normalizeReferralCode,
} = require('../../services/referralService');
const {
  buildRestaurantAccessSnapshot,
  getTrialDays,
  getTrialLimits,
} = require('../../services/subscriptionAccessService');
const { emitSubscriptionAccessUpdated } = require('../../services/subscriptionRealtimeService');
const {
  getClientIp,
  findActiveLoginLock,
  normalizeEmail: normalizeLoginEmail,
  afterRestaurantLoginFailed,
  lockedResponsePayload,
} = require('../../services/loginSecurityService');
const {
  buildPasswordChangeRecommendation,
} = require('../../services/restaurantPasswordPolicyService');

const TRIAL_DAYS = parseInt(process.env.RESTAURANT_TRIAL_DAYS, 10) || 14;
const VENDOR_VERIFICATION_MINUTES = 10;
const RESET_OTP_MAX_ATTEMPTS = 5;

const hashOTP = (otp) =>
  crypto.createHash('sha256').update(String(otp || '').trim()).digest('hex');

const normalizeEmail = (value) => String(value || '').toLowerCase().trim();
const normalizePhone = (value) => String(value || '').replace(/\D/g, '');
const isEmailIdentifier = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
const isPhoneIdentifier = (value) => normalizePhone(value).length >= 7;

const duplicateKeyMessage = (err) => {
  if (err?.code !== 11000) return null;
  if (err.keyPattern?.phoneNormalized || err.keyValue?.phoneNormalized) return 'Mobile number already registered';
  if (err.keyPattern?.email || err.keyValue?.email) return 'Email already registered';
  if (err.keyPattern?.name || err.keyValue?.name) return 'Restaurant name already taken';
  return 'Duplicate value already exists';
};

async function buildUniqueSlug(name, excludePendingId = null) {
  let slug = slugify(name, { lower: true, strict: true });
  let counter = 1;

  const slugTaken = async (candidate) => {
    const restaurantMatch = await Restaurant.findOne({ slug: candidate }).select('_id');
    if (restaurantMatch) return true;
    const pendingQuery = { slug: candidate };
    if (excludePendingId) pendingQuery._id = { $ne: excludePendingId };
    const pendingMatch = await PendingRestaurantRegistration.findOne(pendingQuery).select('_id');
    return Boolean(pendingMatch);
  };

  while (await slugTaken(slug)) {
    slug = `${slugify(name, { lower: true, strict: true })}-${counter}`;
    counter += 1;
  }
  return slug;
}

async function cleanupLegacyUnverifiedRestaurants({ email, name, phoneNormalized, previousEmail = null }) {
  const emails = [email, previousEmail].filter(Boolean);
  const orConditions = [
    { email: { $in: emails }, emailVerified: false },
    { name, emailVerified: false },
  ];
  if (phoneNormalized) {
    orConditions.push({ phoneNormalized, emailVerified: false });
  }
  await Restaurant.deleteMany({
    isDeleted: { $ne: true },
    $or: orConditions,
  });
}

async function sendRegistrationVerificationEmail(email, otp, name) {
  if (!isEmailConfigured()) {
    logger.warn('Vendor verification OTP for %s (email disabled): %s', email, otp);
  }
  try {
    const mailResult = await sendVendorVerificationEmail(email, otp, name);
    if (!mailResult.success) {
      logger.warn('Vendor verification email failed for %s: %s — OTP: %s', email, mailResult.error || 'unknown', otp);
    }
  } catch (emailError) {
    logger.warn('Vendor verification email threw for %s: %s — OTP: %s', email, emailError.message, otp);
  }
}

const ensureTrialEndDate = async (restaurant) => {
  const days = await getTrialDays();
  const trialEndsAt = new Date(restaurant.createdAt || Date.now());
  trialEndsAt.setDate(trialEndsAt.getDate() + days);
  return trialEndsAt;
};

const createRestaurantAuthPayload = async (restaurant, session, refreshToken) => {
  await ensureRestaurantReferralCode(restaurant);

  const token = generateToken({
    id: restaurant._id,
    email: restaurant.email,
    name: restaurant.name,
    role: 'restaurant',
    scope: 'restaurant',
    sessionId: session?._id,
    deviceId: session?.deviceId,
    tokenVersion: session?.tokenVersion || 1,
  });

  const access = await buildRestaurantAccessSnapshot(restaurant);
  const passwordChangeRecommendation = buildPasswordChangeRecommendation(restaurant);

  return {
    token,
    refreshToken,
    session: session ? {
      id: session._id,
      deviceId: session.deviceId,
      browser: session.browser,
      operatingSystem: session.operatingSystem,
      deviceType: session.deviceType,
      timezone: session.timezone,
      screenResolution: session.screenResolution,
      ipAddress: session.ipAddress,
      loginLocation: session.loginLocation,
      lastActiveAt: session.lastActiveAt,
      tokenVersion: session.tokenVersion,
    } : null,
    user: {
      id: restaurant._id,
      name: restaurant.name,
      email: restaurant.email,
      phone: restaurant.phone,
      address: restaurant.address || '',
      city: restaurant.city || '',
      state: restaurant.state || '',
      pincode: restaurant.pincode || '',
      slug: restaurant.slug,
      logo: restaurant.logo,
      favicon: restaurant.favicon,
      backgroundPhoto: restaurant.backgroundPhoto,
      role: 'restaurant',
      isKYCVerified: restaurant.isKYCVerified,
      currency: restaurant?.settings?.currency || 'Rs.',
      planRequestStatus: restaurant.planRequestStatus,
      currentPlan: restaurant.currentPlan,
      publicRestaurantId: restaurant.publicRestaurantId || null,
      referralCode: restaurant.referralCode || null,
      themeSettings: restaurant?.settings?.themeSettings || {},
      passwordChangeRecommended: passwordChangeRecommendation.recommended,
      mustChangePassword: passwordChangeRecommendation.required,
      passwordChangeRecommendation,
      ...access,
    },
  };
};

const serializeSession = (session, currentSessionId) => ({
  id: session._id,
  deviceId: session.deviceId,
  browser: session.browser,
  operatingSystem: session.operatingSystem,
  deviceType: session.deviceType,
  timezone: session.timezone,
  screenResolution: session.screenResolution,
  ipAddress: session.ipAddress,
  loginLocation: session.loginLocation,
  lastActiveAt: session.lastActiveAt,
  expiresAt: session.expiresAt,
  tokenVersion: session.tokenVersion,
  isCurrent: String(session._id) === String(currentSessionId),
  alerts: session.loginAlerts || {},
});

/**
 * @desc    Register new restaurant
 * @route   POST /api/restaurant/auth/register
 * @access  Public
 */
const register = asyncHandler(async (req, res) => {
  const { name, email, phone, password, address, previousEmail, referralCode } = req.body;
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);
  const normalizedPreviousEmail = previousEmail ? normalizeEmail(previousEmail) : null;
  const normalizedReferralCode = normalizeReferralCode(referralCode);

  if (!name || !email || !phone || !password) {
    return error(res, 'All fields are required', 400);
  }
  if (!isPhoneIdentifier(phone)) {
    return error(res, 'Please enter a valid mobile number', 400);
  }

  const passwordValidation = validatePassword(password);
  if (!passwordValidation.valid) {
    return error(res, passwordValidation.message, 400);
  }

  const verifiedEmail = await Restaurant.findOne({
    email: normalizedEmail,
    emailVerified: true,
    isDeleted: { $ne: true },
  }).select('_id');
  if (verifiedEmail) {
    return error(res, 'Email already registered', 409);
  }

  const verifiedPhone = await Restaurant.findOne({
    $or: [{ phoneNormalized: normalizedPhone }, { phone }],
    isDeleted: { $ne: true },
  }).select('_id');
  if (verifiedPhone) {
    return error(res, 'Mobile number already registered', 409);
  }

  const verifiedName = await Restaurant.findOne({
    name,
    emailVerified: true,
    isDeleted: { $ne: true },
  }).select('_id');
  if (verifiedName) {
    return error(res, 'Restaurant name already taken', 409);
  }

  let referrer = null;
  if (normalizedReferralCode) {
    referrer = await findReferrerByCode(normalizedReferralCode);
    if (!referrer) {
      return error(res, 'Referral code is invalid or inactive', 400);
    }
  }

  await cleanupLegacyUnverifiedRestaurants({
    email: normalizedEmail,
    name,
    phoneNormalized: normalizedPhone,
    previousEmail: normalizedPreviousEmail,
  });

  if (normalizedPreviousEmail && normalizedPreviousEmail !== normalizedEmail) {
    await PendingRestaurantRegistration.deleteOne({ email: normalizedPreviousEmail });
  }

  const pendingPhone = await PendingRestaurantRegistration.findOne({
    $or: [{ phoneNormalized: normalizedPhone }, { phone }],
    email: { $ne: normalizedEmail },
  }).select('_id email');
  if (pendingPhone) {
    return error(res, 'Mobile number is already used in a pending registration', 409);
  }

  const existingPending = await PendingRestaurantRegistration.findOne({ email: normalizedEmail })
    .select('+password +emailVerificationOTP +emailVerificationOTPExpiry');

  const otp = generateOTP();
  const slug = await buildUniqueSlug(name, existingPending?._id);
  const otpExpiry = new Date(Date.now() + VENDOR_VERIFICATION_MINUTES * 60 * 1000);

  if (existingPending) {
    existingPending.name = name;
    existingPending.phone = phone;
    existingPending.phoneNormalized = normalizedPhone;
    existingPending.password = password;
    existingPending.address = address || '';
    existingPending.slug = slug;
    existingPending.referralCode = normalizedReferralCode;
    existingPending.referredByRestaurant = referrer?._id || undefined;
    existingPending.emailVerificationOTP = hashOTP(otp);
    existingPending.emailVerificationOTPExpiry = otpExpiry;
    try {
      await existingPending.save();
    } catch (err) {
      const message = duplicateKeyMessage(err);
      if (message) return error(res, message, 409);
      throw err;
    }
  } else {
    try {
      await PendingRestaurantRegistration.create({
        name,
        email: normalizedEmail,
        phone,
        phoneNormalized: normalizedPhone,
        password,
        address: address || '',
        slug,
        referralCode: normalizedReferralCode,
        referredByRestaurant: referrer?._id,
        emailVerificationOTP: hashOTP(otp),
        emailVerificationOTPExpiry: otpExpiry,
      });
    } catch (err) {
      const message = duplicateKeyMessage(err);
      if (message) return error(res, message, 409);
      throw err;
    }
  }

  await sendRegistrationVerificationEmail(normalizedEmail, otp, name);

  return success(res, {
    email: normalizedEmail,
    requiresVerification: true,
    expiresInMinutes: VENDOR_VERIFICATION_MINUTES,
  }, existingPending ? 'Verification code resent with your updated details.' : 'Verification code sent to your email', existingPending ? 200 : 201);
});

/**
 * @desc    Verify vendor registration email code
 * @route   POST /api/restaurant/auth/verify-registration
 * @access  Public
 */
const verifyRegistration = asyncHandler(async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return error(res, 'Email and verification code are required', 400);
  }

  const normalizedEmail = normalizeEmail(email);
  const pending = await PendingRestaurantRegistration.findOne({ email: normalizedEmail })
    .select('+password +emailVerificationOTP +emailVerificationOTPExpiry');

  if (!pending) {
    return error(res, 'Registration not found or expired. Please register again.', 404);
  }

  if (
    pending.emailVerificationOTP !== hashOTP(otp)
    || !pending.emailVerificationOTPExpiry
    || pending.emailVerificationOTPExpiry < new Date()
  ) {
    return error(res, 'Invalid or expired verification code', 400);
  }

  const verifiedEmail = await Restaurant.findOne({
    email: normalizedEmail,
    emailVerified: true,
    isDeleted: { $ne: true },
  }).select('_id');
  if (verifiedEmail) {
    await PendingRestaurantRegistration.deleteOne({ _id: pending._id });
    return success(res, { verified: true, email: normalizedEmail }, 'Email is already verified');
  }

  const verifiedPhone = await Restaurant.findOne({
    $or: [
      { phoneNormalized: pending.phoneNormalized || normalizePhone(pending.phone) },
      { phone: pending.phone },
    ],
    isDeleted: { $ne: true },
  }).select('_id');
  if (verifiedPhone) {
    return error(res, 'Mobile number already registered. Please edit your details and try again.', 409);
  }

  const verifiedName = await Restaurant.findOne({
    name: pending.name,
    emailVerified: true,
    isDeleted: { $ne: true },
  }).select('_id');
  if (verifiedName) {
    return error(res, 'Restaurant name already taken. Please edit your details and try again.', 409);
  }

  await cleanupLegacyUnverifiedRestaurants({
    email: normalizedEmail,
    name: pending.name,
    phoneNormalized: pending.phoneNormalized || normalizePhone(pending.phone),
  });

  const [trialDays, trialLimits] = await Promise.all([getTrialDays(), getTrialLimits()]);
  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + trialDays);
  const slug = await buildUniqueSlug(pending.name, pending._id);

  let restaurant;
  try {
    restaurant = await Restaurant.create({
      name: pending.name,
      email: pending.email,
      phone: pending.phone,
      phoneNormalized: pending.phoneNormalized || normalizePhone(pending.phone),
      password: pending.password,
      address: pending.address,
      slug,
      emailVerified: true,
      isKYCVerified: false,
      isActive: true,
      trialEndsAt,
      planLimits: trialLimits,
      planRequestStatus: 'none',
      referralCode: await generateUniqueReferralCode(pending.name),
      referredByRestaurant: pending.referredByRestaurant || undefined,
    });
  } catch (err) {
    const message = duplicateKeyMessage(err);
    if (message) return error(res, message, 409);
    throw err;
  }

  await PendingRestaurantRegistration.deleteOne({ _id: pending._id });
  await ensurePublicRestaurantId(restaurant);
  await ensureRestaurantReferralCode(restaurant);

  if (pending.referredByRestaurant) {
    const referrerRestaurant = await Restaurant.findById(pending.referredByRestaurant).select('_id name');
    const referral = await RestaurantReferral.create({
      referrerRestaurant: pending.referredByRestaurant,
      referredRestaurant: restaurant._id,
      referralCode: pending.referralCode,
      status: 'pending',
    });
    if (referrerRestaurant) {
      await notifyReferralCreated({
        referral,
        referrer: referrerRestaurant,
        referred: restaurant,
      });
    }
  }

  try {
    const welcomeResult = await sendWelcomeEmail(restaurant.email, restaurant.name);
    if (!welcomeResult.success) {
      logger.warn('Welcome email failed for %s: %s', restaurant.email, welcomeResult.error || 'unknown');
    }
  } catch (emailError) {
    logger.warn('Welcome email threw: %s', emailError.message);
  }

  return success(res, {
    verified: true,
    email: restaurant.email,
    trialEndsAt: restaurant.trialEndsAt,
    trialDays,
  }, 'Email verified. You can now sign in.');
});

/**
 * @desc    Resend vendor registration verification code
 * @route   POST /api/restaurant/auth/resend-registration-code
 * @access  Public
 */
const resendRegistrationCode = asyncHandler(async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return error(res, 'Email is required', 400);
  }

  const normalizedEmail = normalizeEmail(email);
  const pending = await PendingRestaurantRegistration.findOne({ email: normalizedEmail })
    .select('+emailVerificationOTP +emailVerificationOTPExpiry');

  if (!pending) {
    return error(res, 'Registration not found or expired. Please register again.', 404);
  }

  const otp = generateOTP();
  pending.emailVerificationOTP = hashOTP(otp);
  pending.emailVerificationOTPExpiry = new Date(Date.now() + VENDOR_VERIFICATION_MINUTES * 60 * 1000);
  await pending.save();

  await sendRegistrationVerificationEmail(pending.email, otp, pending.name);

  return success(res, {
    email: pending.email,
    expiresInMinutes: VENDOR_VERIFICATION_MINUTES,
  }, 'Verification code resent. Please check your email.');
});

/**
 * @desc    Check whether a restaurant referral code is valid
 * @route   POST /api/restaurant/auth/check-referral-code
 * @access  Public
 */
const checkReferralCode = asyncHandler(async (req, res) => {
  const referralCode = normalizeReferralCode(req.body?.referralCode);
  if (!referralCode) {
    return error(res, 'Referral code is required', 400);
  }

  const referrer = await findReferrerByCode(referralCode);
  if (!referrer) {
    return error(res, 'Referral code is invalid or inactive', 404);
  }

  return success(
    res,
    {
      valid: true,
      referralCode: referrer.referralCode,
      restaurantName: referrer.name,
    },
    'Referral code is valid',
  );
});

/**
 * @desc    Login restaurant
 * @route   POST /api/restaurant/auth/login
 * @access  Public
 */
const login = asyncHandler(async (req, res) => {
  const { email, identifier, password } = req.body;
  const loginIdentifier = String(identifier || email || '').trim();
  
  if (!loginIdentifier || !password) {
    return error(res, 'Email or mobile number and password are required', 400);
  }

  const normalizedIdentifierEmail = normalizeLoginEmail(loginIdentifier);
  const normalizedIdentifierPhone = normalizePhone(loginIdentifier);
  const clientIp = getClientIp(req);

  const ipLock = await findActiveLoginLock({ ip: clientIp });
  if (ipLock) {
    return error(
      res,
      'Login failed. This connection is temporarily blocked due to suspicious activity.',
      423,
      lockedResponsePayload(ipLock),
    );
  }

  const identityConditions = [];
  if (isEmailIdentifier(loginIdentifier)) {
    identityConditions.push({ email: normalizedIdentifierEmail });
  }
  if (isPhoneIdentifier(loginIdentifier)) {
    identityConditions.push({ phoneNormalized: normalizedIdentifierPhone });
    identityConditions.push({ phone: loginIdentifier });
  }
  if (!identityConditions.length) {
    identityConditions.push({ email: normalizedIdentifierEmail });
  }
  
  const restaurant = await Restaurant.findOne({
    $or: identityConditions,
    isDeleted: false,
  }).select('+password +phoneNormalized');
  if (!restaurant) {
    return error(res, 'Login failed. Invalid email or password.', 401);
  }

  const accountLock = await findActiveLoginLock({ restaurantId: restaurant._id, ip: clientIp });
  if (accountLock) {
    return error(
      res,
      'Your restaurant account is locked. Please contact platform administration to unlock access, or wait until the lock expires.',
      423,
      lockedResponsePayload(accountLock),
    );
  }

  if (restaurant.emailVerified === false) {
    return error(res, 'Please verify your email before signing in.', 403);
  }

  const isMatch = await restaurant.comparePassword(password);
  if (!isMatch) {
    await AuditLog.create({
      user: restaurant._id,
      userModel: 'Restaurant',
      action: 'login_failed',
      resource: 'user',
      resourceId: restaurant._id,
      details: {
        reason: 'wrong_password',
        restaurantId: String(restaurant._id),
        identifier: loginIdentifier,
        email: restaurant.email,
      },
      ipAddress: clientIp || req.ip,
      userAgent: req.get('User-Agent'),
    });

    const lockResult = await afterRestaurantLoginFailed(req, restaurant, restaurant.email || normalizedIdentifierEmail);
    if (lockResult.locked) {
      return error(
        res,
        `Your restaurant account is locked after ${lockResult.failedAttempts || lockResult.maxAttempts} failed login attempts. Please contact platform administration to unlock your access.`,
        423,
        lockedResponsePayload(
          { lockedUntil: lockResult.lockedUntil, reason: lockResult.reason },
          {
            attemptsRemaining: 0,
            failedAttempts: lockResult.failedAttempts,
            maxAttempts: lockResult.maxAttempts,
          },
        ),
      );
    }

    const remaining = lockResult.attemptsRemaining ?? 0;
    const failed = lockResult.failedAttempts ?? 0;
    const max = lockResult.maxAttempts ?? 5;
    return error(
      res,
      `Incorrect password. ${failed} of ${max} failed attempt${failed === 1 ? '' : 's'} — ${remaining} remaining before your account is locked.`,
      401,
      {
        code: 'LOGIN_FAILED',
        attemptsRemaining: remaining,
        failedAttempts: failed,
        maxAttempts: max,
      },
    );
  }
  
  if (!restaurant.isActive) {
    return error(res, 'Your account is inactive. Please contact support.', 403);
  }

  let shouldSave = false;
  if (!restaurant.trialEndsAt) {
    const [trialEndsAt, trialLimits] = await Promise.all([
      ensureTrialEndDate(restaurant),
      getTrialLimits(),
    ]);
    restaurant.trialEndsAt = trialEndsAt;
    restaurant.planLimits = trialLimits;
    shouldSave = true;
  }
  if (
    restaurant.requestedPlan &&
    restaurant.planRequestStatus !== 'awaiting_proof' &&
    restaurant.planRequestStatus !== 'pending_review'
  ) {
    restaurant.planRequestStatus = 'pending_review';
    shouldSave = true;
  }
  if (shouldSave) {
    await restaurant.save();
  }

  restaurant.successfulLoginCount = Number(restaurant.successfulLoginCount || 0) + 1;
  restaurant.lastLoginAt = new Date();
  await restaurant.save();

  await ensurePublicRestaurantId(restaurant);
  await restaurant.populate('currentPlan', 'name');

  await AuditLog.create({
    user: restaurant._id,
    userModel: 'Restaurant',
    action: 'login',
    resource: 'user',
    resourceId: restaurant._id,
    details: {
      restaurantId: String(restaurant._id)
    },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent')
  });

  await notificationService.sendNotification({
    recipientType: 'restaurant',
    recipientId: restaurant._id,
    type: 'auth_login',
    category: 'auth',
    priority: 'low',
    title: 'Login successful',
    message: `You signed in successfully at ${new Date().toLocaleString()}.`,
    metadata: { ipAddress: req.ip },
    actionUrl: '/notifications',
  });
  
  const { session, refreshToken } = await createRestaurantSession(req, restaurant);

  const payload = await createRestaurantAuthPayload(restaurant, session, refreshToken);
  return success(res, payload, 'Login successful');
});

/**
 * @desc    Restaurant logout
 * @route   POST /api/restaurant/auth/logout
 * @access  Private
 */
const logout = asyncHandler(async (req, res) => {
  if (req.user.sessionId) {
    await RestaurantSession.updateOne(
      { _id: req.user.sessionId, restaurantId: req.user.id },
      {
        $set: {
          revokedAt: new Date(),
          revokedReason: 'logout',
          refreshTokenBlacklistedAt: new Date(),
        },
      },
    );
  }
  await AuditLog.create({
    user: req.user.id,
    userModel: 'Restaurant',
    action: 'logout',
    resource: 'user',
    resourceId: req.user.id,
    details: {
      restaurantId: String(req.user.id)
    },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent')
  });
  return success(res, null, 'Logout successful');
});

const refreshToken = asyncHandler(async (req, res) => {
  const { refreshToken: incomingRefreshToken, sessionId } = req.body || {};
  if (!incomingRefreshToken || !sessionId) {
    return error(res, 'Refresh token and session are required', 400);
  }

  const session = await RestaurantSession.findOne({
    _id: sessionId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  }).select('+refreshTokenHash');

  if (
    !session ||
    session.refreshTokenBlacklistedAt ||
    session.refreshTokenHash !== sha256(incomingRefreshToken)
  ) {
    return error(res, 'Refresh token is invalid or revoked', 401);
  }

  const restaurant = await Restaurant.findOne({
    _id: session.restaurantId,
    isActive: true,
    isDeleted: false,
  });
  if (!restaurant) return error(res, 'Account disabled or token invalid', 401);

  await restaurant.populate('currentPlan', 'name');

  session.tokenVersion += 1;
  session.lastActiveAt = new Date();
  const nextRefreshToken = crypto.randomBytes(48).toString('hex');
  session.refreshTokenHash = sha256(nextRefreshToken);
  await session.save();

  const payload = await createRestaurantAuthPayload(restaurant, session, nextRefreshToken);
  return success(res, payload, 'Session refreshed');
});

const getSessions = asyncHandler(async (req, res) => {
  const sessions = await RestaurantSession.find({
    restaurantId: req.user.id,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  }).sort({ lastActiveAt: -1 }).lean();

  return success(
    res,
    sessions.map((session) => serializeSession(session, req.user.sessionId)),
    'Active sessions retrieved',
  );
});

const getLoginHistory = asyncHandler(async (req, res) => {
  const sessions = await RestaurantSession.find({ restaurantId: req.user.id })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  return success(
    res,
    sessions.map((session) => ({
      ...serializeSession(session, req.user.sessionId),
      revokedAt: session.revokedAt,
      revokedReason: session.revokedReason,
      createdAt: session.createdAt,
    })),
    'Login history retrieved',
  );
});

const revokeSession = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  if (!sessionId) return error(res, 'Session id is required', 400);
  if (String(sessionId) === String(req.user.sessionId)) {
    return error(res, 'Use logout to revoke your current session', 400);
  }

  const result = await RestaurantSession.updateOne(
    { _id: sessionId, restaurantId: req.user.id, revokedAt: null },
    {
      $set: {
        revokedAt: new Date(),
        revokedReason: 'revoked_by_user',
        refreshTokenBlacklistedAt: new Date(),
      },
      $inc: { tokenVersion: 1 },
    },
  );
  if (!result.matchedCount) return error(res, 'Session not found', 404);
  return success(res, null, 'Session revoked');
});

const revokeOtherSessions = asyncHandler(async (req, res) => {
  const result = await RestaurantSession.updateMany(
    {
      restaurantId: req.user.id,
      _id: { $ne: req.user.sessionId },
      revokedAt: null,
    },
    {
      $set: {
        revokedAt: new Date(),
        revokedReason: 'force_logout_other_devices',
        refreshTokenBlacklistedAt: new Date(),
      },
      $inc: { tokenVersion: 1 },
    },
  );
  return success(res, { revokedCount: result.modifiedCount || 0 }, 'Other devices logged out');
});

const updateCurrentSessionLocation = asyncHandler(async (req, res) => {
  if (!req.user.sessionId) return error(res, 'Current session not found', 404);

  const latitude = Number(req.body?.latitude);
  const longitude = Number(req.body?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return error(res, 'Latitude and longitude are required', 400);
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return error(res, 'Invalid latitude or longitude', 400);
  }

  const loginLocation = {
    city: String(req.body?.city || '').slice(0, 80),
    region: String(req.body?.region || '').slice(0, 80),
    country: String(req.body?.country || '').slice(0, 80),
    latitude,
    longitude,
    source: 'browser',
  };

  const session = await RestaurantSession.findOneAndUpdate(
    {
      _id: req.user.sessionId,
      restaurantId: req.user.id,
      revokedAt: null,
    },
    {
      $set: {
        loginLocation,
        lastActiveAt: new Date(),
      },
    },
    { new: true },
  ).lean();

  if (!session) return error(res, 'Session not found', 404);
  return success(res, serializeSession(session, req.user.sessionId), 'Session location updated');
});

/**
 * @desc    Forgot password - send OTP
 * @route   POST /api/restaurant/auth/forgot-password
 * @access  Public
 */
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  
  if (!email) {
    return error(res, 'Email is required', 400);
  }

  const normalizedEmail = String(email).toLowerCase().trim();
  const restaurant = await Restaurant.findOne({ email: normalizedEmail, isDeleted: false });

  if (!restaurant) {
    return error(res, 'This email does not exist. Kindly enter your valid email.', 404);
  }

  if (restaurant.emailVerified === false) {
    return error(res, 'This email is not verified. Please verify your email before resetting your password.', 403);
  }
  
  const otp = generateOTP();
  
  restaurant.resetOTP = hashOTP(otp);
  restaurant.resetOTPExpiry = new Date(Date.now() + 10 * 60 * 1000);
  restaurant.resetOTPAttempts = 0;
  await restaurant.save();
  
  try {
    const resetResult = await sendPasswordResetEmail(email, otp, restaurant.name);
    if (!resetResult.success) {
      logger.warn(
        'Password reset email failed for %s: %s — OTP (dev fallback): %s',
        email,
        resetResult.error || 'unknown',
        otp
      );
    }
  } catch (emailError) {
    logger.warn('Password reset email threw for %s: %s — OTP: %s', email, emailError.message, otp);
  }

  return success(res, { otpSent: true }, 'Reset code sent to your email');
});

/**
 * @desc    Validate password reset OTP before showing password fields
 * @route   POST /api/restaurant/auth/validate-reset-code
 * @access  Public
 */
const validateResetCode = asyncHandler(async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return error(res, 'Email and OTP are required', 400);
  }

  const restaurant = await Restaurant.findOne({ email: String(email).toLowerCase().trim(), isDeleted: false })
    .select('+resetOTP +resetOTPExpiry +resetOTPAttempts');
  if (!restaurant) {
    return error(res, 'This email does not exist. Kindly enter your valid email.', 404);
  }

  if (restaurant.emailVerified === false) {
    return error(res, 'This email is not verified. Please verify your email before resetting your password.', 403);
  }

  if (
    restaurant.resetOTP !== hashOTP(otp) ||
    !restaurant.resetOTPExpiry ||
    restaurant.resetOTPExpiry < new Date() ||
    Number(restaurant.resetOTPAttempts || 0) >= RESET_OTP_MAX_ATTEMPTS
  ) {
    restaurant.resetOTPAttempts = Number(restaurant.resetOTPAttempts || 0) + 1;
    await restaurant.save();
    return error(res, 'Invalid or expired OTP', 400);
  }

  return success(res, { codeValid: true }, 'Code verified');
});

/**
 * @desc    Reset password with OTP
 * @route   POST /api/restaurant/auth/reset-password
 * @access  Public
 */
const resetPassword = asyncHandler(async (req, res) => {
  const { email, otp, newPassword } = req.body;
  
  if (!email || !otp || !newPassword) {
    return error(res, 'Email, OTP and new password are required', 400);
  }
  
  const restaurant = await Restaurant.findOne({ email: String(email).toLowerCase().trim(), isDeleted: false })
    .select('+resetOTP +resetOTPExpiry +resetOTPAttempts');
  if (!restaurant) {
    return error(res, 'This email does not exist. Kindly enter your valid email.', 404);
  }

  if (restaurant.emailVerified === false) {
    return error(res, 'This email is not verified. Please verify your email before resetting your password.', 403);
  }
  
  if (
    restaurant.resetOTP !== hashOTP(otp) ||
    !restaurant.resetOTPExpiry ||
    restaurant.resetOTPExpiry < new Date() ||
    Number(restaurant.resetOTPAttempts || 0) >= RESET_OTP_MAX_ATTEMPTS
  ) {
    restaurant.resetOTPAttempts = Number(restaurant.resetOTPAttempts || 0) + 1;
    await restaurant.save();
    return error(res, 'Invalid or expired OTP', 400);
  }
  
  const passwordValidation = validatePassword(newPassword);
  if (!passwordValidation.valid) {
    return error(res, passwordValidation.message, 400);
  }
  
  restaurant.password = newPassword;
  restaurant.resetOTP = undefined;
  restaurant.resetOTPExpiry = undefined;
  restaurant.resetOTPAttempts = 0;
  await restaurant.save();
  
  return success(res, null, 'Password reset successful');
});

/**
 * @desc    Get restaurant profile
 * @route   GET /api/restaurant/auth/profile
 * @access  Private
 */
const getProfile = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) {
    return error(res, 'Unable to resolve restaurant', 403);
  }
  const restaurant = await Restaurant.findById(rid).select('-password');
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }
  await ensureRestaurantReferralCode(restaurant);
  return success(res, restaurant, 'Profile retrieved');
});

/**
 * @desc    Update restaurant profile
 * @route   PUT /api/restaurant/auth/profile
 * @access  Private
 */
const updateProfile = asyncHandler(async (req, res) => {
  const targetRestaurantId = resolveRestaurantId(req);
  if (!targetRestaurantId) {
    return error(res, 'Unable to resolve restaurant', 403);
  }
  const {
    name,
    phone,
    address,
    city,
    state,
    district,
    localLevel,
    pincode,
    country,
    currency,
    timezone,
    description,
    openingTime,
    closingTime,
    feedbackEnabled,
    showFeedbackOnLanding,
    loyalty,
    about,
    privacyPolicy,
    themeSettings,
  } = req.body;
  const updates = {};

  /**
   * Treat the literal strings "undefined" / "null" as empty. FormData
   * serialises JS undefined/null to those strings, so unguarded `if (value)`
   * checks would happily persist `"undefined"` to MongoDB.
   */
  const cleanScalar = (value) => {
    if (value == null) return undefined;
    const str = typeof value === 'string' ? value.trim() : String(value);
    const lower = str.toLowerCase();
    if (!str || lower === 'undefined' || lower === 'null') return undefined;
    return str;
  };
  const cleanedPhone = cleanScalar(phone);
  const cleanedAddress = cleanScalar(address);
  const cleanedCity = cleanScalar(city);
  const cleanedState = cleanScalar(state);
  const cleanedDistrict = cleanScalar(district);
  const cleanedLocalLevel = cleanScalar(localLevel);
  const cleanedPincode = cleanScalar(pincode);
  const cleanedCountry = cleanScalar(country);
  const cleanedCurrency = cleanScalar(currency);
  const cleanedTimezone = cleanScalar(timezone);
  const cleanedDescription = cleanScalar(description);
  const cleanedOpeningTime = cleanScalar(openingTime);
  const cleanedClosingTime = cleanScalar(closingTime);
  if (cleanedPhone) {
    const normalizedProfilePhone = normalizePhone(cleanedPhone);
    if (!isPhoneIdentifier(cleanedPhone)) {
      return error(res, 'Please enter a valid mobile number', 400);
    }
    const phoneOwner = await Restaurant.findOne({
      _id: { $ne: targetRestaurantId },
      $or: [{ phoneNormalized: normalizedProfilePhone }, { phone: cleanedPhone }],
      isDeleted: { $ne: true },
    }).select('_id');
    if (phoneOwner) {
      return error(res, 'Mobile number already registered', 409);
    }
    updates.phone = cleanedPhone;
    updates.phoneNormalized = normalizedProfilePhone;
  }
  if (cleanedAddress) updates.address = cleanedAddress;
  if (cleanedCity) updates.city = cleanedCity;
  if (cleanedState) updates.state = cleanedState;
  if (cleanedDistrict) updates.district = cleanedDistrict;
  if (cleanedLocalLevel) updates.localLevel = cleanedLocalLevel;
  if (pincode !== undefined && pincode !== null) {
    updates.pincode = cleanScalar(pincode) || '';
  }
  if (cleanedCountry) updates.country = cleanedCountry;
  if (cleanedCurrency) updates['settings.currency'] = cleanedCurrency.slice(0, 12);
  if (cleanedTimezone) updates['settings.timezone'] = cleanedTimezone.slice(0, 80);
  if (cleanedDescription) updates.description = cleanedDescription;
  if (cleanedOpeningTime) updates.openingTime = cleanedOpeningTime;
  if (cleanedClosingTime) updates.closingTime = cleanedClosingTime;
  if (typeof feedbackEnabled !== 'undefined') updates['settings.feedbackEnabled'] = feedbackEnabled === true || feedbackEnabled === 'true';
  if (typeof showFeedbackOnLanding !== 'undefined') updates['settings.showFeedbackOnLanding'] = showFeedbackOnLanding === true || showFeedbackOnLanding === 'true';

  // FormData sends nested objects as JSON strings — accept either shape.
  const parseMaybeJson = (value) => {
    if (value == null) return undefined;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return undefined;
      try { return JSON.parse(trimmed); } catch { return undefined; }
    }
    return value;
  };

  const loyaltyPayload = parseMaybeJson(loyalty);
  if (loyaltyPayload && typeof loyaltyPayload === 'object') {
    if (typeof loyaltyPayload.enabled !== 'undefined') {
      updates['settings.loyalty.enabled'] = loyaltyPayload.enabled === true || loyaltyPayload.enabled === 'true';
    }
    if (loyaltyPayload.pointsPerCurrencyUnit != null) {
      updates['settings.loyalty.pointsPerCurrencyUnit'] = Math.max(1, Number(loyaltyPayload.pointsPerCurrencyUnit) || 50);
    }
    if (loyaltyPayload.minPointsPerOrder != null) {
      updates['settings.loyalty.minPointsPerOrder'] = Math.max(0, Number(loyaltyPayload.minPointsPerOrder) || 0);
    }
    if (loyaltyPayload.minOrderAmount != null) {
      updates['settings.loyalty.minOrderAmount'] = Math.max(0, Number(loyaltyPayload.minOrderAmount) || 0);
    }
    if (typeof loyaltyPayload.smsOnOrderReady !== 'undefined') {
      updates['settings.loyalty.smsOnOrderReady'] = loyaltyPayload.smsOnOrderReady === true || loyaltyPayload.smsOnOrderReady === 'true';
    }
  }

  const aboutPayload = parseMaybeJson(about);
  if (aboutPayload && typeof aboutPayload === 'object') {
    const toStr = (v) => (v == null ? '' : String(v));
    const sanitizedAbout = {
      tagline: toStr(aboutPayload.tagline).slice(0, 200),
      aboutText: toStr(aboutPayload.aboutText).slice(0, 4000),
      cuisine: toStr(aboutPayload.cuisine).slice(0, 120),
      priceRange: toStr(aboutPayload.priceRange).slice(0, 32),
      establishedYear: Number(aboutPayload.establishedYear) || undefined,
      rating: Number.isFinite(Number(aboutPayload.rating)) ? Number(aboutPayload.rating) : undefined,
      reviewCount: Number.isFinite(Number(aboutPayload.reviewCount)) ? Number(aboutPayload.reviewCount) : undefined,
      features: Array.isArray(aboutPayload.features)
        ? aboutPayload.features
            .filter((f) => f && (f.label || f.name))
            .slice(0, 8)
            .map((f) => ({
              icon: toStr(f.icon || 'Utensils').slice(0, 40) || 'Utensils',
              label: toStr(f.label || f.name).slice(0, 60),
            }))
        : undefined,
      gallery: Array.isArray(aboutPayload.gallery)
        ? aboutPayload.gallery.map((u) => toStr(u).trim()).filter(Boolean).slice(0, 12)
        : undefined,
      hours: aboutPayload.hours && typeof aboutPayload.hours === 'object'
        ? {
            monday: toStr(aboutPayload.hours.monday).slice(0, 60),
            tuesday: toStr(aboutPayload.hours.tuesday).slice(0, 60),
            wednesday: toStr(aboutPayload.hours.wednesday).slice(0, 60),
            thursday: toStr(aboutPayload.hours.thursday).slice(0, 60),
            friday: toStr(aboutPayload.hours.friday).slice(0, 60),
            saturday: toStr(aboutPayload.hours.saturday).slice(0, 60),
            sunday: toStr(aboutPayload.hours.sunday).slice(0, 60),
          }
        : undefined,
      socials: aboutPayload.socials && typeof aboutPayload.socials === 'object'
        ? {
            website: toStr(aboutPayload.socials.website).slice(0, 240),
            facebook: toStr(aboutPayload.socials.facebook).slice(0, 240),
            instagram: toStr(aboutPayload.socials.instagram).slice(0, 240),
            twitter: toStr(aboutPayload.socials.twitter).slice(0, 240),
          }
        : undefined,
    };
    Object.entries(sanitizedAbout).forEach(([key, value]) => {
      if (typeof value === 'undefined') return;
      updates[`about.${key}`] = value;
    });
  }

  const privacyPayload = parseMaybeJson(privacyPolicy);
  if (privacyPayload && typeof privacyPayload === 'object') {
    const toStr = (v) => (v == null ? '' : String(v));
    if (typeof privacyPayload.enabled !== 'undefined') {
      updates['privacyPolicy.enabled'] = privacyPayload.enabled === true || privacyPayload.enabled === 'true';
    }
    if (Array.isArray(privacyPayload.sections)) {
      updates['privacyPolicy.sections'] = privacyPayload.sections
        .filter((s) => s && s.title)
        .slice(0, 30)
        .map((s) => ({
          title: toStr(s.title).slice(0, 120),
          content: toStr(s.content).slice(0, 8000),
        }));
    }
    if (typeof privacyPayload.contactEmail !== 'undefined') {
      updates['privacyPolicy.contactEmail'] = toStr(privacyPayload.contactEmail).slice(0, 160);
    }
    if (typeof privacyPayload.contactPhone !== 'undefined') {
      updates['privacyPolicy.contactPhone'] = toStr(privacyPayload.contactPhone).slice(0, 60);
    }
    if (typeof privacyPayload.contactAddress !== 'undefined') {
      updates['privacyPolicy.contactAddress'] = toStr(privacyPayload.contactAddress).slice(0, 400);
    }
    updates['privacyPolicy.lastUpdated'] = new Date();
  }

  const themePayload = parseMaybeJson(themeSettings);
  if (themePayload && typeof themePayload === 'object') {
    const validThemes = new Set([
      'royal_brown',
      'modern_blue',
      'emerald_green',
      'luxury_black_gold',
      'elegant_purple',
      'sunset_orange',
    ]);
    const validModes = new Set(['light', 'dark', 'system']);
    const validFonts = new Set([
      'Inter, system-ui, sans-serif',
      'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      'Arial, Helvetica, sans-serif',
      'Helvetica, Arial, sans-serif',
      'Roboto, Inter, system-ui, sans-serif',
      '"Open Sans", Inter, system-ui, sans-serif',
      'Lato, Inter, system-ui, sans-serif',
      'Poppins, Inter, system-ui, sans-serif',
      '"DM Sans", Inter, system-ui, sans-serif',
      'Montserrat, Inter, system-ui, sans-serif',
      'Nunito, Inter, system-ui, sans-serif',
      'Raleway, Inter, system-ui, sans-serif',
      'Ubuntu, Inter, system-ui, sans-serif',
      'Merriweather, Georgia, serif',
      'Georgia, "Times New Roman", serif',
      '"Times New Roman", Times, serif',
      '"Playfair Display", Georgia, serif',
      '"Courier New", Courier, monospace',
      '"Fira Code", "Courier New", monospace',
    ]);
    const isHex = (value) => /^#[0-9a-fA-F]{6}$/.test(String(value || ''));
    const toBool = (value) => value === true || value === 'true';

    if (validThemes.has(themePayload.activeTheme)) {
      updates['settings.themeSettings.activeTheme'] = themePayload.activeTheme;
    }
    if (validModes.has(themePayload.mode)) {
      updates['settings.themeSettings.mode'] = themePayload.mode;
      updates['settings.themeSettings.darkMode'] = themePayload.mode === 'dark';
    } else if (typeof themePayload.darkMode !== 'undefined') {
      updates['settings.themeSettings.darkMode'] = toBool(themePayload.darkMode);
      updates['settings.themeSettings.mode'] = toBool(themePayload.darkMode) ? 'dark' : 'light';
    }
    if (validFonts.has(themePayload.fontFamily)) {
      updates['settings.themeSettings.fontFamily'] = themePayload.fontFamily;
    }
    if (typeof themePayload.branchOverridesEnabled !== 'undefined') {
      updates['settings.themeSettings.branchOverridesEnabled'] = toBool(themePayload.branchOverridesEnabled);
    }
    if (typeof themePayload.allowCustomThemes !== 'undefined') {
      updates['settings.themeSettings.allowCustomThemes'] = toBool(themePayload.allowCustomThemes);
    }
    if (themePayload.customPalette && typeof themePayload.customPalette === 'object') {
      const allowedPaletteKeys = ['primary', 'secondary', 'accent', 'attention', 'surface', 'background', 'text'];
      const sanitizedPalette = {};
      allowedPaletteKeys.forEach((key) => {
        if (isHex(themePayload.customPalette[key])) sanitizedPalette[key] = themePayload.customPalette[key];
      });
      updates['settings.themeSettings.customPalette'] = sanitizedPalette;
    }
    if (themePayload.branding && typeof themePayload.branding === 'object') {
      const currentBranding = {};
      ['logo', 'favicon', 'backgroundImage'].forEach((key) => {
        if (typeof themePayload.branding[key] === 'string') {
          currentBranding[key] = themePayload.branding[key].slice(0, 500);
        }
      });
      Object.entries(currentBranding).forEach(([key, value]) => {
        updates[`settings.themeSettings.branding.${key}`] = value;
      });
    }
  }

  if (req.files) {
    if (req.files.logo) updates.logo = req.files.logo[0].path;
    if (req.files.backgroundPhoto) updates.backgroundPhoto = req.files.backgroundPhoto[0].path;
    if (req.files.favicon) updates.favicon = req.files.favicon[0].path;
    if (req.files.brandBackgroundImage) updates.brandBackgroundImage = req.files.brandBackgroundImage[0].path;
  } else if (req.file) {
    updates.logo = req.file.path;
  }

  if (updates.logo) updates['settings.themeSettings.branding.logo'] = updates.logo;
  if (updates.favicon) updates['settings.themeSettings.branding.favicon'] = updates.favicon;
  if (updates.brandBackgroundImage || updates.backgroundPhoto) {
    updates['settings.themeSettings.branding.backgroundImage'] = updates.brandBackgroundImage || updates.backgroundPhoto;
  }

  const restaurant = await Restaurant.findByIdAndUpdate(
    targetRestaurantId,
    { $set: updates },
    { new: true, runValidators: true },
  ).select('-password');

  return success(res, restaurant, 'Profile updated successfully');
});

/**
 * @desc    Change password
 * @route   POST /api/restaurant/auth/change-password
 * @access  Private
 */
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  
  const restaurant = await Restaurant.findById(req.user.id).select('+password');
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }
  
  const isMatch = await restaurant.comparePassword(currentPassword);
  if (!isMatch) {
    return error(res, 'Current password is incorrect', 400);
  }
  
  const passwordValidation = validatePassword(newPassword);
  if (!passwordValidation.valid) {
    return error(res, passwordValidation.message, 400);
  }
  
  restaurant.password = newPassword;
  await restaurant.save();
  
  return success(res, null, 'Password changed successfully');
});

/**
 * @desc    Verify restaurant password for sensitive actions (e.g. branch switch)
 * @route   POST /api/restaurant/auth/verify-password
 * @access  Private (Restaurant)
 */
const verifyPassword = asyncHandler(async (req, res) => {
  const { password } = req.body || {};
  if (!password) {
    return error(res, 'Password is required', 400);
  }

  const restaurant = await Restaurant.findById(req.user.id).select('+password');
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }

  const isMatch = await restaurant.comparePassword(password);
  if (!isMatch) {
    // Keep this as a validation failure (not auth/session failure),
    // otherwise frontend 401 interceptor logs the user out.
    return error(res, 'Incorrect password', 400, { code: 'PASSWORD_INCORRECT' });
  }

  return success(res, { verified: true }, 'Password verified');
});

/**
 * @desc    Refresh subscription/trial access flags for the current session (also used after realtime events).
 * @route   GET /api/restaurant/auth/access
 * @access  Private (restaurant owner)
 */
const getAccessSession = asyncHandler(async (req, res) => {
  const restaurant = await Restaurant.findById(req.user.id).populate('currentPlan', 'name');
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }
  const access = await buildRestaurantAccessSnapshot(restaurant);
  return success(res, access, 'Access session retrieved');
});

/**
 * @desc    Mark trial welcome modal as seen (first login after registration).
 * @route   POST /api/restaurant/auth/dismiss-trial-welcome
 * @access  Private (restaurant owner)
 */
const dismissTrialWelcome = asyncHandler(async (req, res) => {
  const restaurant = await Restaurant.findById(req.user.id);
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }
  if (!restaurant.hasSeenTrialWelcome) {
    restaurant.hasSeenTrialWelcome = true;
    await restaurant.save();
    await emitSubscriptionAccessUpdated(restaurant._id);
  }
  return success(res, { dismissed: true }, 'Trial welcome dismissed');
});

const getPublicLoginPolicy = asyncHandler(async (req, res) => {
  const { getLoginSecurityPolicy } = require('../../services/loginSecurityPolicyService');
  const policy = await getLoginSecurityPolicy('restaurant');
  return success(
    res,
    {
      maxAttempts: policy.maxFailures,
      windowMinutes: policy.windowMinutes,
      lockMinutes: policy.lockMinutes,
    },
    'Login policy retrieved',
  );
});

module.exports = {
  register,
  verifyRegistration,
  resendRegistrationCode,
  checkReferralCode,
  login,
  logout,
  refreshToken,
  getSessions,
  getLoginHistory,
  revokeSession,
  revokeOtherSessions,
  updateCurrentSessionLocation,
  forgotPassword,
  validateResetCode,
  resetPassword,
  getProfile,
  updateProfile,
  changePassword,
  verifyPassword,
  getAccessSession,
  dismissTrialWelcome,
  getPublicLoginPolicy,
};
