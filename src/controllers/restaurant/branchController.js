const asyncHandler = require('express-async-handler');
const Branch = require('../../models/restaurant/Branch');
const BranchAuth = require('../../models/restaurant/BranchAuth');
const BranchSession = require('../../models/restaurant/BranchSession');
const Employee = require('../../models/restaurant/Employee');
const CustomerOrder = require('../../models/restaurant/CustomerOrder');
const Expense = require('../../models/restaurant/Expense');
const InventoryItem = require('../../models/restaurant/InventoryItem');
const SalesReport = require('../../models/restaurant/SalesReport');
const AuditLog = require('../../models/platform/AuditLog');
const { success, error } = require('../../utils/apiResponse');
const { buildUniqueBranchSlug, ensureDefaultBranch, ensureBranchPortalKey, normalizeObjectId } = require('../../services/branchService');
const {
  generateSecurePassword,
  buildUniquePublicBranchId,
  hashPassword,
  allocateUniqueBranchEmail,
} = require('../../services/branchAuthService');
const { mergeEnabledModules, allEnabledModules } = require('../../constants/branchModules');
const { generateOTP, jwtOptions } = require('../../utils/generateToken');
const Restaurant = require('../../models/restaurant/Restaurant');
const BranchOwnerOtp = require('../../models/restaurant/BranchOwnerOtp');
const { ensurePublicRestaurantId } = require('../../services/restaurantPublicIdService');
const {
  sendBranchOwnerOtpEmail,
  sendBranchOwnerWelcomeEmail,
  isEmailConfigured,
} = require('../../services/emailService');
const { logger } = require('../../utils/logger');
const jwt = require('jsonwebtoken');
const slugify = require('slugify');
const { JWT_SECRET, JWT_ALGORITHM, JWT_ISSUER, JWT_AUDIENCE } = require('../../config/env');
const { readNumber, readSearchRegex, readString } = require('../../utils/inputValidation');

const OWNER_VERIFY_JWT_EXP = '30m';

function restaurantIdFromReq(req) {
  return normalizeObjectId(req.user?.restaurantId || req.user?.id);
}

function writableFields(body) {
  const allowed = [
    'name', 'phone', 'email', 'address', 'city', 'state', 'country', 'latitude', 'longitude',
    'openingHours', 'branchManager', 'branchManagerName', 'taxNumber', 'status', 'logo', 'banner', 'settings',
    'enabledModules', 'subscriptionLimits', 'ownerEmail',
  ];
  return allowed.reduce((acc, key) => {
    if (body[key] !== undefined) acc[key] = body[key];
    return acc;
  }, {});
}

function suggestBranchUsername(branchSlug) {
  const base = String(branchSlug || 'branch').replace(/[^a-z0-9]+/gi, '_').toLowerCase().replace(/^_|_$/g, '') || 'branch'
  return `${base.slice(0, 24)}_admin`
}

function parseMaybeJson(value) {
  if (value == null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    try { return JSON.parse(trimmed); } catch { return undefined; }
  }
  return value;
}

function cleanScalar(value, max = 500) {
  if (value == null) return undefined;
  const str = String(value).trim();
  const lower = str.toLowerCase();
  if (!str || lower === 'undefined' || lower === 'null') return undefined;
  return str.slice(0, max);
}

async function resolveRequestedBranchSlug({ restaurant, name, requestedSlug, existingBranchId = null }) {
  const rawSlug = cleanScalar(requestedSlug, 140);
  if (!rawSlug) return buildUniqueBranchSlug(restaurant, name);

  const slug = slugify(rawSlug, { lower: true, strict: true });
  if (!slug) return buildUniqueBranchSlug(restaurant, name);

  const conflict = await Branch.exists({
    slug,
    ...(existingBranchId ? { _id: { $ne: existingBranchId } } : {}),
  });
  if (conflict) {
    const err = new Error('Branch slug already exists. Choose another branch URL slug.');
    err.statusCode = 409;
    throw err;
  }
  return slug;
}

function isDuplicateKeyError(err, key) {
  return err?.code === 11000 && (!key || Object.prototype.hasOwnProperty.call(err?.keyPattern || {}, key));
}

function sanitizeBranchThemeSettings(themePayload) {
  if (!themePayload || typeof themePayload !== 'object') return undefined;
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
  const out = {};
  if (validThemes.has(themePayload.activeTheme)) out.activeTheme = themePayload.activeTheme;
  if (validModes.has(themePayload.mode)) out.mode = themePayload.mode;
  if (validFonts.has(themePayload.fontFamily)) out.fontFamily = themePayload.fontFamily;
  if (themePayload.customPalette && typeof themePayload.customPalette === 'object') {
    const palette = {};
    ['primary', 'secondary', 'accent', 'attention', 'surface', 'background', 'text'].forEach((key) => {
      if (isHex(themePayload.customPalette[key])) palette[key] = themePayload.customPalette[key];
    });
    out.customPalette = palette;
  }
  if (themePayload.branding && typeof themePayload.branding === 'object') {
    out.branding = {};
    ['logo', 'favicon', 'backgroundImage'].forEach((key) => {
      if (typeof themePayload.branding[key] === 'string') out.branding[key] = themePayload.branding[key].slice(0, 500);
    });
  }
  return out;
}

const OWNER_OTP_MINUTES = 10

function isGmailOwnedAddress(email) {
  const e = String(email || '').trim().toLowerCase()
  return e.endsWith('@gmail.com') || e.endsWith('@googlemail.com')
}

