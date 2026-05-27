const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const BackupRecord = require('../models/restaurant/BackupRecord');
const BackupSchedule = require('../models/restaurant/BackupSchedule');
const RestoreLog = require('../models/restaurant/RestoreLog');
const RestoreJob = require('../models/restaurant/RestoreJob');
const RestoreAudit = require('../models/restaurant/RestoreAudit');
const Branch = require('../models/restaurant/Branch');
const BranchAuth = require('../models/restaurant/BranchAuth');
const Category = require('../models/restaurant/Category');
const MenuItem = require('../models/restaurant/MenuItem');
const Table = require('../models/restaurant/Table');
const InventoryItem = require('../models/restaurant/InventoryItem');
const AuditLog = require('../models/platform/AuditLog');

const {
  BACKUP_VERSION,
  SCHEMA_VERSION,
  ALL_SECTIONS,
  MAGIC,
  FILE_EXTENSIONS,
} = require('../constants/backupConstants');
const { getBackupConfigs } = require('./backup/collectionRegistry');
const { sanitize, collectMediaRefs } = require('./backup/backupSanitize');
const {
  encryptZip,
  buildZip,
  loadBackupPayload,
  buildManifestExtras,
  sha256,
  sign,
} = require('./backup/backupFormat');
const { buildPreviewSummary, runMigrationRestore } = require('./backup/migrationEngine');
const { uploadToCloud } = require('./backup/cloudStorageService');

function backupRoot() {
  return path.resolve(process.cwd(), process.env.BACKUP_STORAGE_PATH || './secure_backups');
}

function actorId(req) {
  return req.user?.employeeId || req.user?.id;
}

function actorModel(req) {
  return req.user?.scope === 'branch_user' ? 'BranchAuth' : req.user?.scope === 'employee' ? 'Employee' : 'Restaurant';
}

function normalizeSections(type, sections = []) {
  if (type === 'full' || type === 'snapshot' || type === 'scheduled' || !sections.length) return ALL_SECTIONS;
  return sections.filter((section) => ALL_SECTIONS.includes(section));
}

function tenantQuery(config, restaurantId, branchId, since) {
  const filter = config.filter ? config.filter(restaurantId) : { [config.tenantField]: restaurantId };
  const hasBranchPath = Boolean(config.model?.schema?.path('branchId'));
  if (branchId && hasBranchPath && !['restaurant', 'subscriptions'].includes(config.section)) {
    filter.$or = [{ branchId }, { branchId: null }, { branchId: { $exists: false } }];
  }
  if (since) filter.updatedAt = { $gte: since };
  return filter;
}

async function collectData({ restaurantId, branchId, type, sections, since }) {
  const included = normalizeSections(type, sections);
  const configs = getBackupConfigs(included);
  const data = {};
  const collectionCounts = {};
  let documentCount = 0;
  let branchCount = 0;

  for (const config of configs) {
    const query = tenantQuery(config, restaurantId, branchId, type === 'incremental' ? since : null);
    const rows = await config.model.find(query).lean({ virtuals: false });
    const sanitized = rows.map(sanitize);
    data[config.key] = config.single ? sanitized[0] || null : sanitized;
    collectionCounts[config.key] = config.single ? (sanitized[0] ? 1 : 0) : sanitized.length;
    documentCount += collectionCounts[config.key];
    if (config.key === 'branches') branchCount = collectionCounts[config.key];
  }

  const mediaRefs = collectMediaRefs(data);
  return { data, included, collectionCounts, documentCount, branchCount, mediaRefs };
}

