const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const Branch = require('../models/restaurant/Branch');
const BranchSession = require('../models/restaurant/BranchSession');
const mongoose = require('mongoose');
const { generateToken } = require('../utils/generateToken');
const { JWT_EXPIRES_IN } = require('../config/env');

function normalizeObjectId(value) {
  if (!value) return null;
  if (!mongoose.Types.ObjectId.isValid(String(value))) return null;
  return new mongoose.Types.ObjectId(String(value));
}

const BCRYPT_ROUNDS = 12
const BRANCH_EMAIL_DOMAIN = 'branch.com'

function normalizeBranchUsernameLocal(raw) {
  const s = String(raw || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^\.+|\.+$/g, '')
  const base = s || 'branch'
  if (base.length > 64) return base.slice(0, 64)
  return base
}

/**
 * Allocate a globally unique branch login email: local@branch.com, local2@..., etc.
 */
async function allocateUniqueBranchEmail(localBase) {
  const BranchAuth = require('../models/restaurant/BranchAuth')
  const base = normalizeBranchUsernameLocal(localBase)
  let suffix = ''
  let n = 2
  for (;;) {
    const local = `${base}${suffix}`
    const branchEmail = `${local}@${BRANCH_EMAIL_DOMAIN}`
    const exists = await BranchAuth.exists({ branchEmail })
    if (!exists) return { branchEmail, localPart: local }
    suffix = String(n)
    n += 1
  }
}

function generateSecurePassword(length = 16) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%'
  const bytes = crypto.randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += chars[bytes[i] % chars.length]
  }
  return out
}

async function buildUniquePublicBranchId(branchName) {
  const slugify = require('slugify');
  const base = slugify(String(branchName || 'branch'), { upper: true, strict: true, replacement: '-' })
    .replace(/-/g, '')
    .slice(0, 10) || 'BRANCH'
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const suffix = String(1000 + crypto.randomInt(9000))
    const candidate = `BR-${base}-${suffix}`
    const exists = await Branch.exists({ publicBranchId: candidate })
    if (!exists) return candidate
  }
  return `BR-${base}-${Date.now().toString(36).toUpperCase()}`
}

function hashPassword(plain) {
  return bcrypt.hashSync(plain, BCRYPT_ROUNDS)
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash)
}

function sessionExpiryDate() {
  const match = String(JWT_EXPIRES_IN || '7d').match(/^(\d+)([smhd])$/)
  if (!match) return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  const n = Number(match[1])
  const u = match[2]
  const mult = u === 's' ? 1000 : u === 'm' ? 60 * 1000 : u === 'h' ? 3600 * 1000 : 86400 * 1000
  return new Date(Date.now() + n * mult)
}

async function issueBranchToken(branchAuthDoc, branchDoc, restaurantDoc, reqMeta = {}, branchPortalKey = '') {
  const expiresAt = sessionExpiryDate()
  const session = await BranchSession.create({
    branchAuthId: branchAuthDoc._id,
    restaurantId: branchDoc.restaurantId,
    branchId: branchDoc._id,
    tokenFamily: crypto.randomBytes(16).toString('hex'),
    userAgent: reqMeta.userAgent || '',
    ipAddress: reqMeta.ip || '',
    deviceLabel: reqMeta.deviceLabel || '',
    expiresAt,
  })

  const permissions = branchAuthDoc.permissions && typeof branchAuthDoc.permissions === 'object'
    ? branchAuthDoc.permissions
    : {}

  const authId = String(branchAuthDoc._id)
  const payload = {
    id: authId,
    userId: authId,
    scope: 'branch_user',
    role: branchAuthDoc.role,
    restaurantId: String(branchDoc.restaurantId),
    branchId: String(branchDoc._id),
    branchSlug: branchDoc.slug,
    restaurantSlug: restaurantDoc.slug,
    branchPortalKey: String(branchPortalKey || '').toLowerCase(),
    permissions,
    sessionId: String(session._id),
    name: branchAuthDoc.username,
  }

  const token = generateToken(payload)
  return { token, session, payload }
}

async function validateBranchSession(sessionId, scope = {}) {
  if (!sessionId || !normalizeObjectId(sessionId)) return null
  const query = { _id: sessionId }
  if (scope.restaurantId) query.restaurantId = scope.restaurantId
  if (scope.branchId) query.branchId = scope.branchId
  if (scope.branchAuthId) query.branchAuthId = scope.branchAuthId
  const sess = await BranchSession.findOne(query)
    .select('revokedAt expiresAt branchAuthId')
    .lean()
  if (!sess || sess.revokedAt) return null
  if (new Date(sess.expiresAt) <= new Date()) return null
  return sess
}

async function touchBranchSession(sessionId, scope = {}) {
  if (!normalizeObjectId(sessionId)) return
  const query = { _id: sessionId, revokedAt: null }
  if (scope.restaurantId) query.restaurantId = scope.restaurantId
  if (scope.branchId) query.branchId = scope.branchId
  if (scope.branchAuthId) query.branchAuthId = scope.branchAuthId
  await BranchSession.updateOne(
    query,
    { $set: { lastActivityAt: new Date() } },
  ).catch(() => {})
}

module.exports = {
  generateSecurePassword,
  buildUniquePublicBranchId,
  hashPassword,
  verifyPassword,
  issueBranchToken,
  validateBranchSession,
  touchBranchSession,
  normalizeBranchUsernameLocal,
  allocateUniqueBranchEmail,
  BRANCH_EMAIL_DOMAIN,
}
