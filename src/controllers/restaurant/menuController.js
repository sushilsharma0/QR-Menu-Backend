const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Category = require('../../models/restaurant/Category');
const MenuItem = require('../../models/restaurant/MenuItem');
const VariationGroup = require('../../models/restaurant/VariationGroup');
const CustomerOrder = require('../../models/restaurant/CustomerOrder');
const { success, error } = require('../../utils/apiResponse');
const Restaurant = require('../../models/restaurant/Restaurant');
const InventoryItem = require('../../models/restaurant/InventoryItem');
const AuditLog = require('../../models/platform/AuditLog');
const resolveRestaurantId = require('../../middleware/restaurant/resolveRestaurantId');
const { resolveCustomerMenuBranchId } = require('../../services/branchService');
const { escapeRegex, readNumber, readString } = require('../../utils/inputValidation');
const {
  calculateMenuItemPrice,
  normalizeSelections,
  roundMoney,
} = require('../../services/variationService');

const resolveEffectiveLimit = (restaurant, key) => {
  const savedLimit = Number(restaurant?.planLimits?.[key] ?? 0);
  if (savedLimit > 0) return savedLimit;
  const planLimit = Number(restaurant?.currentPlan?.limits?.[key] ?? 0);
  return planLimit > 0 ? planLimit : 0;
};

const asObjectId = (id) => {
  if (!id) return null;
  const s = id.toString ? id.toString() : String(id);
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
};

function staffMenuScope(req) {
  const restaurantId = asObjectId(resolveRestaurantId(req));
  const branchId = asObjectId(req.branchId);
  return { restaurantId, branchId };
}

function authModel(req) {
  return req.user?.scope === 'employee' ? 'Employee' : req.user?.scope === 'branch_user' ? 'BranchAuth' : 'Restaurant';
}

function readMoney(value, { required = false } = {}) {
  if ((value === undefined || value === null || value === '') && !required) return undefined;
  const parsed = readNumber(value, { min: 0, max: 1000000, fallback: NaN });
  return Number.isFinite(parsed) ? parsed : null;
}

function readImageUrl(value) {
  const url = readString(value, { max: 1000 });
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? url : '';
  } catch {
    return '';
  }
}

async function writeMenuAudit(req, action, resourceId, details = {}) {
  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action,
    resource: 'menu',
    resourceId,
    details,
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
  }).catch(() => {});
}

// ==================== CATEGORY CONTROLLERS ====================

const uniqueSuggestions = (suggestions) => {
  const seen = new Set();
  return suggestions.filter((image) => {
    const key = String(image.url || image.thumbnail || '').split('?')[0];
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const FOOD_SEARCH_STOP_WORDS = new Set([
  'with', 'and', 'the', 'for', 'from', 'special', 'plate', 'bowl', 'combo', 'meal', 'set',
]);

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const matchesFoodKeyword = (text, word) => {
  const token = String(word || '').trim().toLowerCase();
  if (!token) return false;
  return new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i').test(String(text || '').toLowerCase());
};

const buildImageSearchQuery = (name) => {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const words = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 2 && !FOOD_SEARCH_STOP_WORDS.has(word));
  if (!words.length) return `${raw} food`;
  return `${words.join(' ')} food`;
};

const findCuratedSuggestionSet = (query) => {
  const text = String(query || '').toLowerCase();
  let best = null;
  curatedSuggestionSets.forEach((group) => {
    const matched = group.match.filter((word) => matchesFoodKeyword(text, word));
    if (!matched.length) return;
    const score = Math.max(...matched.map((word) => word.length));
    if (!best || score > best.score) best = { group, score };
  });
  return best?.group || null;
};

const curatedSuggestionSets = [
  {
    match: ['burger', 'hamburger'],
    images: [
      'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=900&q=85',
      'https://images.unsplash.com/photo-1550547660-d9450f859349?auto=format&fit=crop&w=900&q=85',
      'https://images.unsplash.com/photo-1571091718767-18b5b1457add?auto=format&fit=crop&w=900&q=85',
      'https://images.unsplash.com/photo-1550317138-10000687a72b?auto=format&fit=crop&w=900&q=85',
      'https://images.unsplash.com/photo-1594212699903-ec8a3eca50f5?auto=format&fit=crop&w=900&q=85',
      'https://images.unsplash.com/photo-1606755962773-d324e2dabd2b?auto=format&fit=crop&w=900&q=85',
    ],
  },
  {
    match: ['momo', 'dumpling'],
    images: [
      'https://commons.wikimedia.org/wiki/Special:FilePath/Fried_momo.jpg?width=900',
      'https://commons.wikimedia.org/wiki/Special:FilePath/Momo_fry.JPG?width=900',
      'https://commons.wikimedia.org/wiki/Special:FilePath/Fried_Chicken_Momos.JPG?width=900',
      'https://commons.wikimedia.org/wiki/Special:FilePath/Fried_Momos_-_Tibetan_cuisine.jpg?width=900',
      'https://commons.wikimedia.org/wiki/Special:FilePath/Fried_Momos_from_North-Eastern_Indian_states.jpg?width=900',
      'https://commons.wikimedia.org/wiki/Special:FilePath/Fried_momos.jpg?width=900',
    ],
  },
  {
    match: ['tea', 'chai'],
    images: [
      'https://images.unsplash.com/photo-1571934811356-5cc061b6821f?auto=format&fit=crop&w=900&q=85',
      'https://images.unsplash.com/photo-1544787219-7f47ccb76574?auto=format&fit=crop&w=900&q=85',
      'https://images.unsplash.com/photo-1556679343-c7306c1976bc?auto=format&fit=crop&w=900&q=85',
      'https://images.unsplash.com/photo-1564890369478-c89ca6d9cde9?auto=format&fit=crop&w=900&q=85',
      'https://images.unsplash.com/photo-1576092768241-dec231879fc3?auto=format&fit=crop&w=900&q=85',
      'https://images.unsplash.com/photo-1515823064-d6e0c04616a7?auto=format&fit=crop&w=900&q=85',
    ],
  },
  {
    match: ['pizza'],
    images: [
      'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?auto=format&fit=crop&w=900&q=85',
      'https://images.unsplash.com/photo-1513104890138-7c749659a591?auto=format&fit=crop&w=900&q=85',
      'https://images.unsplash.com/photo-1604382354936-07c5d9983bd3?auto=format&fit=crop&w=900&q=85',
      'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?auto=format&fit=crop&w=900&q=85',
      'https://images.unsplash.com/photo-1593560708920-61dd98c46a4e?auto=format&fit=crop&w=900&q=85',
      'https://images.unsplash.com/photo-1548369937-47519962c11a?auto=format&fit=crop&w=900&q=85',
    ],
  },
];

const curatedImageSuggestions = (query) => {
  const set = findCuratedSuggestionSet(query);
  if (!set) return [];
  return set.images.map((url, index) => ({
    id: `curated-${set.match[0]}-${index + 1}`,
    title: `${query} photo ${index + 1}`,
    thumbnail: url.replace('w=900', 'w=320').replace('width=900', 'width=320'),
    url,
  }));
};

const stockImageSuggestions = (query) => {
  const searchQuery = buildImageSearchQuery(query);
  const slug = encodeURIComponent(searchQuery || query);
  return Array.from({ length: 6 }, (_, index) => ({
    id: `stock-${slug}-${index + 1}`,
    title: `${query} suggestion ${index + 1}`,
    thumbnail: `https://loremflickr.com/320/320/${slug}?lock=${index + 301}`,
    url: `https://loremflickr.com/900/900/${slug}?lock=${index + 301}`,
  }));
};

const fallbackImageSuggestions = (query, existing = []) => {
  const curated = curatedImageSuggestions(query);
  if (curated.length) return curated.slice(0, 6);
  if (existing.length) return existing.slice(0, 6);
  return stockImageSuggestions(query);
};

const getImageSuggestions = asyncHandler(async (req, res) => {
  const query = readString(req.query.q, { max: 80 });
  if (!query || query.length < 3) return success(res, [], 'Image suggestions retrieved');
  const curated = curatedImageSuggestions(query);
  if (curated.length) return success(res, curated.slice(0, 6), 'Image suggestions retrieved');

  const searchQuery = buildImageSearchQuery(query);

  try {
    const params = new URLSearchParams({
      q: searchQuery,
      page_size: '6',
      license_type: 'commercial',
      extension: 'jpg,png,webp',
    });
    const response = await fetch(`https://api.openverse.engineering/v1/images/?${params.toString()}`, {
      headers: { 'User-Agent': 'QR-Restro-Nepal/1.0' },
    });
    if (!response.ok) throw new Error('Image provider failed');
    const payload = await response.json();
    const suggestions = uniqueSuggestions((Array.isArray(payload.results) ? payload.results : [])
      .map((image) => ({
        id: image.id || image.url || image.thumbnail,
        title: image.title || query,
        thumbnail: image.thumbnail || image.url,
        url: image.url || image.thumbnail,
      }))
      .filter((image) => image.id && image.thumbnail && image.url));

    return success(res, fallbackImageSuggestions(query, suggestions), 'Image suggestions retrieved');
  } catch (err) {
    return success(res, fallbackImageSuggestions(query), 'Image suggestions retrieved');
  }
});

const getCategories = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = staffMenuScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve menu scope', 403);

  const categories = await Category.find({
    restaurant: restaurantId,
    branchId,
    isDeleted: false,
  }).sort({ sortOrder: 1, createdAt: 1 });

  return success(res, categories, 'Categories retrieved');
});