const requestBranchOwnerOtp = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  if (!restaurantId) return error(res, 'Unable to resolve restaurant', 403);
  if (req.user?.scope === 'employee') return error(res, 'Forbidden', 403);

  const ownerEmail = String(req.body.ownerEmail || '').trim().toLowerCase();
  if (!ownerEmail) return error(res, 'Branch owner Gmail is required', 400);
  if (!isGmailOwnedAddress(ownerEmail)) {
    return error(res, 'Branch owner email must be a Gmail address (@gmail.com).', 400);
  }

  const restaurant = await Restaurant.findById(restaurantId).select('name');
  if (!restaurant) return error(res, 'Restaurant not found', 404);

  const otp = generateOTP();
  const expiresAt = new Date(Date.now() + OWNER_OTP_MINUTES * 60 * 1000);
  await BranchOwnerOtp.findOneAndUpdate(
    { restaurantId, ownerEmail },
    { $set: { otp, expiresAt } },
    { upsert: true, new: true },
  );

  if (!isEmailConfigured()) {
    logger.warn('Branch owner OTP for %s (SMTP not configured): %s', ownerEmail, otp);
    const isDev = (process.env.NODE_ENV || 'development') === 'development';
    if (isDev) {
      return success(
        res,
        {
          expiresInMinutes: OWNER_OTP_MINUTES,
          emailSent: false,
          devOtp: otp,
        },
        'SMTP is not configured. Use the development code below (development only).',
      );
    }
    return error(
      res,
      'Outgoing email is not configured on this server (set SMTP_USER and SMTP_PASS, and optionally SMTP_HOST / SMTP_FROM). The verification code could not be sent.',
      503,
    );
  }

  let mailResult;
  try {
    mailResult = await sendBranchOwnerOtpEmail(ownerEmail, restaurant.name, otp, OWNER_OTP_MINUTES);
  } catch (emailErr) {
    logger.warn('Branch owner OTP email threw for %s: %s — OTP: %s', ownerEmail, emailErr.message, otp);
    return error(
      res,
      `The verification code could not be sent: ${emailErr.message}. Check SMTP settings.`,
      502,
    );
  }

  if (!mailResult.success) {
    logger.warn('Branch owner OTP email failed for %s: %s — OTP: %s', ownerEmail, mailResult.error || 'unknown', otp);
    return error(
      res,
      `The verification code could not be sent: ${mailResult.error || 'SMTP error'}. If you use Gmail, set "From" to the same address as SMTP_USER and check spam.`,
      502,
    );
  }

  return success(
    res,
    { expiresInMinutes: OWNER_OTP_MINUTES, emailSent: true },
    'Verification code sent to the branch owner Gmail.',
  );
});

const verifyBranchOwnerOtp = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  if (!restaurantId) return error(res, 'Unable to resolve restaurant', 403);
  if (req.user?.scope === 'employee') return error(res, 'Forbidden', 403);

  const ownerEmail = String(req.body.ownerEmail || '').trim().toLowerCase();
  const otpIn = String(req.body.ownerOtp || '').trim();
  if (!ownerEmail) return error(res, 'Branch owner Gmail is required', 400);
  if (!isGmailOwnedAddress(ownerEmail)) {
    return error(res, 'Branch owner email must be a Gmail address (@gmail.com).', 400);
  }
  if (!otpIn) return error(res, 'Enter the verification code from Gmail', 400);

  const otpDoc = await BranchOwnerOtp.findOne({ restaurantId, ownerEmail });
  if (!otpDoc || otpDoc.otp !== otpIn || !otpDoc.expiresAt || otpDoc.expiresAt < new Date()) {
    return error(res, 'Invalid or expired verification code', 400);
  }

  await BranchOwnerOtp.deleteOne({ _id: otpDoc._id });

  const ownerVerifyToken = jwt.sign(
    {
      typ: 'branch_owner_verify',
      restaurantId: String(restaurantId),
      ownerEmail,
    },
    JWT_SECRET,
    {
      expiresIn: OWNER_VERIFY_JWT_EXP,
      algorithm: JWT_ALGORITHM,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    },
  );

  return success(
    res,
    { ownerVerifyToken },
    'Gmail verified. You can continue with branch details.',
  );
});

const listBranches = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  if (!restaurantId) return error(res, 'Unable to resolve restaurant', 403);
  await ensureDefaultBranch(restaurantId);

  const page = readNumber(req.query.page, { min: 1, max: 10000, integer: true, fallback: 1 });
  const limit = readNumber(req.query.limit, { min: 1, max: 100, integer: true, fallback: 20 });
  const filter = { restaurantId, isDeleted: false };
  const status = readString(req.query.status, { max: 32 });
  const q = readSearchRegex(req.query.q);
  if (status) filter.status = status;
  if (q) {
    filter.$or = [
      { name: q },
      { city: q },
      { branchCode: q },
    ];
  }

  if (req.user?.scope === 'employee' && req.user.branchId) {
    filter._id = req.user.branchId;
  }

  const [items, total] = await Promise.all([
    Branch.find(filter)
      .populate('branchManager', 'name role email')
      .sort({ isDefault: -1, createdAt: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Branch.countDocuments(filter),
  ]);

  const restaurantRow = await Restaurant.findById(restaurantId).select('publicRestaurantId');
  if (restaurantRow) await ensurePublicRestaurantId(restaurantRow);

  const shaped = items.map((b) => {
    const o = b.toObject ? b.toObject() : b;
    o.enabledModules = b.isDefault ? allEnabledModules() : mergeEnabledModules(b.enabledModules);
    return o;
  });

  return success(
    res,
    {
      items: shaped,
      publicRestaurantId: restaurantRow?.publicRestaurantId || null,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    },
    'Branches retrieved',
  );
});