async function createBackup(req, options = {}) {
  const restaurantId = options.restaurantId || req.user?.restaurantId || req.user?.id;
  const branchId = options.branchId === undefined ? req.branchId : options.branchId;
  const type = options.type || 'full';
  const lastBackup =
    type === 'incremental'
      ? await BackupRecord.findOne({ restaurantId, status: 'completed' }).sort({ createdAt: -1 }).lean()
      : null;
  const since = options.since ? new Date(options.since) : lastBackup?.createdAt || null;

  const record = await BackupRecord.create({
    restaurantId,
    branchId: branchId || null,
    createdBy: actorId(req) || restaurantId,
    createdByModel: actorModel(req),
    type,
    status: 'running',
    label: options.label || '',
    includedSections: normalizeSections(type, options.sections || []),
    backupVersion: BACKUP_VERSION,
    appVersion: process.env.APP_VERSION || require('../../package.json').version || '1.0.0',
    storageProvider: options.storageProvider || 'local',
    incrementalSince: since,
  });

  try {
    const collected = await collectData({ restaurantId, branchId, type, sections: options.sections || [], since });
    const metadata = {
      backupId: String(record._id),
      restaurantId: String(restaurantId),
      branchId: branchId ? String(branchId) : null,
      createdBy: String(actorId(req) || restaurantId),
      createdAt: new Date().toISOString(),
      backupVersion: BACKUP_VERSION,
      schemaVersion: SCHEMA_VERSION,
      type,
      encrypted: true,
      incrementalSince: since ? since.toISOString() : null,
    };
    const manifest = {
      ...metadata,
      ...buildManifestExtras(collected, restaurantId, collected.branchCount),
      exclusions: ['auth passwords', 'active sessions', 'OTPs', 'API credentials'],
    };
    const zipBuffer = await buildZip({
      metadata,
      manifest,
      data: collected.data,
      mediaRefs: collected.mediaRefs,
    });
    const encryptedPackage = await encryptZip(zipBuffer, manifest);
    await fs.mkdir(backupRoot(), { recursive: true, mode: 0o700 });
    const filename = `backup-${restaurantId}-${record._id}.qrbackup`;
    const fullPath = path.join(backupRoot(), filename);
    await fs.writeFile(fullPath, encryptedPackage, { flag: 'wx', mode: 0o600 });

    const cloudMeta = await uploadToCloud(fullPath, {
      restaurantId,
      filename,
      storageProvider: record.storageProvider,
    });

    record.status = 'completed';
    record.storagePath = fullPath;
    record.downloadName = filename;
    record.checksum = sha256(zipBuffer);
    record.manifestSignature = sign(JSON.stringify(manifest));
    record.size = encryptedPackage.length;
    record.documentCount = collected.documentCount;
    record.collectionCounts = collected.collectionCounts;
    record.verifiedAt = new Date();
    record.verificationReport = { ok: true, encrypted: true, cloud: cloudMeta, zipChecksum: record.checksum };
    await record.save();

    await writeBackupAudit(req, 'backup_create', record, { type, sections: collected.included });
    return record;
  } catch (err) {
    record.status = 'failed';
    record.failureReason = err.message;
    await record.save();
    await writeBackupAudit(req, 'backup_create_failed', record, { message: err.message });
    throw err;
  }
}