const getCategoryById = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = staffMenuScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve menu scope', 403);

  const category = await Category.findOne({
    _id: req.params.id,
    restaurant: restaurantId,
    branchId,
    isDeleted: false,
  });

  if (!category) {
    return error(res, 'Category not found', 404);
  }

  return success(res, category, 'Category retrieved');
});

const createCategory = asyncHandler(async (req, res) => {
  const { name, description, sortOrder, imageUrl } = req.body;
  const { restaurantId, branchId } = staffMenuScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve menu scope', 403);

  const categoryName = readString(name, { max: 80 });
  if (!categoryName) {
    return error(res, 'Category name is required', 400);
  }

  const existing = await Category.findOne({
    restaurant: restaurantId,
    branchId,
    name: { $regex: new RegExp(`^${escapeRegex(categoryName)}$`, 'i') },
    isDeleted: false,
  });

  if (existing) {
    return error(res, 'Category with this name already exists', 409);
  }

  const restaurant = await Restaurant.findById(restaurantId)
    .select('planLimits currentPlan')
    .populate('currentPlan', 'limits');
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }

  const maxCategories = resolveEffectiveLimit(restaurant, 'maxCategories');
  if (maxCategories > 0) {
    const currentCategories = await Category.countDocuments({
      restaurant: restaurantId,
      isDeleted: false,
    });
    if (currentCategories >= maxCategories) {
      return error(
        res,
        `Plan limit reached: maximum ${maxCategories} categories allowed`,
        403,
        { code: 'PLAN_LIMIT_CATEGORIES', maxAllowed: maxCategories, currentCount: currentCategories },
      );
    }
  }

  const categoryImageUrl = req.file ? req.file.path : readImageUrl(imageUrl);

  const category = await Category.create({
    restaurant: restaurantId,
    branchId,
    name: categoryName,
    description,
    image: categoryImageUrl,
    sortOrder: sortOrder || 0,
    isActive: true,
  });

  return success(res, category, 'Category created', 201);
});

const updateCategory = asyncHandler(async (req, res) => {
  const { name, description, sortOrder, isActive, imageUrl } = req.body;
  const { restaurantId, branchId } = staffMenuScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve menu scope', 403);

  const category = await Category.findOne({
    _id: req.params.id,
    restaurant: restaurantId,
    branchId,
    isDeleted: false,
  });

  if (!category) {
    return error(res, 'Category not found', 404);
  }

  if (name) category.name = name;
  if (description !== undefined) category.description = description;
  if (sortOrder !== undefined) category.sortOrder = sortOrder;
  if (typeof isActive === 'boolean') category.isActive = isActive;

  if (req.file && req.file.path) {
    category.image = req.file.path;
  } else if (imageUrl !== undefined) {
    category.image = readImageUrl(imageUrl);
  }

  await category.save();

  return success(res, category, 'Category updated');
});

const deleteCategory = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = staffMenuScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve menu scope', 403);

  const category = await Category.findOne({
    _id: req.params.id,
    restaurant: restaurantId,
    branchId,
    isDeleted: false,
  });

  if (!category) {
    return error(res, 'Category not found', 404);
  }

  const itemCount = await MenuItem.countDocuments({
    restaurant: restaurantId,
    branchId,
    category: category._id,
    isDeleted: false,
  });

  if (itemCount > 0) {
    return error(res, `Cannot delete category with ${itemCount} menu items`, 400);
  }

  category.isDeleted = true;
  await category.save();

  return success(res, null, 'Category deleted');
});

// ==================== MENU ITEM CONTROLLERS ====================