const createBranch = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  if (!restaurantId) return error(res, 'Unable to resolve restaurant', 403);
  if (req.user?.scope === 'employee') return error(res, 'Employees cannot create branches', 403);

  const { name, ownerEmail: ownerRaw, ownerVerifyToken: verifyTokRaw } = req.body;
  if (!name) return error(res, 'Branch name is required', 400);

  const ownerEmail = String(ownerRaw || '').trim().toLowerCase();
  if (!ownerEmail) return error(res, 'Branch owner Gmail is required', 400);
  if (!isGmailOwnedAddress(ownerEmail)) {
    return error(res, 'Branch owner email must be a Gmail address (@gmail.com).', 400);
  }

  const verifyTok = String(verifyTokRaw || '').trim();
  if (!verifyTok) {
    return error(res, 'Complete Gmail verification on step 1 before creating the branch', 400);
  }

  let decoded;
  try {
    decoded = jwt.verify(verifyTok, JWT_SECRET, jwtOptions);
  } catch {
    return error(res, 'Owner verification expired. Go back and verify your Gmail again.', 401);
  }
  if (
    decoded.typ !== 'branch_owner_verify'
    || String(decoded.restaurantId) !== String(restaurantId)
    || String(decoded.ownerEmail || '').toLowerCase() !== ownerEmail
  ) {
    return error(res, 'Invalid owner verification. Verify your Gmail again.', 401);
  }

  const restaurant = await Restaurant.findById(restaurantId).select('name slug');
  if (!restaurant) return error(res, 'Restaurant not found', 404);
  if (!isEmailConfigured()) {
    return error(res, 'Email service must be configured before creating branch credentials', 503);
  }
  await ensurePublicRestaurantId(restaurant);
  let slug;
  try {
    slug = await resolveRequestedBranchSlug({
      restaurant,
      name,
      requestedSlug: req.body.slug,
    });
  } catch (err) {
    return error(res, err.message || 'Branch slug is already in use', err.statusCode || 400);
  }
  const publicBranchId = await buildUniquePublicBranchId(name);
  const branchCode = req.body.branchCode
    ? String(req.body.branchCode).toUpperCase().trim()
    : publicBranchId.replace(/^BR-/, '').replace(/-/g, '').slice(0, 16).toUpperCase() || 'BRANCH';

  const enabledModules = mergeEnabledModules(req.body.enabledModules);
  const fields = writableFields(req.body);
  fields.enabledModules = enabledModules;

  let branch;
  try {
    branch = await Branch.create({
      ...fields,
      ownerEmail,
      restaurantId,
      name,
      slug,
      branchCode,
      publicBranchId,
      createdBy: req.user.id,
      createdByModel: req.user.scope === 'employee' ? 'Employee' : 'Restaurant',
    });
  } catch (err) {
    if (isDuplicateKeyError(err, 'slug')) {
      return error(res, 'Branch slug already exists. Choose another branch URL slug.', 409);
    }
    if (isDuplicateKeyError(err, 'branchCode')) {
      return error(res, 'Branch code already exists for this restaurant. Choose another code.', 409);
    }
    if (isDuplicateKeyError(err, 'publicBranchId')) {
      return error(res, 'Branch public ID already exists. Please try again.', 409);
    }
    throw err;
  }

  const rawLocal = (req.body.branchUsername && String(req.body.branchUsername).trim())
    || suggestBranchUsername(slug);
  const { branchEmail, localPart } = await allocateUniqueBranchEmail(rawLocal);

  let plainPassword = req.body.branchPassword ? String(req.body.branchPassword) : null;
  let generatedPassword = false;
  if (!plainPassword || req.body.autoGeneratePassword === true) {
    plainPassword = generateSecurePassword(16);
    generatedPassword = true;
  }

  const branchRole = req.body.branchRole && ['branch_admin', 'branch_manager', 'branch_cashier', 'branch_waiter', 'branch_kitchen'].includes(req.body.branchRole)
    ? req.body.branchRole
    : 'branch_admin';

  const branchPermissions =
    req.body.branchPermissions && typeof req.body.branchPermissions === 'object'
      ? req.body.branchPermissions
      : {};

  const activeClash = await BranchAuth.findOne({
    restaurantId,
    username: localPart,
    activeStatus: true,
    branchId: { $ne: branch._id },
  });
  if (activeClash) {
    return error(
      res,
      'This branch login username is already in use by another outlet. Choose a different branch username.',
      409,
    );
  }

  let branchAuth = await BranchAuth.findOne({
    restaurantId,
    username: localPart,
    activeStatus: false,
  });

  if (branchAuth) {
    branchAuth.branchId = branch._id;
    branchAuth.username = localPart;
    branchAuth.branchEmail = branchEmail;
    branchAuth.passwordHash = hashPassword(plainPassword);
    branchAuth.role = branchRole;
    branchAuth.permissions = branchPermissions;
    branchAuth.activeStatus = true;
    branchAuth.createdBy = req.user.id;
    branchAuth.createdByModel = req.user.scope === 'employee' ? 'Employee' : 'Restaurant';
    await branchAuth.save();
  } else {
    branchAuth = await BranchAuth.create({
      restaurantId,
      branchId: branch._id,
      username: localPart,
      branchEmail,
      passwordHash: hashPassword(plainPassword),
      role: branchRole,
      permissions: branchPermissions,
      createdBy: req.user.id,
      createdByModel: req.user.scope === 'employee' ? 'Employee' : 'Restaurant',
    });
  }

  await AuditLog.create({
    user: req.user.id,
    userModel: req.user.scope === 'employee' ? 'Employee' : 'Restaurant',
    action: 'branch_create',
    resource: 'branch',
    resourceId: branch._id,
    details: {
      restaurantId: String(restaurantId),
      branchId: String(branch._id),
      name: branch.name,
      publicBranchId: branch.publicBranchId,
      branchAuthId: String(branchAuth._id),
    },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
  });

  const branchJson = branch.toObject ? branch.toObject() : branch;
  branchJson.enabledModules = mergeEnabledModules(branch.enabledModules);

  const branchPortalKey = await ensureBranchPortalKey(restaurantId);
  const loginPath = `/branch/${encodeURIComponent(String(restaurantId))}/${encodeURIComponent(branchPortalKey || '')}/${encodeURIComponent(branch.slug)}/login`;

  const welcomePayload = {
    restaurantName: restaurant.name,
    branchName: branch.name,
    branchEmail: branchAuth.branchEmail,
    username: branchAuth.username,
    password: plainPassword,
    publicRestaurantId: restaurant.publicRestaurantId || null,
    restaurantId: String(restaurantId),
    branchPortalKey: branchPortalKey || '',
    loginPath,
    publicBranchId: branch.publicBranchId,
    branchSlug: branch.slug,
  };

  let credentialsEmailSent = false;
  try {
    const mailResult = await sendBranchOwnerWelcomeEmail(ownerEmail, welcomePayload);
    credentialsEmailSent = Boolean(mailResult.success);
    if (!credentialsEmailSent) {
      logger.warn('Branch welcome email failed for %s: %s', ownerEmail, mailResult.error || 'unknown');
    }
  } catch (emailErr) {
    logger.warn('Branch welcome email threw for %s: %s', ownerEmail, emailErr.message);
  }

  if (!credentialsEmailSent) {
    await BranchAuth.deleteOne({ _id: branchAuth._id, restaurantId, branchId: branch._id });
    await Branch.deleteOne({ _id: branch._id, restaurantId });
    return error(res, 'Branch credentials email could not be sent; branch was not created', 502);
  }

  return success(res, {
    branch: branchJson,
    branchAuth: {
      _id: branchAuth._id,
      username: branchAuth.username,
      branchEmail: branchAuth.branchEmail,
      role: branchAuth.role,
    },
    credentialsEmailSent,
  }, 'Branch created', 201);
});

