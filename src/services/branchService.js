const mongoose = require('mongoose');
const crypto = require('crypto');
const slugify = require('slugify');
const Branch = require('../models/restaurant/Branch');
const Restaurant = require('../models/restaurant/Restaurant');
const Table = require('../models/restaurant/Table');
const Category = require('../models/restaurant/Category');
const MenuItem = require('../models/restaurant/MenuItem');
const Promotion = require('../models/restaurant/Promotion');
const { buildUniquePublicBranchId } = require('./branchAuthService');
const { resolveTableFromQrToken } = require('./qrService');
const { allEnabledModules } = require('../constants/branchModules');

function normalizeObjectId(value) {
  if (!value) return null;
  if (!mongoose.Types.ObjectId.isValid(String(value))) return null;
  return new mongoose.Types.ObjectId(String(value));
}

async function ensureBranchPortalKey(restaurantId) {
  const rid = normalizeObjectId(restaurantId);
  if (!rid) return null;
  const doc = await Restaurant.findById(rid).select('branchPortalKey').lean();
  if (!doc) return null;
  const existing = String(doc.branchPortalKey || '').trim().toLowerCase();
  if (/^[a-f0-9]{12}$/.test(existing)) return existing;
  const key = crypto.randomBytes(6).toString('hex');
  await Restaurant.updateOne({ _id: rid }, { $set: { branchPortalKey: key } });
  return key;
}

async function buildUniqueBranchSlug(restaurant, branchName) {
  const base = slugify(`${restaurant.slug || restaurant.name}-${branchName}`, { lower: true, strict: true });
  let candidate = base;
  let counter = 1;
  while (await Branch.exists({ slug: candidate })) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}

async function backfillBranchScopedCatalog(restaurantId, defaultBranchId) {
  const rid = normalizeObjectId(restaurantId);
  const bid = normalizeObjectId(defaultBranchId);
  if (!rid || !bid) return;

  const needsCat = await Category.exists({
    restaurant: rid,
    $or: [{ branchId: { $exists: false } }, { branchId: null }],
  });
  const needsItem = await MenuItem.exists({
    restaurant: rid,
    $or: [{ branchId: { $exists: false } }, { branchId: null }],
  });
  const needsPromo = await Promotion.exists({
    restaurant: rid,
    $or: [{ branchId: { $exists: false } }, { branchId: null }],
  });
  if (!needsCat && !needsItem && !needsPromo) return;

  if (needsCat) {
    await Category.updateMany(
      { restaurant: rid, $or: [{ branchId: { $exists: false } }, { branchId: null }] },
      { $set: { branchId: bid } },
    );
  }

  if (needsItem) {
    const items = await MenuItem.find({
      restaurant: rid,
      $or: [{ branchId: { $exists: false } }, { branchId: null }],
    })
      .select('_id category')
      .lean();
    const bulk = [];
    for (const it of items) {
      const cat = await Category.findOne({ _id: it.category, restaurant: rid }).select('branchId').lean();
      const b = cat?.branchId ? normalizeObjectId(cat.branchId) : bid;
      bulk.push({
        updateOne: {
          filter: { _id: it._id },
          update: { $set: { branchId: b } },
        },
      });
    }
    if (bulk.length) await MenuItem.bulkWrite(bulk);
  }

  if (needsPromo) {
    await Promotion.updateMany(
      { restaurant: rid, $or: [{ branchId: { $exists: false } }, { branchId: null }] },
      { $set: { branchId: bid } },
    );
  }
}