const getMenuItems = asyncHandler(async (req, res) => {
  const { category, isAvailable, search } = req.query;
  const { restaurantId, branchId } = staffMenuScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve menu scope', 403);

  const query = {
    restaurant: restaurantId,
    branchId,
    isDeleted: false,
  };

  if (category) query.category = category;
  if (isAvailable) query.isAvailable = isAvailable === 'true';
  if (search) {
    const esc = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.$or = [
      { name: { $regex: esc, $options: 'i' } },
      { description: { $regex: esc, $options: 'i' } },
      { sku: { $regex: esc, $options: 'i' } },
      { barcode: { $regex: esc, $options: 'i' } },
    ];
  }

  const items = await MenuItem.find(query)
    .populate('category', 'name')
    .sort({ sortOrder: 1, createdAt: 1 });

  return success(res, items, 'Menu items retrieved');
});

const getMenuItemById = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = staffMenuScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve menu scope', 403);

  const item = await MenuItem.findOne({
    _id: req.params.id,
    restaurant: restaurantId,
    branchId,
    isDeleted: false,
  }).populate('category', 'name');

  if (!item) {
    return error(res, 'Menu item not found', 404);
  }

  return success(res, item, 'Menu item retrieved');
});

const getCustomerMenuItemById = asyncHandler(async (req, res) => {
  const { restaurantSlug, qrToken, branchId: qBranch } = req.query;
  if (!restaurantSlug) return error(res, 'restaurantSlug is required', 400);

  const restaurant = await Restaurant.findOne({ slug: restaurantSlug, isActive: true, isDeleted: false });
  if (!restaurant) return error(res, 'Restaurant not found', 404);

  const branchId = await resolveCustomerMenuBranchId(restaurant._id, {
    qrToken,
    branchId: qBranch,
  });
  if (!branchId) return error(res, 'Unable to resolve branch for menu', 400);

  const item = await MenuItem.findOne({
    _id: req.params.id,
    restaurant: restaurant._id,
    branchId,
    isDeleted: false,
  }).populate('category', 'name');

  if (!item) {
    return error(res, 'Menu item not found', 404);
  }

  return success(res, item, 'Menu item retrieved');
});

const getMenuItemsByCategoryName = asyncHandler(async (req, res) => {
  const { categoryName } = req.params;
  const { restaurantSlug, qrToken, branchId: qBranch } = req.query;

  if (!restaurantSlug) {
    return error(res, 'restaurantSlug is required', 400);
  }

  const restaurant = await Restaurant.findOne({ slug: restaurantSlug, isActive: true, isDeleted: false });
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }

  const branchId = await resolveCustomerMenuBranchId(restaurant._id, {
    qrToken,
    branchId: qBranch,
  });
  if (!branchId) return error(res, 'Unable to resolve branch for menu', 400);

  const safeCategoryName = readString(categoryName, { max: 80 });
  if (!safeCategoryName) return error(res, 'Invalid category name', 400);

  const category = await Category.findOne({
    restaurant: restaurant._id,
    branchId,
    name: { $regex: new RegExp(`^${escapeRegex(safeCategoryName)}$`, 'i') },
    isDeleted: false,
  });

  if (!category) {
    return error(res, 'Category not found', 404);
  }

  const items = await MenuItem.find({
    restaurant: restaurant._id,
    branchId,
    category: category._id,
    isDeleted: false,
  }).populate('category', 'name');

  return success(
    res,
    {
      category: {
        id: category._id,
        name: category.name,
        description: category.description,
        image: category.image,
      },
      items,
    },
    'Menu items retrieved by category',
  );
});

