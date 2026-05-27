const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const Branch = require('../../models/restaurant/Branch');
const Category = require('../../models/restaurant/Category');
const MenuItem = require('../../models/restaurant/MenuItem');
const Table = require('../../models/restaurant/Table');
const Employee = require('../../models/restaurant/Employee');
const InventoryItem = require('../../models/restaurant/InventoryItem');
const { ensureDefaultBranch } = require('../branchService');
const { getRestoreConfigs, configByKey } = require('./collectionRegistry');
const { PARTIAL_RESTORE_GROUPS } = require('../../constants/backupConstants');

function isObjectIdString(value) {
  return typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
}

function isEmptyPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null) && Object.keys(value).length === 0;
}

function sourceIdKey(value, collectionKey, index) {
  if (isObjectIdString(value)) return value;
  if (value && typeof value === 'object') {
    if (isObjectIdString(value.$oid)) return value.$oid;
    if (isObjectIdString(value.toString?.())) return value.toString();
  }
  return `${collectionKey}:${index}`;
}

function remapValue(value, idMap, targetRestaurantId, targetBranchId) {
  if (Array.isArray(value)) return value.map((item) => remapValue(item, idMap, targetRestaurantId, targetBranchId));
  if (!value || typeof value !== 'object') {
    if (isObjectIdString(value) && idMap.has(value)) return idMap.get(value);
    return value;
  }
  if (isEmptyPlainObject(value)) return undefined;
  if (value instanceof Date) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '_id') continue;
    if (key === 'restaurant' || key === 'restaurantId') out[key] = targetRestaurantId;
    else if (key === 'branchId' && targetBranchId) out[key] = targetBranchId;
    else out[key] = remapValue(item, idMap, targetRestaurantId, targetBranchId);
  }
  return out;
}

function cleanupRestoreDoc(doc) {
  for (const [key, value] of Object.entries(doc)) {
    if (value === undefined || isEmptyPlainObject(value)) delete doc[key];
  }
  if (doc.createdAt && Number.isNaN(new Date(doc.createdAt).getTime())) delete doc.createdAt;
  if (doc.updatedAt && Number.isNaN(new Date(doc.updatedAt).getTime())) delete doc.updatedAt;
  delete doc.__v;
  return doc;
}

function suffixField(value, nextId, sep = '-R') {
  if (!value) return value;
  return `${value}${sep}${String(nextId).slice(-6)}`;
}