const getBranch = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  const branch = await Branch.findOne({ _id: req.params.id, restaurantId, isDeleted: false }).populate('branchManager', 'name role email');
  if (!branch) return error(res, 'Branch not found', 404);
  if (req.user?.scope === 'employee' && req.user.branchId && String(req.user.branchId) !== String(branch._id)) {
    return error(res, 'You do not have access to this branch', 403);
  }
  const out = branch.toObject ? branch.toObject() : branch;
  out.enabledModules = mergeEnabledModules(branch.enabledModules);
  return success(res, out, 'Branch retrieved');
});

const getMyBranchSettings = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  const branchId = normalizeObjectId(req.user?.branchId);
  if (!restaurantId || !branchId || req.user?.scope !== 'branch_user') {
    return error(res, 'Unable to resolve branch', 403);
  }
  const branch = await Branch.findOne({ _id: branchId, restaurantId, isDeleted: false }).lean();
  if (!branch) return error(res, 'Branch not found', 404);
  return success(res, branch, 'Branch settings retrieved');
});

const updateMyBranchSettings = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  const branchId = normalizeObjectId(req.user?.branchId);
  if (!restaurantId || !branchId || req.user?.scope !== 'branch_user') {
    return error(res, 'Unable to resolve branch', 403);
  }
  const branch = await Branch.findOne({ _id: branchId, restaurantId, isDeleted: false });
  if (!branch) return error(res, 'Branch not found', 404);

  const updates = {};
  const scalarFields = [
    ['phone', 60],
    ['email', 160],
    ['address', 400],
    ['city', 120],
    ['state', 120],
    ['country', 120],
    ['branchManagerName', 120],
    ['taxNumber', 120],
  ];
  scalarFields.forEach(([field, max]) => {
    const cleaned = cleanScalar(req.body[field], max);
    if (cleaned !== undefined) updates[field] = cleaned;
  });

  const openingHours = parseMaybeJson(req.body.openingHours);
  if (openingHours && typeof openingHours === 'object') {
    updates.openingHours = {
      monday: cleanScalar(openingHours.monday, 80) || '',
      tuesday: cleanScalar(openingHours.tuesday, 80) || '',
      wednesday: cleanScalar(openingHours.wednesday, 80) || '',
      thursday: cleanScalar(openingHours.thursday, 80) || '',
      friday: cleanScalar(openingHours.friday, 80) || '',
      saturday: cleanScalar(openingHours.saturday, 80) || '',
      sunday: cleanScalar(openingHours.sunday, 80) || '',
    };
  }

  const settingsPayload = parseMaybeJson(req.body.settings);
  if (settingsPayload && typeof settingsPayload === 'object') {
    const receiptFooter = cleanScalar(settingsPayload.receiptFooter, 500);
    if (receiptFooter !== undefined) updates['settings.receiptFooter'] = receiptFooter;
    const currency = cleanScalar(settingsPayload.currency, 20);
    if (currency !== undefined) updates['settings.currency'] = currency;
    const timezone = cleanScalar(settingsPayload.timezone, 80);
    if (timezone !== undefined) updates['settings.timezone'] = timezone;
    if (settingsPayload.taxRate !== undefined && Number.isFinite(Number(settingsPayload.taxRate))) {
      updates['settings.taxRate'] = Number(settingsPayload.taxRate);
    }
    if (settingsPayload.serviceChargePercent !== undefined && Number.isFinite(Number(settingsPayload.serviceChargePercent))) {
      updates['settings.serviceChargePercent'] = Number(settingsPayload.serviceChargePercent);
    }
    if (Array.isArray(settingsPayload.languages)) {
      updates['settings.languages'] = settingsPayload.languages.map((x) => cleanScalar(x, 40)).filter(Boolean).slice(0, 8);
    }
  }

  const themePayload = sanitizeBranchThemeSettings(parseMaybeJson(req.body.themeSettings));
  if (themePayload) {
    Object.entries(themePayload).forEach(([key, value]) => {
      updates[`settings.themeSettings.${key}`] = value;
    });
  }

  if (req.files) {
    if (req.files.logo) updates.logo = req.files.logo[0].path;
    if (req.files.banner) updates.banner = req.files.banner[0].path;
  }
  if (updates.logo) updates['settings.themeSettings.branding.logo'] = updates.logo;
  if (updates.banner) updates['settings.themeSettings.branding.backgroundImage'] = updates.banner;

  Object.entries(updates).forEach(([key, value]) => branch.set(key, value));
  await branch.save();

  await AuditLog.create({
    user: req.user.id,
    userModel: 'Restaurant',
    action: 'branch_self_settings_update',
    resource: 'branch',
    resourceId: branch._id,
    details: { restaurantId: String(restaurantId), branchId: String(branch._id) },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
  }).catch(() => {});

  const out = branch.toObject ? branch.toObject() : branch;
  return success(res, out, 'Branch settings updated');
});