const parseJsonField = (value, fallback = null) => {
  if (value == null || value === '') return fallback;
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const allowedGroupTypes = new Set([
  'size',
  'portion',
  'volume',
  'weight',
  'pieces',
  'combo',
  'temperature',
  'flavor',
  'spice',
  'crust',
  'preparation',
  'addon',
  'topping',
  'custom',
]);
const allowedSelectionTypes = new Set(['single', 'multiple', 'quantity']);
const allowedDisplayTypes = new Set(['radio', 'checkbox', 'dropdown', 'chips', 'cards', 'image', 'toggle', 'stepper']);

const normalizeVariationOption = (option = {}, existing = {}) => {
  const name = readString(option.name ?? existing.name, { max: 120 });
  if (!name) return null;
  const maxQuantity = readNumber(option.maxQuantity, { min: 0, max: 999, integer: true, fallback: existing.maxQuantity ?? 1 });
  return {
    _id: option._id && mongoose.Types.ObjectId.isValid(String(option._id)) ? option._id : existing._id,
    templateOptionId: option.templateOptionId || existing.templateOptionId || null,
    name,
    sku: readString(option.sku ?? existing.sku, { max: 120 }) || '',
    additionalPrice: readNumber(option.additionalPrice, { min: 0, max: 1000000, fallback: existing.additionalPrice ?? 0 }),
    discountedPrice:
      option.discountedPrice === '' || option.discountedPrice == null
        ? null
        : readNumber(option.discountedPrice, { min: 0, max: 1000000, fallback: existing.discountedPrice ?? null }),
    stockQuantity:
      option.stockQuantity === '' || option.stockQuantity == null
        ? null
        : readNumber(option.stockQuantity, { min: 0, max: 10000000, integer: true, fallback: existing.stockQuantity ?? null }),
    trackInventory: option.trackInventory === true || option.trackInventory === 'true' || existing.trackInventory === true,
    lowStockThreshold: readNumber(option.lowStockThreshold, { min: 0, max: 1000000, integer: true, fallback: existing.lowStockThreshold ?? 0 }),
    preparationTimeModifier: readNumber(option.preparationTimeModifier, { min: -1440, max: 1440, integer: true, fallback: existing.preparationTimeModifier ?? 0 }),
    image: readString(option.image ?? existing.image, { max: 1000 }) || '',
    imagePublicId: readString(option.imagePublicId ?? existing.imagePublicId, { max: 200 }) || '',
    isAvailable: option.isAvailable === undefined ? existing.isAvailable !== false : option.isAvailable === true || option.isAvailable === 'true',
    isDefault: option.isDefault === true || option.isDefault === 'true',
    calories:
      option.calories === '' || option.calories == null
        ? null
        : readNumber(option.calories, { min: 0, max: 100000, fallback: existing.calories ?? null }),
    taxClass: readString(option.taxClass ?? existing.taxClass, { max: 80 }) || '',
    taxRate:
      option.taxRate === '' || option.taxRate == null
        ? null
        : readNumber(option.taxRate, { min: 0, max: 100, fallback: existing.taxRate ?? null }),
    quantityStep: readNumber(option.quantityStep, { min: 1, max: 999, integer: true, fallback: existing.quantityStep ?? 1 }),
    minQuantity: readNumber(option.minQuantity, { min: 0, max: 999, integer: true, fallback: existing.minQuantity ?? 0 }),
    maxQuantity,
    branchPrices: Array.isArray(option.branchPrices) ? option.branchPrices : existing.branchPrices || [],
    scheduledPrices: Array.isArray(option.scheduledPrices) ? option.scheduledPrices : existing.scheduledPrices || [],
    discount: option.discount && typeof option.discount === 'object' ? option.discount : existing.discount || { type: 'none', value: 0 },
    metadata: option.metadata && typeof option.metadata === 'object' ? option.metadata : existing.metadata || {},
  };
};

const normalizeVariationGroupPayload = (payload = {}, existing = {}) => {
  const name = readString(payload.name ?? existing.name, { max: 120 });
  if (!name) return null;
  const selectionType = allowedSelectionTypes.has(payload.selectionType) ? payload.selectionType : existing.selectionType || 'single';
  const type = allowedGroupTypes.has(payload.type) ? payload.type : existing.type || 'custom';
  const displayType = allowedDisplayTypes.has(payload.displayType) ? payload.displayType : existing.displayType || (selectionType === 'multiple' ? 'checkbox' : 'radio');
  const isRequired = payload.isRequired === undefined ? existing.isRequired === true : payload.isRequired === true || payload.isRequired === 'true';
  const minSelection = readNumber(payload.minSelection, { min: 0, max: 999, integer: true, fallback: existing.minSelection ?? (isRequired ? 1 : 0) });
  let maxSelection = readNumber(payload.maxSelection, { min: 0, max: 999, integer: true, fallback: existing.maxSelection ?? (selectionType === 'single' ? 1 : 99) });
  const options = Array.isArray(payload.options)
    ? payload.options.map((option) => normalizeVariationOption(option)).filter(Boolean)
    : existing.options || [];

  if (selectionType === 'single') maxSelection = 1;
  const defaultCount = options.filter((option) => option.isDefault).length;
  if (selectionType === 'single' && defaultCount > 1) {
    let seen = false;
    options.forEach((option) => {
      if (option.isDefault && !seen) seen = true;
      else option.isDefault = false;
    });
  }

  const pricingMode =
    payload.pricingMode === 'tier' || payload.pricingMode === 'additive'
      ? payload.pricingMode
      : existing.pricingMode === 'tier' || existing.pricingMode === 'additive'
        ? existing.pricingMode
        : ['portion', 'size', 'volume', 'pieces'].includes(type) &&
            selectionType === 'single' &&
            isRequired
          ? 'tier'
          : 'additive';

  return {
    _id: payload._id && mongoose.Types.ObjectId.isValid(String(payload._id)) ? payload._id : existing._id,
    template: payload.template || existing.template || null,
    name,
    type,
    pricingMode,
    selectionType,
    isRequired,
    minSelection,
    maxSelection,
    displayType,
    sortOrder: readNumber(payload.sortOrder, { min: -100000, max: 100000, integer: true, fallback: existing.sortOrder ?? 0 }),
    allowQuantity: payload.allowQuantity === undefined ? existing.allowQuantity === true : payload.allowQuantity === true || payload.allowQuantity === 'true',
    isActive: payload.isActive === undefined ? existing.isActive !== false : payload.isActive === true || payload.isActive === 'true',
    options,
    nestedGroups: Array.isArray(payload.nestedGroups) ? payload.nestedGroups : existing.nestedGroups || [],
    incompatibleOptionPairs: Array.isArray(payload.incompatibleOptionPairs) ? payload.incompatibleOptionPairs : existing.incompatibleOptionPairs || [],
  };
};

const normalizeVariationGroups = (raw) => {
  const parsed = parseJsonField(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((group) => normalizeVariationGroupPayload(group)).filter(Boolean);
};

const templateToMenuGroup = (template) => ({
  template: template._id,
  name: template.name,
  type: template.type,
  selectionType: template.selectionType,
  isRequired: template.isRequired,
  minSelection: template.minSelection,
  maxSelection: template.maxSelection,
  displayType: template.displayType,
  sortOrder: template.sortOrder,
  allowQuantity: template.allowQuantity,
  isActive: template.isActive,
  options: (template.options || []).map((option) => ({
    templateOptionId: option._id,
    name: option.name,
    sku: option.sku,
    additionalPrice: option.additionalPrice,
    discountedPrice: option.discountedPrice,
    stockQuantity: option.stockQuantity,
    trackInventory: option.trackInventory,
    lowStockThreshold: option.lowStockThreshold,
    preparationTimeModifier: option.preparationTimeModifier,
    image: option.image,
    imagePublicId: option.imagePublicId,
    isAvailable: option.isAvailable,
    isDefault: option.isDefault,
    calories: option.calories,
    taxClass: option.taxClass,
    taxRate: option.taxRate,
    quantityStep: option.quantityStep,
    minQuantity: option.minQuantity,
    maxQuantity: option.maxQuantity,
    branchPrices: option.branchPrices || [],
    scheduledPrices: option.scheduledPrices || [],
    discount: option.discount || { type: 'none', value: 0 },
    metadata: option.metadata || {},
  })),
  nestedGroups: template.nestedGroups || [],
  incompatibleOptionPairs: template.incompatibleOptionPairs || [],
});

const ALLOWED_DIETARY_TAGS = ['veg', 'chicken', 'mutton', 'buff', 'pork', 'fish', 'seafood', 'egg'];

const normalizeDietaryTags = (raw) => {
  if (raw == null || raw === '') return [];
  let list = raw;
  if (typeof list === 'string') {
    const trimmed = list.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      list = parsed;
    } catch {
      list = trimmed.split(',');
    }
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const value of list) {
    const tag = String(value || '').trim().toLowerCase();
    if (!tag || !ALLOWED_DIETARY_TAGS.includes(tag) || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
};

const NUTRITION_FIELDS = ['calories', 'protein', 'carbs', 'fat', 'fiber'];

/**
 * Accepts a nutrition payload (object or JSON-string from FormData) and
 * returns a clean subset with only valid non-negative numbers. Returns
 * `undefined` if nothing was provided so we don't accidentally wipe data
 * that was previously stored.
 */
const normalizeNutrition = (raw) => {
  if (raw == null || raw === '') return undefined;
  let value = raw;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const key of NUTRITION_FIELDS) {
    const v = value[key];
    if (v === '' || v == null) continue;
    const num = Number(v);
    if (Number.isFinite(num) && num >= 0) out[key] = num;
  }
  return out;
};

const normalizeRecipe = async (raw, restaurantObjectId, branchObjectId) => {
  const parsed = parseJsonField(raw, []);
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const row of parsed) {
    const invId = row.inventoryItem || row.inventoryItemId;
    const quantity = Number(row.quantity);
    if (!invId || Number.isNaN(quantity) || quantity < 0) continue;
    const inv = await InventoryItem.findOne({
      _id: invId,
      restaurantId: restaurantObjectId,
      branchId: branchObjectId,
      isDeleted: false,
    }).select('_id');
    if (!inv) continue;
    out.push({ inventoryItem: inv._id, quantity });
  }
  return out;
};

const createMenuItem = asyncHandler(async (req, res) => {
  const {
    category,
    name,
    description,
    price,
    originalPrice,
    isAvailable,
    isVegetarian,
    isVegan,
    isSpicy,
    isGlutenFree,
    preparationTime,
    taxRate,
    sortOrder,
    customizations,
    isBestseller,
    highlightTag,
    recipe,
    dietaryTags,
    nutrition,
    variationGroups,
    variationPricing,
    imageUrl,
  } = req.body;

  const { restaurantId, branchId } = staffMenuScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve menu scope', 403);

  if (!category || !name || !price) {
    return error(res, 'Category, name and price are required', 400);
  }
  const safePrice = readMoney(price, { required: true });
  const safeOriginalPrice = readMoney(originalPrice);
  const safeTaxRate = readNumber(taxRate, { min: 0, max: 100, fallback: 0 });
  const safePreparationTime = readNumber(preparationTime, { min: 0, max: 1440, integer: true, fallback: 15 });
  if (safePrice === null || safePrice <= 0) return error(res, 'Price must be a positive number', 400);
  if (safeOriginalPrice === null) return error(res, 'Original price must be a valid number', 400);

  const categoryExists = await Category.findOne({
    _id: category,
    restaurant: restaurantId,
    branchId,
    isDeleted: false,
  });

  if (!categoryExists) {
    return error(res, 'Category not found', 404);
  }

  const restaurant = await Restaurant.findById(restaurantId)
    .select('planLimits currentPlan')
    .populate('currentPlan', 'limits');
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }

  const maxMenuItems = resolveEffectiveLimit(restaurant, 'maxMenuItems');
  if (maxMenuItems > 0) {
    const currentMenuItems = await MenuItem.countDocuments({
      restaurant: restaurantId,
      isDeleted: false,
    });
    if (currentMenuItems >= maxMenuItems) {
      return error(
        res,
        `Plan limit reached: maximum ${maxMenuItems} menu items allowed`,
        403,
        { code: 'PLAN_LIMIT_MENU_ITEMS', maxAllowed: maxMenuItems, currentCount: currentMenuItems },
      );
    }
  }

  const menuImageUrl = req.file ? req.file.path : readImageUrl(imageUrl);
  const imagePublicId = req.file ? req.file.filename : null;

  const recipeLines = await normalizeRecipe(recipe, restaurantId, branchId);
  const normalizedVariationGroups = normalizeVariationGroups(variationGroups);

  const menuItem = await MenuItem.create({
    restaurant: restaurantId,
    branchId,
    category,
    name,
    description,
    price: safePrice,
    originalPrice: safeOriginalPrice,
    image: menuImageUrl,
    imagePublicId,
    isAvailable: isAvailable !== undefined ? isAvailable : true,
    isVegetarian: isVegetarian || false,
    isVegan: isVegan || false,
    isSpicy: isSpicy || false,
    isGlutenFree: isGlutenFree || false,
    preparationTime: safePreparationTime,
    taxRate: safeTaxRate,
    sortOrder: sortOrder || 0,
    customizations: Array.isArray(parseJsonField(customizations, [])) ? parseJsonField(customizations, []) : [],
    isBestseller: isBestseller === true || isBestseller === 'true',
    highlightTag: ['', 'chef_special', 'trending', 'popular_tonight'].includes(highlightTag) ? highlightTag : '',
    recipe: recipeLines,
    dietaryTags: normalizeDietaryTags(dietaryTags),
    nutrition: normalizeNutrition(nutrition) || {},
    variationGroups: normalizedVariationGroups,
    variationPricing: parseJsonField(variationPricing, {}) || {},
  });

  await writeMenuAudit(req, 'menu_item_create', menuItem._id, {
    restaurantId: String(restaurantId),
    branchId: String(branchId),
    name: menuItem.name,
    price: menuItem.price,
  });

  return success(res, menuItem, 'Menu item created', 201);
});