function makeRestoreDoc(config, source, idMap, targetRestaurantId, targetBranchId, mode, index, context) {
  const oldId = sourceIdKey(source._id, config.key, index);
  const nextId = idMap.get(oldId) || new mongoose.Types.ObjectId();
  idMap.set(oldId, nextId);
  const doc = remapValue(source, idMap, targetRestaurantId, targetBranchId);
  const hasBranchPath = Boolean(config.model?.schema?.path('branchId'));
  doc._id = nextId;
  if (config.key === 'restaurant') return null;

  if (targetBranchId && hasBranchPath) doc.branchId = targetBranchId;
  if (config.model?.schema?.path('restaurant')) doc.restaurant = targetRestaurantId;
  if (config.model?.schema?.path('restaurantId')) doc.restaurantId = targetRestaurantId;
  cleanupRestoreDoc(doc);

  const suffix = mode === 'merge' || mode === 'migration' || mode === 'partial';

  if (config.key === 'employees') {
    doc.password = bcrypt.hashSync(crypto.randomBytes(18).toString('hex'), 10);
    doc.isPasswordChanged = false;
    doc.username = suffixField(doc.username || 'restored', nextId, '-');
  }
  if (config.key === 'branchAuth') {
    doc.passwordHash = bcrypt.hashSync(crypto.randomBytes(18).toString('hex'), 10);
    doc.username = suffixField(doc.username || 'restored', nextId, '-');
    if (doc.branchEmail) doc.branchEmail = `restored-${String(nextId).slice(-6)}-${doc.branchEmail}`;
  }
  if (config.key === 'branches') {
    doc.slug = suffixField(doc.slug || 'branch', nextId, '-');
    doc.branchCode = `${doc.branchCode || 'BR'}-${String(nextId).slice(-4)}`.toUpperCase();
    doc.publicBranchId = undefined;
  }
  if (config.key === 'tables') {
    doc.qrToken = undefined;
    doc.qrTokenHash = undefined;
    doc.qrCode = undefined;
    doc.currentCustomerOrder = undefined;
    doc.assignedWaiter = undefined;
    if (suffix && doc.tableNumber) doc.tableNumber = suffixField(doc.tableNumber, nextId);
  }
  if (config.key === 'menuItems') {
    if (!mongoose.Types.ObjectId.isValid(String(doc.category || ''))) {
      doc.category = context.defaultCategoryId || null;
    }
  }
  if (config.key === 'inventoryItems' && suffix && doc.name) {
    doc.name = suffixField(doc.name, nextId);
  }
  if (config.key === 'invoices' && doc.invoiceNumber) {
    doc.invoiceNumber = suffixField(doc.invoiceNumber, nextId);
  }
  if (config.key === 'posInvoices' && doc.invoiceNumber) {
    doc.invoiceNumber = suffixField(doc.invoiceNumber, nextId);
  }
  if (config.key === 'promotions' && suffix && doc.code) {
    doc.code = suffixField(String(doc.code).toUpperCase(), nextId);
  }
  if (config.key === 'chartOfAccounts' && suffix && doc.code) {
    doc.code = suffixField(doc.code, nextId);
  }
  if (['orders', 'customerOrders'].includes(config.key)) {
    if (doc.orderNumber) doc.orderNumber = suffixField(doc.orderNumber, nextId);
    doc.qrToken = `restored-${String(nextId)}`;
    if (doc.checkoutRequestId) doc.checkoutRequestId = suffixField(doc.checkoutRequestId, nextId);
  }

  return doc;
}

function tenantQuery(config, restaurantId, branchId) {
  const filter = config.filter ? config.filter(restaurantId) : { [config.tenantField]: restaurantId };
  const hasBranchPath = Boolean(config.model?.schema?.path('branchId'));
  if (branchId && hasBranchPath && !['restaurant', 'subscriptions'].includes(config.section)) {
    filter.$or = [{ branchId }, { branchId: null }, { branchId: { $exists: false } }];
  }
  return filter;
}

function resolveSections(mode, sections, partialGroups) {
  if (mode === 'full' || mode === 'replace' || mode === 'migration') {
    return null;
  }
  if (mode === 'partial' && partialGroups?.length) {
    const out = new Set();
    for (const group of partialGroups) {
      const mapped = PARTIAL_RESTORE_GROUPS[group];
      if (mapped) mapped.forEach((s) => out.add(s));
    }
    return [...out];
  }
  if (sections?.length) return sections;
  return null;
}

async function detectConflicts(config, doc, targetRestaurantId, targetBranchId) {
  const conflicts = [];
  if (!doc) return conflicts;

  if (config.key === 'menuItems' && doc.name) {
    const exists = await MenuItem.exists({
      restaurant: targetRestaurantId,
      branchId: targetBranchId || doc.branchId,
      name: doc.name,
      isDeleted: false,
    });
    if (exists) conflicts.push({ type: 'duplicate_menu_name', field: 'name', value: doc.name });
  }
  if (config.key === 'employees' && doc.username) {
    const exists = await Employee.exists({
      restaurant: targetRestaurantId,
      branchId: targetBranchId || doc.branchId,
      username: doc.username,
    });
    if (exists) conflicts.push({ type: 'duplicate_employee_username', field: 'username', value: doc.username });
  }
  if (config.key === 'tables' && doc.tableNumber) {
    const exists = await Table.exists({
      restaurant: targetRestaurantId,
      branchId: targetBranchId || doc.branchId,
      tableNumber: doc.tableNumber,
      isDeleted: false,
    });
    if (exists) conflicts.push({ type: 'duplicate_table_number', field: 'tableNumber', value: doc.tableNumber });
  }
  if (config.key === 'invoices' && doc.invoiceNumber) {
    const Invoice = config.model;
    const exists = await Invoice.exists({ invoiceNumber: doc.invoiceNumber });
    if (exists) conflicts.push({ type: 'duplicate_invoice_number', field: 'invoiceNumber', value: doc.invoiceNumber });
  }
  if (config.key === 'inventoryItems' && doc.name) {
    const exists = await InventoryItem.exists({
      restaurantId: targetRestaurantId,
      branchId: targetBranchId || doc.branchId,
      name: doc.name,
      isDeleted: false,
    });
    if (exists) conflicts.push({ type: 'duplicate_inventory_name', field: 'name', value: doc.name });
  }

  return conflicts;
}