async function resolveCustomerMenuBranchId(restaurantId, { qrToken, branchId: explicitBranchId } = {}) {
  const rid = normalizeObjectId(restaurantId);
  if (!rid) return null;

  if (explicitBranchId && mongoose.Types.ObjectId.isValid(String(explicitBranchId))) {
    const b = await Branch.findOne({
      _id: normalizeObjectId(explicitBranchId),
      restaurantId: rid,
      isDeleted: false,
    })
      .select('_id')
      .lean();
    if (b) return b._id;
  }

  if (qrToken) {
    const table = await resolveTableFromQrToken(String(qrToken));
    const tr = table?.restaurant || table?.restaurantId;
    if (table && String(tr) === String(rid)) {
      if (table.branchId) return normalizeObjectId(table.branchId);
      const def = await ensureDefaultBranch(rid);
      return def?._id ? normalizeObjectId(def._id) : null;
    }
  }

  const def = await ensureDefaultBranch(rid);
  return def?._id ? normalizeObjectId(def._id) : null;
}

async function branchMenuItemBaseFilter(table) {
  const restaurant = table.restaurant || table.restaurantId;
  const rid = normalizeObjectId(restaurant);
  let bid = normalizeObjectId(table.branchId);
  if (!bid) {
    const def = await ensureDefaultBranch(rid);
    bid = def?._id ? normalizeObjectId(def._id) : null;
  }
  return { restaurant: rid, branchId: bid };
}

async function ensureDefaultBranch(restaurantId) {
  const rid = normalizeObjectId(restaurantId);
  if (!rid) return null;

  const existing = await Branch.findOne({ restaurantId: rid, isDeleted: false }).sort({ isDefault: -1, createdAt: 1 });
  if (existing) {
    if (existing.isDefault) {
      const modules = existing.enabledModules || {};
      const fullModules = allEnabledModules();
      const missingOrDisabled = Object.keys(fullModules).some((key) => modules[key] !== true);
      if (missingOrDisabled) {
        existing.enabledModules = fullModules;
        await existing.save();
      }
    }
    await backfillBranchScopedCatalog(rid, existing._id);
    return existing;
  }

  const restaurant = await Restaurant.findById(rid).select('name slug phone email address city state country logo backgroundPhoto settings');
  if (!restaurant) return null;

  const slug = await buildUniqueBranchSlug(restaurant, 'main');
  const publicBranchId = await buildUniquePublicBranchId('Main');
  let created;
  try {
    created = await Branch.create({
      restaurantId: rid,
      name: 'Main Branch',
      slug,
      branchCode: 'MAIN',
      publicBranchId,
      phone: restaurant.phone || '',
      email: restaurant.email || '',
      address: restaurant.address || '',
      city: restaurant.city || '',
      state: restaurant.state || '',
      country: restaurant.country || 'Nepal',
      logo: restaurant.logo || '',
      banner: restaurant.backgroundPhoto || '',
      settings: {
        currency: restaurant.settings?.currency || 'Rs.',
        timezone: restaurant.settings?.timezone || 'Asia/Kathmandu',
        taxRate: restaurant.settings?.taxRate ?? null,
        serviceChargePercent: restaurant.settings?.serviceChargePercent ?? null,
        receiptFooter: restaurant.settings?.receiptFooter || '',
      },
      enabledModules: allEnabledModules(),
      isDefault: true,
      createdBy: rid,
      createdByModel: 'Restaurant',
    });
  } catch (err) {
    if (err?.code !== 11000) throw err;
    created = await Branch.findOne({
      restaurantId: rid,
      isDeleted: false,
      $or: [{ branchCode: 'MAIN' }, { isDefault: true }],
    }).sort({ isDefault: -1, createdAt: 1 });
    if (!created) throw err;
    if (!created.isDefault) {
      created.isDefault = true;
      created.enabledModules = allEnabledModules();
      await created.save();
    }
  }
  await backfillBranchScopedCatalog(rid, created._id);
  return created;
}

module.exports = {
  ensureDefaultBranch,
  normalizeObjectId,
  buildUniqueBranchSlug,
  ensureBranchPortalKey,
  backfillBranchScopedCatalog,
  resolveCustomerMenuBranchId,
  branchMenuItemBaseFilter,
};