const updateMenuItem = asyncHandler(async (req, res) => {
  const {
    category,
    name,
    description,
    price,
    originalPrice,
    isAvailable,
    isVegetarian,
    isVegan,
    isSpicy,
    isGlutenFree,
    preparationTime,
    taxRate,
    sortOrder,
    customizations,
    isBestseller,
    highlightTag,
    recipe,
    dietaryTags,
    nutrition,
    variationGroups,
    variationPricing,
    imageUrl,
  } = req.body;

  const { restaurantId, branchId } = staffMenuScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve menu scope', 403);

  const menuItem = await MenuItem.findOne({
    _id: req.params.id,
    restaurant: restaurantId,
    branchId,
    isDeleted: false,
  });

  if (!menuItem) {
    return error(res, 'Menu item not found', 404);
  }
  const before = {
    name: menuItem.name,
    price: menuItem.price,
    originalPrice: menuItem.originalPrice,
    isAvailable: menuItem.isAvailable,
  };

  if (category) {
    const categoryExists = await Category.findOne({
      _id: category,
      restaurant: restaurantId,
      branchId,
      isDeleted: false,
    });
    if (!categoryExists) {
      return error(res, 'Category not found', 404);
    }
    menuItem.category = category;
  }

  if (name) menuItem.name = name;
  if (description !== undefined) menuItem.description = description;
  if (price !== undefined) {
    const safePrice = readMoney(price, { required: true });
    if (safePrice === null || safePrice <= 0) return error(res, 'Price must be a positive number', 400);
    menuItem.price = safePrice;
  }
  if (originalPrice !== undefined) {
    const safeOriginalPrice = readMoney(originalPrice);
    if (safeOriginalPrice === null) return error(res, 'Original price must be a valid number', 400);
    menuItem.originalPrice = safeOriginalPrice;
  }
  if (typeof isAvailable === 'boolean') menuItem.isAvailable = isAvailable;
  if (typeof isVegetarian === 'boolean') menuItem.isVegetarian = isVegetarian;
  if (typeof isVegan === 'boolean') menuItem.isVegan = isVegan;
  if (typeof isSpicy === 'boolean') menuItem.isSpicy = isSpicy;
  if (typeof isGlutenFree === 'boolean') menuItem.isGlutenFree = isGlutenFree;
  if (preparationTime !== undefined) menuItem.preparationTime = readNumber(preparationTime, { min: 0, max: 1440, integer: true, fallback: menuItem.preparationTime || 15 });
  if (taxRate !== undefined) menuItem.taxRate = readNumber(taxRate, { min: 0, max: 100, fallback: menuItem.taxRate || 0 });
  if (sortOrder !== undefined) menuItem.sortOrder = sortOrder;
  if (customizations !== undefined) {
    const parsed = parseJsonField(customizations, []);
    menuItem.customizations = Array.isArray(parsed) ? parsed : [];
  }
  if (typeof isBestseller === 'boolean') menuItem.isBestseller = isBestseller;
  if (highlightTag !== undefined) {
    menuItem.highlightTag = ['', 'chef_special', 'trending', 'popular_tonight'].includes(highlightTag)
      ? highlightTag
      : '';
  }
  if (recipe !== undefined) {
    menuItem.recipe = await normalizeRecipe(recipe, restaurantId, branchId);
  }
  if (dietaryTags !== undefined) {
    menuItem.dietaryTags = normalizeDietaryTags(dietaryTags);
  }
  if (nutrition !== undefined) {
    // Replace the whole nutrition subdoc so cleared fields go back to undefined
    menuItem.nutrition = normalizeNutrition(nutrition) || {};
  }
  if (variationGroups !== undefined) {
    menuItem.variationGroups = normalizeVariationGroups(variationGroups);
  }
  if (variationPricing !== undefined) {
    menuItem.variationPricing = parseJsonField(variationPricing, {}) || {};
  }

  if (req.file && req.file.path) {
    menuItem.image = req.file.path;
    menuItem.imagePublicId = req.file.filename;
  } else if (imageUrl !== undefined) {
    menuItem.image = readImageUrl(imageUrl);
    menuItem.imagePublicId = '';
  }

  await menuItem.save();
  await writeMenuAudit(req, 'menu_item_update', menuItem._id, {
    restaurantId: String(restaurantId),
    branchId: String(branchId),
    before,
    after: {
      name: menuItem.name,
      price: menuItem.price,
      originalPrice: menuItem.originalPrice,
      isAvailable: menuItem.isAvailable,
    },
  });

  return success(res, menuItem, 'Menu item updated');
});

