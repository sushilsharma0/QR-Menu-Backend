const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const BackupRestoreOtp = require('../../models/restaurant/BackupRestoreOtp');
const Restaurant = require('../../models/restaurant/Restaurant');
const { generateOTP } = require('../../utils/generateToken');
const { sendBackupRestoreOtpEmail } = require('../emailService');
const { logger } = require('../../utils/logger');

const OTP_TTL_MS = Number(process.env.BACKUP_RESTORE_OTP_TTL_MS || 10 * 60 * 1000);

function hashOtp(otp) {
  return bcrypt.hashSync(String(otp).trim(), 10);
}

function verifyOtpHash(otp, hash) {
  return bcrypt.compareSync(String(otp).trim(), hash);
}

async function requestRestoreOtp(req, { purpose = 'restore' } = {}) {
  const restaurantId = req.user?.restaurantId || req.user?.id;
  const actorId = req.user?.employeeId || req.user?.id;
  const actorModel =
    req.user?.scope === 'branch_user' ? 'BranchAuth' : req.user?.scope === 'employee' ? 'Employee' : 'Restaurant';

  await BackupRestoreOtp.deleteMany({ restaurantId, purpose, verifiedAt: null });

  const otp = generateOTP(6);
  const record = await BackupRestoreOtp.create({
    restaurantId,
    requestedBy: actorId,
    requestedByModel: actorModel,
    otpHash: hashOtp(otp),
    purpose,
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
    ipAddress: req.ip,
  });

  const restaurant = await Restaurant.findById(restaurantId).select('email name').lean();
  const email = restaurant?.email;
  if (email) {
    const mail = await sendBackupRestoreOtpEmail(
      email,
      restaurant.name,
      otp,
      purpose,
      Math.round(OTP_TTL_MS / 60000),
    );
    if (!mail?.success) {
      logger.warn('Restore OTP email failed for %s — OTP logged for dev', email);
      if ((process.env.NODE_ENV || 'development') !== 'production') {
        logger.warn('Restore OTP for %s: %s', email, otp);
      }
    }
  } else if ((process.env.NODE_ENV || 'development') !== 'production') {
    logger.warn('Restore OTP (no email): %s', otp);
  }

  return { otpId: record._id, expiresAt: record.expiresAt, emailSent: Boolean(email) };
}

async function verifyRestoreOtp(req, { otp, purpose = 'restore' } = {}) {
  const restaurantId = req.user?.restaurantId || req.user?.id;
  const actorId = req.user?.employeeId || req.user?.id;

  const record = await BackupRestoreOtp.findOne({
    restaurantId,
    purpose,
    verifiedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .select('+otpHash')
    .sort({ createdAt: -1 });

  if (!record) throw new Error('No active verification code. Request a new OTP.');
  if (record.attempts >= record.maxAttempts) throw new Error('Too many failed attempts. Request a new OTP.');

  record.attempts += 1;
  if (!verifyOtpHash(otp, record.otpHash)) {
    await record.save();
    throw new Error('Invalid verification code');
  }

  if (String(record.requestedBy) !== String(actorId)) {
    throw new Error('Verification code was issued to a different user session');
  }

  record.verifiedAt = new Date();
  await record.save();
  return { verified: true, otpId: record._id, validUntil: new Date(Date.now() + 15 * 60 * 1000) };
}

async function assertRestoreOtpVerified(req, { purpose = 'restore', otpId } = {}) {
  const restaurantId = req.user?.restaurantId || req.user?.id;
  const actorId = req.user?.employeeId || req.user?.id;
  const query = {
    restaurantId,
    purpose,
    verifiedAt: { $ne: null },
    requestedBy: actorId,
    expiresAt: { $gt: new Date(Date.now() - 15 * 60 * 1000) },
  };
  if (otpId) query._id = otpId;
  const record = await BackupRestoreOtp.findOne(query).sort({ verifiedAt: -1 });
  if (!record) {
    throw new Error('Email OTP verification required before restore. Request and verify a code first.');
  }
  return record;
}

module.exports = {
  requestRestoreOtp,
  verifyRestoreOtp,
  assertRestoreOtpVerified,
};