async function applyConflictStrategy(config, doc, strategy, targetRestaurantId, targetBranchId) {
  if (!doc) return { doc: null, skipped: true };
  const conflicts = await detectConflicts(config, doc, targetRestaurantId, targetBranchId);
  if (!conflicts.length) return { doc, skipped: false, conflicts: [] };

  if (strategy === 'skip') return { doc: null, skipped: true, conflicts };
  if (strategy === 'rename' || strategy === 'duplicate') {
    const id = doc._id || new mongoose.Types.ObjectId();
    if (config.key === 'menuItems' && doc.name) doc.name = suffixField(doc.name, id);
    if (config.key === 'employees' && doc.username) doc.username = suffixField(doc.username, id, '-');
    if (config.key === 'tables' && doc.tableNumber) doc.tableNumber = suffixField(doc.tableNumber, id);
    if (config.key === 'invoices' && doc.invoiceNumber) doc.invoiceNumber = suffixField(doc.invoiceNumber, id);
    if (config.key === 'inventoryItems' && doc.name) doc.name = suffixField(doc.name, id);
    if (config.key === 'promotions' && doc.code) doc.code = suffixField(String(doc.code).toUpperCase(), id);
    return { doc, skipped: false, conflicts, renamed: true };
  }
  if (strategy === 'replace') {
    const filter = { ...tenantQuery(config, targetRestaurantId, targetBranchId) };
    if (config.key === 'menuItems') filter.name = doc.name;
    if (config.key === 'employees') filter.username = doc.username;
    if (config.key === 'tables') filter.tableNumber = doc.tableNumber;
    if (config.key === 'inventoryItems') filter.name = doc.name;
    if (config.key === 'invoices') {
      await config.model.deleteMany({ invoiceNumber: doc.invoiceNumber });
      return { doc, skipped: false, conflicts };
    }
    await config.model.deleteMany(filter);
    return { doc, skipped: false, conflicts };
  }
  return { doc, skipped: false, conflicts };
}

async function resolveTargetBranch(req, targetRestaurantId, options) {
  let targetBranchId = options.targetBranchId || req.branchId || null;
  const mode = options.mode || 'merge';

  if (targetBranchId) {
    const active = await Branch.findOne({
      _id: targetBranchId,
      restaurantId: targetRestaurantId,
      isDeleted: false,
      status: 'active',
    }).select('_id');
    targetBranchId = active?._id || null;
  }
  if (!targetBranchId && mode !== 'create_new_branch') {
    const defaultBranch = await ensureDefaultBranch(targetRestaurantId);
    targetBranchId = defaultBranch?._id || null;
  }
  if (mode === 'create_new_branch') {
    const sourceBranch = Array.isArray(options.payload?.data?.branches) ? options.payload.data.branches[0] : null;
    const branch = await Branch.create({
      restaurantId: targetRestaurantId,
      name: options.branchName || `Restored Branch ${new Date().toISOString().slice(0, 10)}`,
      slug: `restored-${Date.now()}`,
      branchCode: `RB${String(Date.now()).slice(-6)}`,
      phone: sourceBranch?.phone || '',
      email: sourceBranch?.email || '',
      address: sourceBranch?.address || '',
      city: sourceBranch?.city || '',
      state: sourceBranch?.state || '',
      country: sourceBranch?.country || 'Nepal',
      enabledModules: sourceBranch?.enabledModules || {},
      settings: sourceBranch?.settings || {},
      createdBy: options.actorId,
      createdByModel: options.actorModel,
    });
    targetBranchId = branch._id;
  }
  return targetBranchId;
}