const deleteMenuItem = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = staffMenuScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve menu scope', 403);

  const menuItem = await MenuItem.findOne({
    _id: req.params.id,
    restaurant: restaurantId,
    branchId,
    isDeleted: false,
  });

  if (!menuItem) {
    return error(res, 'Menu item not found', 404);
  }

  menuItem.isDeleted = true;
  await menuItem.save();
  await writeMenuAudit(req, 'menu_item_delete', menuItem._id, {
    restaurantId: String(restaurantId),
    branchId: String(branchId),
    name: menuItem.name,
    price: menuItem.price,
  });

  return success(res, null, 'Menu item deleted');
});

const toggleMenuItemAvailability = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = staffMenuScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve menu scope', 403);

  const menuItem = await MenuItem.findOne({
    _id: req.params.id,
    restaurant: restaurantId,
    branchId,
    isDeleted: false,
  });

  if (!menuItem) {
    return error(res, 'Menu item not found', 404);
  }

  menuItem.isAvailable = !menuItem.isAvailable;
  await menuItem.save();
  await writeMenuAudit(req, 'menu_item_availability_toggle', menuItem._id, {
    restaurantId: String(restaurantId),
    branchId: String(branchId),
    name: menuItem.name,
    isAvailable: menuItem.isAvailable,
  });

  return success(
    res,
    {
      id: menuItem._id,
      isAvailable: menuItem.isAvailable,
    },
    `Item ${menuItem.isAvailable ? 'available' : 'unavailable'}`,
  );
});

const listVariationGroups = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = staffMenuScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve menu scope', 403);
  const groups = await VariationGroup.find({
    restaurant: restaurantId,
    branchId,
    isDeleted: false,
  }).sort({ sortOrder: 1, createdAt: -1 });
  return success(res, groups, 'Variation groups retrieved');
});

const getVariationGroup = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = staffMenuScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve menu scope', 403);
  const group = await VariationGroup.findOne({
    _id: req.params.groupId,
    restaurant: restaurantId,
    branchId,
    isDeleted: false,
  });
  if (!group) return error(res, 'Variation group not found', 404);
  return success(res, group, 'Variation group retrieved');
});

const createVariationGroup = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = staffMenuScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve menu scope', 403);
  let normalized;
  try {
    normalized = normalizeVariationGroupPayload(req.body);
  } catch (err) {
    return error(res, err.message || 'Invalid variation group', 400);
  }
  if (!normalized || !normalized.options.length) {
    return error(res, 'Variation group name and at least one option are required', 400);
  }
  const group = await VariationGroup.create({
    ...normalized,
    restaurant: restaurantId,
    branchId,
    isTemplate: true,
    createdBy: req.user.id,
    createdByModel: authModel(req),
  });
  await writeMenuAudit(req, 'variation_group_create', group._id, {
    restaurantId: String(restaurantId),
    branchId: String(branchId),
    name: group.name,
    optionCount: group.options.length,
  });
  return success(res, group, 'Variation group created', 201);
});

const updateVariationGroup = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = staffMenuScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve menu scope', 403);
  const group = await VariationGroup.findOne({
    _id: req.params.groupId,
    restaurant: restaurantId,
    branchId,
    isDeleted: false,
  });
  if (!group) return error(res, 'Variation group not found', 404);
  let normalized;
  try {
    normalized = normalizeVariationGroupPayload(req.body, group.toObject());
  } catch (err) {
    return error(res, err.message || 'Invalid variation group', 400);
  }
  Object.assign(group, normalized);
  await group.save();
  await writeMenuAudit(req, 'variation_group_update', group._id, {
    restaurantId: String(restaurantId),
    branchId: String(branchId),
    name: group.name,
  });
  return success(res, group, 'Variation group updated');
});

const deleteVariationGroup = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = staffMenuScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve menu scope', 403);
  const group = await VariationGroup.findOne({
    _id: req.params.groupId,
    restaurant: restaurantId,
    branchId,
    isDeleted: false,
  });
  if (!group) return error(res, 'Variation group not found', 404);
  group.isDeleted = true;
  group.isActive = false;
  await group.save();
  await writeMenuAudit(req, 'variation_group_delete', group._id, {
    restaurantId: String(restaurantId),
    branchId: String(branchId),
    name: group.name,
  });
  return success(res, null, 'Variation group deleted');
});