const getMyBranchPublicProfile = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  const branchId = normalizeObjectId(req.user?.branchId);
  if (!restaurantId || !branchId || req.user?.scope !== 'branch_user') {
    return error(res, 'Unable to resolve branch', 403);
  }
  const branch = await Branch.findOne({ _id: branchId, restaurantId, isDeleted: false }).lean();
  if (!branch) return error(res, 'Branch not found', 404);
  return success(res, {
    ...branch,
    about: branch.about || {},
    privacyPolicy: branch.privacyPolicy || {},
  }, 'Branch public profile retrieved');
});

const updateMyBranchPublicProfile = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  const branchId = normalizeObjectId(req.user?.branchId);
  if (!restaurantId || !branchId || req.user?.scope !== 'branch_user') {
    return error(res, 'Unable to resolve branch', 403);
  }
  const branch = await Branch.findOne({ _id: branchId, restaurantId, isDeleted: false });
  if (!branch) return error(res, 'Branch not found', 404);

  const aboutPayload = parseMaybeJson(req.body.about);
  if (aboutPayload && typeof aboutPayload === 'object') {
    const toStr = (v) => (v == null ? '' : String(v));
    branch.about = {
      tagline: toStr(aboutPayload.tagline).slice(0, 200),
      aboutText: toStr(aboutPayload.aboutText).slice(0, 4000),
      cuisine: toStr(aboutPayload.cuisine).slice(0, 120),
      priceRange: toStr(aboutPayload.priceRange).slice(0, 32),
      establishedYear: Number(aboutPayload.establishedYear) || undefined,
      rating: Number.isFinite(Number(aboutPayload.rating)) ? Number(aboutPayload.rating) : undefined,
      reviewCount: Number.isFinite(Number(aboutPayload.reviewCount)) ? Number(aboutPayload.reviewCount) : undefined,
      features: Array.isArray(aboutPayload.features)
        ? aboutPayload.features.filter((f) => f && (f.label || f.name)).slice(0, 8).map((f) => ({
            icon: toStr(f.icon || 'Utensils').slice(0, 40) || 'Utensils',
            label: toStr(f.label || f.name).slice(0, 60),
          }))
        : [],
      gallery: Array.isArray(aboutPayload.gallery)
        ? aboutPayload.gallery.map((u) => toStr(u).trim()).filter(Boolean).slice(0, 12)
        : [],
      hours: aboutPayload.hours && typeof aboutPayload.hours === 'object' ? aboutPayload.hours : {},
      socials: aboutPayload.socials && typeof aboutPayload.socials === 'object' ? aboutPayload.socials : {},
    };
  }

  const privacyPayload = parseMaybeJson(req.body.privacyPolicy);
  if (privacyPayload && typeof privacyPayload === 'object') {
    const toStr = (v) => (v == null ? '' : String(v));
    branch.privacyPolicy = {
      enabled: privacyPayload.enabled === true || privacyPayload.enabled === 'true',
      sections: Array.isArray(privacyPayload.sections)
        ? privacyPayload.sections.filter((s) => s && s.title).slice(0, 30).map((s) => ({
            title: toStr(s.title).slice(0, 120),
            content: toStr(s.content).slice(0, 8000),
          }))
        : [],
      contactEmail: toStr(privacyPayload.contactEmail).slice(0, 160),
      contactPhone: toStr(privacyPayload.contactPhone).slice(0, 60),
      contactAddress: toStr(privacyPayload.contactAddress).slice(0, 400),
      lastUpdated: new Date(),
    };
  }

  await branch.save();
  return success(res, branch, 'Branch public profile updated');
});