function validateTenantAccess(req, payload, targetRestaurantId, mode) {
  const sourceRestaurantId = String(payload.metadata?.restaurantId || payload.manifest?.restaurantId || '');
  const currentRestaurantId = String(req.user?.restaurantId || req.user?.id || '');
  const isMigration = mode === 'migration';
  const superadminApproved =
    req.user?.role === 'super_admin' ||
    req.body?.allowCrossTenantRestore === true ||
    req.body?.allowCrossTenantRestore === 'true' ||
    isMigration;

  if (
    sourceRestaurantId &&
    sourceRestaurantId !== targetRestaurantId &&
    currentRestaurantId !== targetRestaurantId &&
    !superadminApproved
  ) {
    throw new Error('Cross-tenant migration requires migration mode with verified authorization');
  }

  if (isMigration && sourceRestaurantId === targetRestaurantId) {
    throw new Error('Migration mode is for restoring into a different restaurant account');
  }

  return { sourceRestaurantId, superadminApproved };
}

function buildPreviewSummary(payload) {
  const data = payload.data || {};
  const count = (key) => {
    const v = data[key];
    return Array.isArray(v) ? v.length : v ? 1 : 0;
  };
  return {
    metadata: payload.metadata,
    manifest: payload.manifest,
    counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Array.isArray(v) ? v.length : v ? 1 : 0])),
    summary: {
      menuCount: count('categories') + count('menuItems'),
      orderCount: count('orders') + count('customerOrders'),
      customerCount: count('creditCustomers'),
      inventoryCount: count('inventoryItems'),
      employeeCount: count('employees'),
      branchCount: count('branches'),
      tableCount: count('tables'),
      backupSize: payload.manifest?.documentCount || 0,
      backupDate: payload.metadata?.createdAt || payload.manifest?.createdAt,
    },
    mediaRefCount: (payload.mediaRefs || []).length,
  };
}