const assignVariationsToMenuItem = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = staffMenuScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve menu scope', 403);
  const menuItem = await MenuItem.findOne({
    _id: req.params.id,
    restaurant: restaurantId,
    branchId,
    isDeleted: false,
  });
  if (!menuItem) return error(res, 'Menu item not found', 404);

  const templateIds = Array.isArray(req.body.templateIds) ? req.body.templateIds.filter(Boolean) : [];
  let nextGroups = [];
  if (templateIds.length) {
    const templates = await VariationGroup.find({
      _id: { $in: templateIds },
      restaurant: restaurantId,
      branchId,
      isDeleted: false,
      isActive: true,
    });
    nextGroups = templates.map(templateToMenuGroup);
  }
  const directGroups = Array.isArray(req.body.variationGroups)
    ? req.body.variationGroups
    : parseJsonField(req.body.variationGroups, []);
  if (Array.isArray(directGroups) && directGroups.length) {
    nextGroups.push(...directGroups.map((group) => normalizeVariationGroupPayload(group)).filter(Boolean));
  }
  if (req.body.mode === 'append') {
    menuItem.variationGroups.push(...nextGroups);
  } else {
    menuItem.variationGroups = nextGroups;
  }
  await menuItem.save();
  await writeMenuAudit(req, 'menu_item_variations_assign', menuItem._id, {
    restaurantId: String(restaurantId),
    branchId: String(branchId),
    groupCount: menuItem.variationGroups.length,
  });
  return success(res, menuItem, 'Variations assigned to menu item');
});

const duplicateMenuItemVariations = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = staffMenuScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve menu scope', 403);
  const source = await MenuItem.findOne({ _id: req.params.id, restaurant: restaurantId, branchId, isDeleted: false });
  const target = await MenuItem.findOne({ _id: req.body.targetMenuItemId, restaurant: restaurantId, branchId, isDeleted: false });
  if (!source || !target) return error(res, 'Source or target menu item not found', 404);
  const cloned = JSON.parse(JSON.stringify(source.variationGroups || []));
  cloned.forEach((group) => {
    delete group._id;
    (group.options || []).forEach((option) => delete option._id);
  });
  target.variationGroups = cloned;
  target.variationPricing = source.variationPricing || {};
  await target.save();
  return success(res, target, 'Variation set duplicated');
});

const updateVariationStock = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = staffMenuScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve menu scope', 403);
  const { groupId, optionId } = req.params;
  const stockQuantity = readNumber(req.body.stockQuantity, { min: 0, max: 10000000, integer: true, fallback: NaN });
  if (!Number.isFinite(stockQuantity)) return error(res, 'Valid stock quantity is required', 400);
  const menuItem = await MenuItem.findOne({
    _id: req.params.id,
    restaurant: restaurantId,
    branchId,
    'variationGroups._id': groupId,
    'variationGroups.options._id': optionId,
    isDeleted: false,
  });
  if (!menuItem) return error(res, 'Variation option not found', 404);
  const group = menuItem.variationGroups.id(groupId);
  const option = group?.options?.id(optionId);
  if (!option) return error(res, 'Variation option not found', 404);
  option.stockQuantity = stockQuantity;
  option.trackInventory = true;
  option.isAvailable = stockQuantity > 0;
  await menuItem.save();
  return success(res, { option, menuItemId: menuItem._id }, 'Variation stock updated');
});

const validateMenuItemVariations = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = staffMenuScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve menu scope', 403);
  const menuItem = await MenuItem.findOne({ _id: req.params.id, restaurant: restaurantId, branchId, isDeleted: false });
  if (!menuItem) return error(res, 'Menu item not found', 404);
  const pricing = calculateMenuItemPrice(menuItem, normalizeSelections(req.body.selectedVariations || req.body.variations || []), {
    branchId,
    orderType: req.body.orderType || 'qr_ordering',
  });
  return success(res, {
    valid: pricing.valid,
    errors: pricing.errors,
    selectedVariations: pricing.selectedVariations,
    price: {
      basePrice: pricing.basePrice,
      variationPrice: pricing.variationPrice,
      addOnPrice: pricing.addOnPrice,
      discountAmount: pricing.discountAmount,
      taxAmount: pricing.taxAmount,
      unitPrice: pricing.unitPrice,
      finalPrice: roundMoney(pricing.lineTotal * Math.max(1, Number(req.body.quantity || 1))),
    },
  }, pricing.valid ? 'Variation selections are valid' : 'Variation selections are invalid');
});

const getVariationAnalytics = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = staffMenuScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve menu scope', 403);
  const match = {
    restaurant: restaurantId,
    branchId,
    isActive: true,
    status: { $ne: 'cancelled' },
  };
  const rows = await CustomerOrder.aggregate([
    { $match: match },
    { $unwind: '$items' },
    { $unwind: '$items.selectedVariations' },
    {
      $group: {
        _id: {
          groupId: '$items.selectedVariations.groupId',
          groupName: '$items.selectedVariations.groupName',
          optionId: '$items.selectedVariations.optionId',
          optionName: '$items.selectedVariations.optionName',
          isAddOn: '$items.selectedVariations.isAddOn',
        },
        quantity: { $sum: { $multiply: ['$items.quantity', '$items.selectedVariations.quantity'] } },
        revenue: { $sum: { $multiply: ['$items.quantity', '$items.selectedVariations.totalPrice'] } },
        orderLines: { $sum: 1 },
      },
    },
    { $sort: { quantity: -1, revenue: -1 } },
    { $limit: 100 },
  ]);
  const mostSelected = rows[0] || null;
  const mostProfitable = [...rows].sort((a, b) => Number(b.revenue || 0) - Number(a.revenue || 0))[0] || null;
  const addOnPopularity = rows.filter((row) => row._id?.isAddOn).slice(0, 25);
  return success(res, {
    mostSelected,
    mostProfitable,
    addOnPopularity,
    variationWiseSales: rows,
    inventoryConsumption: rows.map((row) => ({
      optionId: row._id.optionId,
      optionName: row._id.optionName,
      consumedQuantity: row.quantity,
    })),
  }, 'Variation analytics retrieved');
});