function signedDownloadToken(record, ttlSeconds = 300) {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${record._id}.${record.restaurantId}.${expires}`;
  return `${expires}.${sign(payload)}`;
}

function verifyDownloadToken(record, token) {
  const [expiresRaw, signature] = String(token || '').split('.');
  const expires = Number(expiresRaw);
  if (!expires || expires < Math.floor(Date.now() / 1000)) return false;
  return sign(`${record._id}.${record.restaurantId}.${expires}`) === signature;
}

function previewPayload(payload) {
  return buildPreviewSummary(payload);
}

async function validateBackupBuffer(buffer, { expectedRestaurantId } = {}) {
  const payload = await loadBackupPayload(buffer);
  if (expectedRestaurantId) {
    const src = String(payload.metadata?.restaurantId || payload.manifest?.restaurantId || '');
    if (src && src !== String(expectedRestaurantId)) {
      payload.crossTenant = true;
      payload.sourceRestaurantId = src;
    }
  }
  return { valid: true, preview: buildPreviewSummary(payload), payload };
}

async function restorePayload(req, payload, options = {}) {
  const result = await runMigrationRestore(req, payload, options);
  const restoreLog = await RestoreLog.create({
    restaurantId: options.targetRestaurantId || req.user?.restaurantId || req.user?.id,
    branchId: result.targetBranchId || null,
    backupRecordId: options.backupRecordId || null,
    requestedBy: actorId(req),
    requestedByModel: actorModel(req),
    mode: options.mode || 'merge',
    status: 'completed',
    sourceRestaurantId: payload.metadata?.restaurantId,
    targetRestaurantId: result.targetRestaurantId,
    targetBranchId: result.targetBranchId,
    checksum: payload.checksum,
    restoredCounts: result.restoredCounts,
    idMapSummary: result.idMapSummary,
    preview: { visibleCounts: result.visibleCounts, warnings: result.warnings },
    ipAddress: req.ip,
    userAgent: req.get?.('User-Agent') || '',
  });
  await writeBackupAudit(req, 'backup_restore', null, { mode: options.mode, restoreLogId: restoreLog._id });
  return restoreLog;
}

async function writeBackupAudit(req, action, record, details = {}) {
  if (!req?.user) return;
  await AuditLog.create({
    user: actorId(req),
    userModel: actorModel(req),
    action,
    resource: 'system',
    resourceId: record?._id,
    details: {
      restaurantId: String(req.user.restaurantId || req.user.id),
      backupId: record?._id ? String(record._id) : undefined,
      ...details,
    },
    ipAddress: req.ip,
    userAgent: req.get?.('User-Agent'),
  });
  await RestoreAudit.create({
    restaurantId: req.user.restaurantId || req.user.id,
    action: action.replace('backup_', 'backup_'),
    actorId: actorId(req),
    actorModel: actorModel(req),
    resourceId: record?._id,
    details,
    ipAddress: req.ip || '',
    userAgent: req.get?.('User-Agent') || '',
  }).catch(() => {});
}

function nextRunDate(frequency, from = new Date()) {
  const d = new Date(from);
  if (frequency === 'daily') d.setDate(d.getDate() + 1);
  else if (frequency === 'weekly') d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

async function runDueSchedules() {
  const due = await BackupSchedule.find({ isActive: true, nextRunAt: { $lte: new Date() } }).limit(10);
  for (const schedule of due) {
    const fakeReq = {
      user: {
        id: schedule.createdBy,
        restaurantId: schedule.restaurantId,
        scope: schedule.createdByModel === 'BranchAuth' ? 'branch_user' : schedule.createdByModel === 'Employee' ? 'employee' : 'restaurant',
        role: schedule.createdByModel === 'BranchAuth' ? 'branch_admin' : 'restaurant',
      },
      branchId: schedule.branchId,
      ip: 'scheduler',
      get: () => 'backup-scheduler',
    };
    try {
      await createBackup(fakeReq, {
        restaurantId: schedule.restaurantId,
        branchId: schedule.branchId,
        type: schedule.backupType === 'incremental' ? 'incremental' : 'scheduled',
        sections: schedule.includedSections,
        storageProvider: schedule.storageProvider,
        label: `${schedule.frequency} scheduled backup`,
      });
      schedule.lastRunAt = new Date();
      schedule.nextRunAt = nextRunDate(schedule.frequency);
      await schedule.save();
      await enforceRetention(schedule.restaurantId);
    } catch {
      schedule.nextRunAt = nextRunDate(schedule.frequency);
      await schedule.save();
    }
  }
}

async function enforceRetention(restaurantId) {
  const max = Number(process.env.BACKUP_RETENTION_MAX || 30);
  const completed = await BackupRecord.find({
    restaurantId,
    status: 'completed',
    type: { $in: ['scheduled', 'snapshot'] },
  })
    .sort({ createdAt: -1 })
    .select('+storagePath');
  const keep = new Set(completed.slice(0, max).map((row) => String(row._id)));
  for (const row of completed) {
    if (keep.has(String(row._id))) continue;
    row.status = 'deleted';
    await row.save();
    if (row.storagePath) fs.unlink(row.storagePath).catch(() => {});
  }
}

async function cloneBranch(req, { sourceBranchId, branchName }) {
  const restaurantId = req.user?.restaurantId || req.user?.id;
  const source = await Branch.findOne({ _id: sourceBranchId, restaurantId, isDeleted: false }).lean();
  if (!source) throw new Error('Source branch not found');
  const suffix = String(Date.now()).slice(-6);
  const target = await Branch.create({
    restaurantId,
    name: branchName || `${source.name} Copy`,
    slug: `${source.slug || 'branch'}-${suffix}`,
    branchCode: `${source.branchCode || 'BR'}${suffix}`.slice(0, 20).toUpperCase(),
    phone: source.phone || '',
    email: source.email || '',
    address: source.address || '',
    city: source.city || '',
    state: source.state || '',
    country: source.country || 'Nepal',
    latitude: source.latitude,
    longitude: source.longitude,
    openingHours: source.openingHours || {},
    enabledModules: source.enabledModules || {},
    subscriptionLimits: source.subscriptionLimits || {},
    settings: source.settings || {},
    about: source.about || {},
    privacyPolicy: source.privacyPolicy || {},
    createdBy: actorId(req),
    createdByModel: actorModel(req),
  });

  const idMap = new Map([[String(source._id), target._id]]);
  const counts = { branches: 1, categories: 0, menuItems: 0, tables: 0, branchAuth: 0, inventoryItems: 0 };
  const categories = await Category.find({ restaurant: restaurantId, branchId: sourceBranchId, isDeleted: false }).lean();
  for (const category of categories) {
    const next = sanitize(category);
    const oldId = String(next._id);
    delete next._id;
    next.restaurant = restaurantId;
    next.branchId = target._id;
    const created = await Category.create(next);
    idMap.set(oldId, created._id);
    counts.categories += 1;
  }

  const inventoryItems = await InventoryItem.find({ restaurantId, branchId: sourceBranchId, isDeleted: false }).lean();
  for (const item of inventoryItems) {
    const next = sanitize(item);
    const oldId = String(next._id);
    delete next._id;
    next.restaurantId = restaurantId;
    next.branchId = target._id;
    next.quantity = 0;
    next.openingStock = 0;
    const created = await InventoryItem.create(next);
    idMap.set(oldId, created._id);
    counts.inventoryItems += 1;
  }

  const menuItems = await MenuItem.find({ restaurant: restaurantId, branchId: sourceBranchId, isDeleted: false }).lean();
  for (const item of menuItems) {
    const next = sanitize(item);
    delete next._id;
    next.restaurant = restaurantId;
    next.branchId = target._id;
    if (next.category) next.category = idMap.get(String(next.category)) || next.category;
    if (Array.isArray(next.recipe)) {
      next.recipe = next.recipe.map((line) => ({
        ...line,
        inventoryItem: idMap.get(String(line.inventoryItem)) || line.inventoryItem,
      }));
    }
    await MenuItem.create(next);
    counts.menuItems += 1;
  }

  const tables = await Table.find({ restaurant: restaurantId, branchId: sourceBranchId, isDeleted: false }).lean();
  for (const table of tables) {
    const next = sanitize(table);
    delete next._id;
    next.restaurant = restaurantId;
    next.restaurantId = restaurantId;
    next.branchId = target._id;
    next.qrCode = undefined;
    next.qrToken = undefined;
    next.qrTokenHash = undefined;
    next.currentCustomerOrder = undefined;
    next.assignedWaiter = undefined;
    await Table.create(next);
    counts.tables += 1;
  }

  const branchUsers = await BranchAuth.find({ restaurantId, branchId: sourceBranchId, activeStatus: true }).lean();
  for (const user of branchUsers) {
    const next = sanitize(user);
    delete next._id;
    next.restaurantId = restaurantId;
    next.branchId = target._id;
    next.username = `${next.username || 'branch'}-${suffix}`;
    next.branchEmail = next.branchEmail ? `clone-${suffix}-${next.branchEmail}` : undefined;
    next.passwordHash = bcrypt.hashSync(crypto.randomBytes(18).toString('hex'), 10);
    next.lastLogin = null;
    await BranchAuth.create(next);
    counts.branchAuth += 1;
  }

  await writeBackupAudit(req, 'branch_clone', null, { sourceBranchId, targetBranchId: target._id, counts });
  return { branch: target, counts };
}

module.exports = {
  ALL_SECTIONS,
  BACKUP_VERSION,
  FILE_EXTENSIONS,
  MAGIC,
  createBackup,
  signedDownloadToken,
  verifyDownloadToken,
  loadBackupPayload,
  validateBackupBuffer,
  previewPayload,
  restorePayload,
  nextRunDate,
  runDueSchedules,
  enforceRetention,
  cloneBranch,
  backupRoot,
  collectData,
};