async function runMigrationRestore(req, payload, options = {}) {
  const targetRestaurantId = String(options.targetRestaurantId || req.user?.restaurantId || req.user?.id);
  const mode = options.mode || 'merge';
  const conflictStrategy = options.conflictStrategy || 'rename';
  const onProgress = options.onProgress || (() => {});

  validateTenantAccess(req, payload, targetRestaurantId, mode);

  const sectionFilter = resolveSections(mode, options.sections, options.partialGroups);
  const restoreConfigs = getRestoreConfigs(sectionFilter);

  const targetBranchId = await resolveTargetBranch(req, targetRestaurantId, {
    ...options,
    mode,
    payload,
    actorId: options.actorId,
    actorModel: options.actorModel,
  });

  const idMap = new Map();
  const restoredCounts = {};
  const allConflicts = [];
  const warnings = [];
  const modifiedCollections = [];

  for (const [collectionKey, rows] of Object.entries(payload.data || {})) {
    const arr = Array.isArray(rows) ? rows : rows ? [rows] : [];
    for (let index = 0; index < arr.length; index += 1) {
      const row = arr[index];
      if (row?._id !== undefined) {
        idMap.set(sourceIdKey(row._id, collectionKey, index), new mongoose.Types.ObjectId());
      }
    }
  }

  const firstCategoryId =
    Array.isArray(payload.data?.categories) && payload.data.categories.length
      ? idMap.get(sourceIdKey(payload.data.categories[0]._id, 'categories', 0))
      : null;
  const restoreContext = { defaultCategoryId: firstCategoryId };

  const totalSteps = restoreConfigs.length + 2;
  let stepIndex = 0;

  const reportProgress = (label, stepKey) => {
    stepIndex += 1;
    onProgress({
      percent: Math.min(99, Math.round((stepIndex / totalSteps) * 100)),
      currentStep: stepKey,
      currentLabel: label,
      stepsCompleted: stepIndex,
      stepsTotal: totalSteps,
    });
  };

  reportProgress('Validating tenant scope', 'validate');

  if (mode === 'replace') {
    reportProgress('Removing existing tenant data for replace mode', 'replace');
    for (const config of restoreConfigs) {
      await config.model.deleteMany(tenantQuery(config, targetRestaurantId, targetBranchId));
    }
  }

  for (const config of restoreConfigs) {
    reportProgress(`Restoring ${config.key}`, config.section);
    const rows = payload.data[config.key];
    const arr = Array.isArray(rows) ? rows : rows ? [rows] : [];
    if (!arr.length) continue;

    const docs = [];
    for (let index = 0; index < arr.length; index += 1) {
      let doc = makeRestoreDoc(
        config,
        arr[index],
        idMap,
        targetRestaurantId,
        targetBranchId,
        mode,
        index,
        restoreContext,
      );
      if (!doc) continue;

      if (config.singleton) {
        const existing = await config.model.findOne({ restaurantId: targetRestaurantId }).lean();
        if (existing) {
          if (conflictStrategy === 'skip') continue;
          if (conflictStrategy === 'replace') {
            await config.model.deleteOne({ _id: existing._id });
          } else {
            warnings.push(`Skipped singleton ${config.key}: already exists`);
            continue;
          }
        }
      }

      const resolved = await applyConflictStrategy(
        config,
        doc,
        conflictStrategy,
        targetRestaurantId,
        targetBranchId,
      );
      if (resolved.conflicts?.length) allConflicts.push(...resolved.conflicts.map((c) => ({ ...c, collection: config.key })));
      if (resolved.skipped || !resolved.doc) continue;
      doc = resolved.doc;

      if (config.key === 'menuItems' && !mongoose.Types.ObjectId.isValid(String(doc.category || ''))) {
        warnings.push(`Skipped menu item without valid category: ${doc.name || 'unknown'}`);
        continue;
      }

      docs.push(doc);
    }

    if (!docs.length) continue;

    try {
      await config.model.insertMany(docs, { ordered: false });
      restoredCounts[config.key] = docs.length;
      modifiedCollections.push(config.key);
    } catch (err) {
      if (err.code === 11000 && conflictStrategy === 'skip') {
        warnings.push(`Partial insert for ${config.key}: duplicates skipped`);
      } else {
        throw new Error(`${config.key} restore failed: ${err.message}`);
      }
    }
  }

  reportProgress('Processing relationships', 'relationships');
  reportProgress('Finalizing restore', 'finalize');

  onProgress({
    percent: 100,
    currentStep: 'complete',
    currentLabel: 'Restore complete',
    stepsCompleted: totalSteps,
    stepsTotal: totalSteps,
  });

  return {
    targetRestaurantId,
    targetBranchId,
    restoredCounts,
    idMapSummary: { mappedIds: idMap.size },
    conflicts: allConflicts,
    warnings,
    modifiedCollections,
    visibleCounts: {
      categories: await Category.countDocuments({ restaurant: targetRestaurantId, branchId: targetBranchId, isDeleted: false }),
      menuItems: await MenuItem.countDocuments({ restaurant: targetRestaurantId, branchId: targetBranchId, isDeleted: false }),
      tables: await Table.countDocuments({ restaurant: targetRestaurantId, branchId: targetBranchId, isDeleted: false }),
      inventoryItems: await InventoryItem.countDocuments({ restaurantId: targetRestaurantId, branchId: targetBranchId, isDeleted: false }),
    },
  };
}

module.exports = {
  runMigrationRestore,
  buildPreviewSummary,
  validateTenantAccess,
  resolveTargetBranch,
  makeRestoreDoc,
  tenantQuery,
  resolveSections,
  detectConflicts,
};