const updateBranch = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  if (req.user?.scope === 'employee') return error(res, 'Employees cannot edit branches', 403);
  const branch = await Branch.findOne({ _id: req.params.id, restaurantId, isDeleted: false });
  if (!branch) return error(res, 'Branch not found', 404);
  if (branch.isDefault) {
    return error(
      res,
      'Main/default branch is protected. Edit restaurant subscription or plan settings instead.',
      403,
      { code: 'DEFAULT_BRANCH_LOCKED' },
    );
  }

  const prevStatus = branch.status;
  const updates = writableFields(req.body);
  if (updates.ownerEmail !== undefined) {
    const o = String(updates.ownerEmail || '').trim().toLowerCase();
    if (o && !isGmailOwnedAddress(o)) {
      return error(res, 'Branch owner email must be a Gmail address (@gmail.com).', 400);
    }
    updates.ownerEmail = o;
  }
  if (updates.enabledModules) {
    updates.enabledModules = mergeEnabledModules(updates.enabledModules);
  }
  Object.assign(branch, updates);
  await branch.save();

  if (['inactive', 'suspended'].includes(branch.status) && prevStatus === 'active') {
    await BranchAuth.updateMany({ branchId: branch._id, activeStatus: true }, { $set: { activeStatus: false } });
    await BranchSession.updateMany(
      { branchId: branch._id, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'branch_suspended' } },
    );
    await AuditLog.create({
      user: req.user.id,
      userModel: 'Restaurant',
      action: 'branch_suspended',
      resource: 'branch',
      resourceId: branch._id,
      details: { restaurantId: String(restaurantId), branchId: String(branch._id), status: branch.status },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    }).catch(() => {});
  }

  await AuditLog.create({
    user: req.user.id,
    userModel: 'Restaurant',
    action: 'branch_update',
    resource: 'branch',
    resourceId: branch._id,
    details: { restaurantId: String(restaurantId), branchId: String(branch._id), enabledModules: branch.enabledModules },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
  });

  const out = branch.toObject ? branch.toObject() : branch;
  out.enabledModules = branch.isDefault ? allEnabledModules() : mergeEnabledModules(branch.enabledModules);
  return success(res, out, 'Branch updated');
});

const deleteBranch = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  if (req.user?.scope === 'employee') return error(res, 'Employees cannot delete branches', 403);
  const branch = await Branch.findOne({ _id: req.params.id, restaurantId, isDeleted: false });
  if (!branch) return error(res, 'Branch not found', 404);
  if (branch.isDefault) return error(res, 'Default branch cannot be deleted', 400);

  branch.isDeleted = true;
  branch.status = 'inactive';
  await branch.save();

  await BranchAuth.updateMany({ branchId: branch._id }, { $set: { activeStatus: false } });
  await BranchSession.updateMany(
    { branchId: branch._id, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'branch_deleted' } },
  );

  await AuditLog.create({
    user: req.user.id,
    userModel: 'Restaurant',
    action: 'branch_delete',
    resource: 'branch',
    resourceId: branch._id,
    details: { restaurantId: String(restaurantId), branchId: String(branch._id) },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
  });

  return success(res, null, 'Branch deleted');
});

const assignManager = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  const branch = await Branch.findOne({ _id: req.params.id, restaurantId, isDeleted: false });
  if (!branch) return error(res, 'Branch not found', 404);
  const managerId = req.body.managerId ? normalizeObjectId(req.body.managerId) : null;
  if (managerId) {
    const manager = await Employee.findOne({ _id: managerId, restaurant: restaurantId, branchId: branch._id, role: 'manager', isActive: true });
    if (!manager) return error(res, 'Active manager not found for this restaurant', 404);
    manager.branchId = branch._id;
    await manager.save();
  }
  branch.branchManager = managerId;
  await branch.save();
  return success(res, branch, 'Branch manager assigned');
});