const getPublicMenu = asyncHandler(async (req, res) => {
  const { restaurantSlug } = req.params;

  const restaurant = await Restaurant.findOne({ slug: restaurantSlug, isActive: true, isDeleted: false });
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }

  const branchId = await resolveCustomerMenuBranchId(restaurant._id, {
    qrToken: req.query.qrToken,
    branchId: req.query.branchId,
  });
  if (!branchId) return error(res, 'Unable to resolve branch for menu', 400);

  const categories = await Category.find({
    restaurant: restaurant._id,
    branchId,
    isActive: true,
    isDeleted: false,
  }).sort({ sortOrder: 1 });

  const items = await MenuItem.find({
    restaurant: restaurant._id,
    branchId,
    isAvailable: true,
    isDeleted: false,
  }).lean();

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const countAgg = await CustomerOrder.aggregate([
    {
      $match: {
        restaurant: restaurant._id,
        branchId,
        isActive: true,
        status: { $ne: 'cancelled' },
        createdAt: { $gte: startOfDay },
      },
    },
    { $unwind: '$items' },
    { $group: { _id: '$items.menuItem', qty: { $sum: '$items.quantity' } } },
  ]);
  const orderCountByItem = new Map(countAgg.map((row) => [String(row._id), row.qty]));

  const enrichItem = (item) => ({
    ...item,
    orderCountToday: orderCountByItem.get(String(item._id)) || 0,
  });

  const menu = categories.map((category) => ({
    ...category.toObject(),
    items: items
      .filter((item) => item.category.toString() === category._id.toString())
      .map(enrichItem),
  }));

  const cleanText = (value) => {
    if (typeof value !== 'string') return '';
    const v = value.trim();
    if (!v) return '';
    const lower = v.toLowerCase();
    if (lower === 'undefined' || lower === 'null') return '';
    return v;
  };

  return success(
    res,
    {
      restaurant: {
        id: restaurant._id,
        name: restaurant.name,
        logo: restaurant.logo,
        favicon: restaurant.favicon,
        backgroundPhoto: restaurant.backgroundPhoto,
        brandBackgroundImage: restaurant.brandBackgroundImage,
        description: cleanText(restaurant.description),
        currency: restaurant?.settings?.currency || 'Rs.',
        themeSettings: restaurant?.settings?.themeSettings || {},
        openingTime: restaurant.openingTime,
        closingTime: restaurant.closingTime,
      },
      menu,
    },
    'Menu retrieved',
  );
});

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function escapeCsvCell(value) {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const exportMenuCsv = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = staffMenuScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve menu scope', 403);

  const items = await MenuItem.find({ restaurant: restaurantId, branchId, isDeleted: false })
    .populate('category', 'name')
    .sort({ sortOrder: 1, name: 1 })
    .lean();

  const header = 'categoryName,name,description,price,imageUrl,isAvailable,isVegetarian,dietaryTags';
  const lines = [header];
  items.forEach((item) => {
    lines.push(
      [
        escapeCsvCell(item.category?.name || ''),
        escapeCsvCell(item.name),
        escapeCsvCell(item.description || ''),
        Number(item.price || 0),
        escapeCsvCell(item.image || ''),
        item.isAvailable !== false ? 'true' : 'false',
        item.isVegetarian ? 'true' : 'false',
        escapeCsvCell((item.dietaryTags || []).join('|')),
      ].join(','),
    );
  });

  const csv = lines.join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="menu-export.csv"');
  return res.send(csv);
});

const importMenuCsv = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = staffMenuScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve menu scope', 403);

  const raw = String(req.body.csv || req.body.data || '').trim();
  if (!raw) return error(res, 'CSV content is required in body.csv', 400);

  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return error(res, 'CSV must include a header row and at least one item', 400);

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idx = (key) => header.indexOf(key);
  const catIdx = idx('categoryname');
  const nameIdx = idx('name');
  const priceIdx = idx('price');
  const imageIdx = ['imageurl', 'image', 'imagelink'].map(idx).find((index) => index >= 0) ?? -1;
  if (nameIdx < 0 || priceIdx < 0) {
    return error(res, 'CSV must include name and price columns', 400);
  }

  const categoryCache = new Map();
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    const name = cols[nameIdx];
    const price = Number(cols[priceIdx]);
    if (!name || !Number.isFinite(price) || price <= 0) {
      skipped += 1;
      continue;
    }
    const categoryName = catIdx >= 0 ? cols[catIdx] || 'General' : 'General';
    const description = idx('description') >= 0 ? cols[idx('description')] : '';
    const isAvailable = idx('isavailable') >= 0 ? cols[idx('isavailable')] !== 'false' : true;
    const isVegetarian = idx('isvegetarian') >= 0 ? cols[idx('isvegetarian')] === 'true' : false;
    const dietaryRaw = idx('dietarytags') >= 0 ? cols[idx('dietarytags')] : '';
    const dietaryTags = dietaryRaw ? dietaryRaw.split('|').map((t) => t.trim()).filter(Boolean) : [];
    const imageUrl = imageIdx >= 0 ? readImageUrl(cols[imageIdx]) : '';

    let categoryId = categoryCache.get(categoryName);
    if (!categoryId) {
      let cat = await Category.findOne({
        restaurant: restaurantId,
        branchId,
        name: categoryName,
        isDeleted: false,
      });
      if (!cat) {
        cat = await Category.create({
          restaurant: restaurantId,
          branchId,
          name: categoryName,
          isActive: true,
        });
      }
      categoryId = cat._id;
      categoryCache.set(categoryName, categoryId);
    }

    const existing = await MenuItem.findOne({
      restaurant: restaurantId,
      branchId,
      name,
      isDeleted: false,
    });

    try {
      if (existing) {
        existing.price = price;
        existing.description = description || existing.description;
        existing.isAvailable = isAvailable;
        existing.isVegetarian = isVegetarian;
        existing.dietaryTags = dietaryTags;
        existing.category = categoryId;
        if (imageUrl) {
          existing.image = imageUrl;
          existing.imagePublicId = '';
        }
        await existing.save();
        updated += 1;
      } else {
        await MenuItem.create({
          restaurant: restaurantId,
          branchId,
          category: categoryId,
          name,
          description,
          price,
          image: imageUrl,
          isAvailable,
          isVegetarian,
          dietaryTags,
        });
        created += 1;
      }
    } catch (err) {
      errors.push({ row: i + 1, name, message: err.message });
    }
  }

  await writeMenuAudit(req, 'menu_csv_import', null, { created, updated, skipped });

  return success(res, { created, updated, skipped, errors }, 'Menu import completed');
});

module.exports = {
  getCategories,
  getImageSuggestions,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
  getMenuItems,
  getMenuItemById,
  getCustomerMenuItemById,
  getMenuItemsByCategoryName,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  toggleMenuItemAvailability,
  exportMenuCsv,
  importMenuCsv,
  listVariationGroups,
  getVariationGroup,
  createVariationGroup,
  updateVariationGroup,
  deleteVariationGroup,
  assignVariationsToMenuItem,
  duplicateMenuItemVariations,
  updateVariationStock,
  validateMenuItemVariations,
  getVariationAnalytics,
  getPublicMenu,
};