const getBranchAnalytics = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  let branchFilter = {};
  let employeeBranchFilter = {};
  if (req.params.id !== 'consolidated') {
    const branchId = normalizeObjectId(req.params.id);
    const branch = await Branch.findOne({ _id: branchId, restaurantId, isDeleted: false });
    if (!branch) return error(res, 'Branch not found', 404);
    branchFilter = branch.isDefault
      ? { $or: [{ branchId }, { branchId: null }, { branchId: { $exists: false } }] }
      : { branchId };
    employeeBranchFilter = branch.isDefault
      ? { $or: [{ branchId }, { branchId: null }, { branchId: { $exists: false } }] }
      : { branchId };
  }

  const salesMatch = { restaurantId, ...branchFilter };
  const orderMatch = { restaurant: restaurantId, ...branchFilter };
  const expenseMatch = { restaurantId, isDeleted: false, ...branchFilter };
  const inventoryMatch = { restaurantId, isDeleted: false, ...branchFilter };

  const [
    sales,
    orders,
    expenses,
    employees,
    inventory,
    trends,
    statusBreakdown,
    paymentBreakdown,
    channelBreakdown,
    hourlyOrders,
    topItems,
    expenseCategories,
    inventoryCategories,
    lowStockItems,
    recentOrders,
  ] = await Promise.all([
    SalesReport.aggregate([{ $match: salesMatch }, { $group: { _id: null, revenue: { $sum: '$totalRevenue' }, netRevenue: { $sum: '$netRevenue' }, orders: { $sum: 1 } } }]),
    CustomerOrder.countDocuments(orderMatch),
    Expense.aggregate([{ $match: expenseMatch }, { $group: { _id: null, amount: { $sum: '$amount' }, entries: { $sum: 1 } } }]),
    Employee.countDocuments({ restaurant: restaurantId, ...employeeBranchFilter }),
    InventoryItem.aggregate([{ $match: inventoryMatch }, { $group: { _id: null, value: { $sum: { $multiply: ['$quantity', '$costPerUnit'] } }, items: { $sum: 1 }, lowStock: { $sum: { $cond: [{ $lte: ['$quantity', '$minimumStock'] }, 1, 0] } } } }]),
    SalesReport.aggregate([
      { $match: salesMatch },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$soldAt' } }, revenue: { $sum: '$totalRevenue' }, orders: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $limit: 30 },
    ]),
    CustomerOrder.aggregate([
      { $match: orderMatch },
      { $group: { _id: '$status', orders: { $sum: 1 }, revenue: { $sum: '$grandTotal' } } },
      { $sort: { orders: -1 } },
    ]),
    CustomerOrder.aggregate([
      { $match: orderMatch },
      { $group: { _id: { $ifNull: ['$paymentStatus', 'pending'] }, orders: { $sum: 1 }, revenue: { $sum: '$grandTotal' } } },
      { $sort: { orders: -1 } },
    ]),
    CustomerOrder.aggregate([
      { $match: orderMatch },
      { $group: { _id: { $ifNull: ['$orderChannel', 'qr_ordering'] }, orders: { $sum: 1 }, revenue: { $sum: '$grandTotal' } } },
      { $sort: { orders: -1 } },
    ]),
    CustomerOrder.aggregate([
      { $match: orderMatch },
      { $group: { _id: { $hour: '$createdAt' }, orders: { $sum: 1 }, revenue: { $sum: '$grandTotal' } } },
      { $sort: { _id: 1 } },
    ]),
    CustomerOrder.aggregate([
      { $match: orderMatch },
      { $unwind: '$items' },
      { $group: { _id: '$items.name', quantity: { $sum: '$items.quantity' }, revenue: { $sum: '$items.subtotal' }, orders: { $sum: 1 } } },
      { $sort: { revenue: -1 } },
      { $limit: 8 },
    ]),
    Expense.aggregate([
      { $match: expenseMatch },
      { $group: { _id: '$category', amount: { $sum: '$amount' }, entries: { $sum: 1 } } },
      { $sort: { amount: -1 } },
      { $limit: 8 },
    ]),
    InventoryItem.aggregate([
      { $match: inventoryMatch },
      { $group: { _id: '$category', value: { $sum: { $multiply: ['$quantity', '$costPerUnit'] } }, items: { $sum: 1 } } },
      { $sort: { value: -1 } },
      { $limit: 8 },
    ]),
    InventoryItem.find(inventoryMatch)
      .sort({ quantity: 1, updatedAt: -1 })
      .limit(8)
      .select('name category quantity minimumStock unit costPerUnit')
      .lean(),
    CustomerOrder.find(orderMatch)
      .sort({ createdAt: -1 })
      .limit(8)
      .select('orderNumber customerName table status paymentStatus grandTotal createdAt orderChannel paymentMethod')
      .populate('table', 'tableNumber name')
      .lean(),
  ]);

  const revenue = Number(sales[0]?.netRevenue || sales[0]?.revenue || 0);
  const expense = Number(expenses[0]?.amount || 0);
  const salesOrders = Number(sales[0]?.orders || 0);
  const customerOrders = Number(orders || 0);
  return success(res, {
    summary: {
      revenue,
      expenses: expense,
      netProfit: revenue - expense,
      salesOrders,
      customerOrders,
      totalOrders: customerOrders,
      averageOrderValue: customerOrders > 0 ? revenue / customerOrders : 0,
      employees,
      inventoryValue: Number(inventory[0]?.value || 0),
      inventoryItems: Number(inventory[0]?.items || 0),
      lowStockItems: Number(inventory[0]?.lowStock || 0),
      expenseEntries: Number(expenses[0]?.entries || 0),
    },
    trends,
    breakdowns: {
      status: statusBreakdown,
      payment: paymentBreakdown,
      channel: channelBreakdown,
      hourly: hourlyOrders,
      topItems,
      expenseCategories,
      inventoryCategories,
      lowStockItems,
      recentOrders,
    },
  }, 'Branch analytics retrieved');
});

const resetBranchPortalPassword = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  if (req.user?.scope === 'employee') return error(res, 'Forbidden', 403);
  const branch = await Branch.findOne({ _id: req.params.id, restaurantId, isDeleted: false });
  if (!branch) return error(res, 'Branch not found', 404);

  const authRecord = await BranchAuth.findOne({
    _id: normalizeObjectId(req.params.authId),
    branchId: branch._id,
  });
  if (!authRecord) return error(res, 'Branch login not found', 404);

  const plain = req.body.newPassword || generateSecurePassword(16);
  authRecord.passwordHash = hashPassword(plain);
  await authRecord.save();

  await BranchSession.updateMany(
    { branchAuthId: authRecord._id, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'password_reset' } },
  );

  await AuditLog.create({
    user: req.user.id,
    userModel: 'Restaurant',
    action: 'branch_password_reset',
    resource: 'branch_auth',
    resourceId: authRecord._id,
    details: { branchId: String(branch._id) },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
  });

  return success(res, { username: authRecord.username, branchEmail: authRecord.branchEmail, newPassword: plain }, 'Password reset');
});

const updateBranchAuth = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  if (req.user?.scope === 'employee') return error(res, 'Forbidden', 403);
  const branch = await Branch.findOne({ _id: req.params.id, restaurantId, isDeleted: false });
  if (!branch) return error(res, 'Branch not found', 404);

  const authId = normalizeObjectId(req.params.authId);
  if (!authId) return error(res, 'Invalid auth id', 400);
  const authRecord = await BranchAuth.findOne({ _id: authId, branchId: branch._id, restaurantId });
  if (!authRecord) return error(res, 'Branch login not found', 404);

  let sessionsRevoked = false;

  if (req.body.branchUsername != null && String(req.body.branchUsername).trim()) {
    const { branchEmail, localPart } = await allocateUniqueBranchEmail(String(req.body.branchUsername).trim());
    const clash = await BranchAuth.findOne({
      restaurantId,
      username: localPart,
      activeStatus: true,
      _id: { $ne: authRecord._id },
    });
    if (clash) {
      return error(res, 'Another active branch login already uses this username.', 409);
    }
    if (authRecord.branchEmail !== branchEmail || authRecord.username !== localPart) {
      await BranchSession.updateMany(
        { branchAuthId: authRecord._id, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: 'branch_username_changed' } },
      );
      sessionsRevoked = true;
    }
    authRecord.username = localPart;
    authRecord.branchEmail = branchEmail;
    await AuditLog.create({
      user: req.user.id,
      userModel: 'Restaurant',
      action: 'branch_username_updated',
      resource: 'branch_auth',
      resourceId: authRecord._id,
      details: { branchId: String(branch._id), branchEmail },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    }).catch(() => {});
  }

  if (req.body.activeStatus !== undefined) {
    const next = Boolean(req.body.activeStatus);
    if (authRecord.activeStatus !== next) {
      authRecord.activeStatus = next;
      if (!next) {
        await BranchSession.updateMany(
          { branchAuthId: authRecord._id, revokedAt: null },
          { $set: { revokedAt: new Date(), revokedReason: 'login_disabled' } },
        );
        sessionsRevoked = true;
      }
      await AuditLog.create({
        user: req.user.id,
        userModel: 'Restaurant',
        action: next ? 'branch_login_enabled' : 'branch_login_disabled',
        resource: 'branch_auth',
        resourceId: authRecord._id,
        details: { branchId: String(branch._id) },
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      }).catch(() => {});
    }
  }

  await authRecord.save();
  return success(
    res,
    {
      branchAuth: authRecord.safeObject(),
      sessionsRevoked,
    },
    'Branch credentials updated',
  );
});

const listBranchPortalSessions = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  if (req.user?.scope === 'employee') return error(res, 'Forbidden', 403);
  const branch = await Branch.findOne({ _id: req.params.id, restaurantId, isDeleted: false });
  if (!branch) return error(res, 'Branch not found', 404);

  const authId = normalizeObjectId(req.params.authId);
  if (!authId) return error(res, 'Invalid auth id', 400);
  const authRecord = await BranchAuth.findOne({ _id: authId, branchId: branch._id, restaurantId });
  if (!authRecord) return error(res, 'Not found', 404);

  const items = await BranchSession.find({ branchAuthId: authId })
    .sort({ createdAt: -1 })
    .limit(200)
    .select('userAgent ipAddress deviceLabel lastActivityAt expiresAt revokedAt createdAt')
    .lean();

  return success(res, { items }, 'OK');
});

const revokeBranchPortalSession = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  if (req.user?.scope === 'employee') return error(res, 'Forbidden', 403);
  const branch = await Branch.findOne({ _id: req.params.id, restaurantId, isDeleted: false });
  if (!branch) return error(res, 'Branch not found', 404);

  const authRecord = await BranchAuth.findOne({ _id: req.params.authId, branchId: branch._id, restaurantId });
  if (!authRecord) return error(res, 'Not found', 404);

  await BranchSession.updateOne(
    { _id: req.params.sessionId, branchAuthId: authRecord._id, restaurantId, branchId: branch._id },
    { $set: { revokedAt: new Date(), revokedReason: 'forced_logout' } },
  );

  await AuditLog.create({
    user: req.user.id,
    userModel: 'Restaurant',
    action: 'branch_session_revoke',
    resource: 'branch_auth',
    resourceId: authRecord._id,
    details: { sessionId: String(req.params.sessionId) },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
  });

  return success(res, null, 'Session revoked');
});

const getBranchActivityTimeline = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  const branch = await Branch.findOne({ _id: req.params.id, restaurantId, isDeleted: false });
  if (!branch) return error(res, 'Branch not found', 404);

  const limit = Math.min(Number(req.query.limit || 50), 200);
  const items = await AuditLog.find({
    resource: { $in: ['branch', 'branch_auth'] },
    $or: [
      { 'details.branchId': String(branch._id) },
      { resourceId: branch._id },
    ],
  })
    .sort({ timestamp: -1 })
    .limit(limit)
    .select('action user userModel resource resourceId details timestamp ipAddress')
    .lean();

  return success(res, { items }, 'OK');
});

module.exports = {
  listBranches,
  requestBranchOwnerOtp,
  verifyBranchOwnerOtp,
  createBranch,
  getBranch,
  getMyBranchSettings,
  updateMyBranchSettings,
  getMyBranchPublicProfile,
  updateMyBranchPublicProfile,
  updateBranch,
  deleteBranch,
  assignManager,
  getBranchAnalytics,
  resetBranchPortalPassword,
  updateBranchAuth,
  listBranchPortalSessions,
  revokeBranchPortalSession,
  getBranchActivityTimeline,
};
