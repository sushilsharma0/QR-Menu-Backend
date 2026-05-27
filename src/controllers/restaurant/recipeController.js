const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const MenuItem = require('../../models/restaurant/MenuItem');
const InventoryItem = require('../../models/restaurant/InventoryItem');
const Recipe = require('../../models/restaurant/Recipe');
const resolveRestaurantId = require('../../middleware/restaurant/resolveRestaurantId');
const { success, error } = require('../../utils/apiResponse');
const { quantityInInventoryNativeUnit, UNITS } = require('../../utils/recipeUnits');
const { readSearchRegex } = require('../../utils/inputValidation');

function sendIngredientValidation(res, built) {
  return res.status(422).json({
    success: false,
    message: 'Validation Error',
    errors: built.validationMessages,
    ...(built.code ? { code: built.code } : {}),
    timestamp: new Date().toISOString(),
  });
}

function asObjectId(id) {
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return null;
  }
}

async function validateAndBuildIngredients(rawIngredients, restaurantId, branchId) {
  if (!Array.isArray(rawIngredients)) {
    return {
      ok: false,
      validationMessages: [{ field: 'ingredients', message: 'ingredients must be an array' }],
    };
  }

  const seen = new Set();
  const recipeIngredients = [];
  const menuSyncLines = [];

  for (let i = 0; i < rawIngredients.length; i += 1) {
    const row = rawIngredients[i] || {};
    const invId = row.inventoryItemId || row.inventoryItem;
    const unit = String(row.unit || '').trim();
    const quantity = Number(row.quantity);
    const field = `ingredients[${i}]`;

    if (!invId) {
      return {
        ok: false,
        validationMessages: [{ field, message: 'inventoryItemId is required' }],
      };
    }
    const idStr = String(invId);
    if (seen.has(idStr)) {
      return {
        ok: false,
        validationMessages: [{ field, message: `Duplicate ingredient: ${idStr}` }],
        code: 'DUPLICATE_INGREDIENT',
      };
    }
    seen.add(idStr);

    if (!Number.isFinite(quantity) || quantity <= 0) {
      return {
        ok: false,
        validationMessages: [{ field, message: 'quantity must be a positive number' }],
      };
    }

    if (!UNITS.includes(unit)) {
      return {
        ok: false,
        validationMessages: [
          {
            field,
            message: `invalid unit "${unit}". Allowed: ${UNITS.join(', ')}`,
          },
        ],
        code: 'INVALID_UNIT',
      };
    }

    const inv = await InventoryItem.findOne({
      _id: invId,
      restaurantId,
      branchId,
      isDeleted: false,
    }).select('_id unit');

    if (!inv) {
      return {
        ok: false,
        validationMessages: [{ field, message: 'inventory item not found' }],
      };
    }

    const conv = quantityInInventoryNativeUnit(quantity, unit, inv.unit);
    if (!conv.ok) {
      return {
        ok: false,
        validationMessages: [
          { field, message: conv.message || `${field}: ${conv.code}` },
        ],
        code: conv.code,
      };
    }

    recipeIngredients.push({
      inventoryItem: inv._id,
      quantity,
      unit,
    });
    menuSyncLines.push({
      inventoryItem: inv._id,
      quantity: conv.value,
    });
  }

  return { ok: true, recipeIngredients, menuSyncLines };
}

async function syncMenuItemRecipe(menuItemId, restaurantObjectId, branchId, menuSyncLines) {
  await MenuItem.updateOne(
    { _id: menuItemId, restaurant: restaurantObjectId, branchId, isDeleted: false },
    { $set: { recipe: menuSyncLines } },
  );
}

/**
 * @desc Search inventory for recipe builder (restaurant owners; no finance module required)
 * @route GET /api/restaurant/recipes/inventory-search
 */
const searchInventoryForRecipe = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const restaurantId = asObjectId(rid);
  const branchId = asObjectId(req.branchId);
  if (!branchId) return error(res, 'Unable to resolve branch', 403);
  const filter = { restaurantId, branchId, isDeleted: false };
  const nameRegex = readSearchRegex(req.query.q);
  if (nameRegex) filter.name = nameRegex;
  const rows = await InventoryItem.find(filter)
    .select('name category unit quantity minimumStock costPerUnit')
    .sort({ name: 1 })
    .limit(40);
  return success(res, { items: rows }, 'Inventory options retrieved');
});

/**
 * @desc Create recipe for a menu item
 * @route POST /api/restaurant/recipes
 */
const createRecipe = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const restaurantId = asObjectId(rid);
  const { menuItemId, ingredients } = req.body;

  if (!menuItemId) return error(res, 'menuItemId is required', 400);
  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return error(res, 'At least one ingredient is required', 400);
  }

  const branchId = asObjectId(req.branchId);
  if (!branchId) return error(res, 'Unable to resolve branch', 403);

  const menuItem = await MenuItem.findOne({
    _id: menuItemId,
    restaurant: restaurantId,
    branchId,
    isDeleted: false,
  }).select('_id');
  if (!menuItem) return error(res, 'Menu item not found', 404);

  const exists = await Recipe.findOne({ restaurantId, branchId, menuItem: menuItemId }).select('_id');
  if (exists) {
    return error(res, 'Recipe already exists for this menu item. Use update.', 409, {
      code: 'RECIPE_EXISTS',
    });
  }

  const built = await validateAndBuildIngredients(ingredients, restaurantId, branchId);
  if (!built.ok) return sendIngredientValidation(res, built);

  const doc = await Recipe.create({
    restaurantId,
    branchId,
    menuItem: menuItemId,
    ingredients: built.recipeIngredients,
  });

  await syncMenuItemRecipe(menuItemId, restaurantId, branchId, built.menuSyncLines);

  const populated = await Recipe.findOne({ _id: doc._id, restaurantId, branchId }).populate(
    'ingredients.inventoryItem',
    'name category unit quantity minimumStock costPerUnit',
  );

  return success(res, populated, 'Recipe created', 201);
});

/**
 * @desc Update recipe
 * @route PUT /api/restaurant/recipes/menu-item/:menuItemId
 */
const updateRecipe = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const restaurantId = asObjectId(rid);
  const { menuItemId } = req.params;
  const { ingredients } = req.body;

  if (!Array.isArray(ingredients)) {
    return error(res, 'ingredients must be an array', 400);
  }

  const branchId = asObjectId(req.branchId);
  if (!branchId) return error(res, 'Unable to resolve branch', 403);

  const menuItem = await MenuItem.findOne({
    _id: menuItemId,
    restaurant: restaurantId,
    branchId,
    isDeleted: false,
  }).select('_id');
  if (!menuItem) return error(res, 'Menu item not found', 404);

  const doc = await Recipe.findOne({ restaurantId, branchId, menuItem: menuItemId });
  if (!doc) return error(res, 'Recipe not found', 404);

  const built = await validateAndBuildIngredients(ingredients, restaurantId, branchId);
  if (!built.ok) return sendIngredientValidation(res, built);

  if (built.recipeIngredients.length === 0) {
    await Recipe.deleteOne({ _id: doc._id, restaurantId, branchId });
    await syncMenuItemRecipe(menuItemId, restaurantId, branchId, []);
    return success(res, null, 'Recipe cleared');
  }

  doc.ingredients = built.recipeIngredients;
  await doc.save();

  await syncMenuItemRecipe(menuItemId, restaurantId, branchId, built.menuSyncLines);

  const populated = await Recipe.findOne({ _id: doc._id, restaurantId, branchId }).populate(
    'ingredients.inventoryItem',
    'name category unit quantity minimumStock costPerUnit',
  );

  return success(res, populated, 'Recipe updated');
});

/**
 * @desc Get recipe by menu item (Recipe document, or legacy MenuItem.recipe)
 * @route GET /api/restaurant/recipes/menu-item/:menuItemId
 */
const getRecipeByMenuItem = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const restaurantId = asObjectId(rid);
  const { menuItemId } = req.params;

  const branchId = asObjectId(req.branchId);
  if (!branchId) return error(res, 'Unable to resolve branch', 403);

  const menuItem = await MenuItem.findOne({
    _id: menuItemId,
    restaurant: restaurantId,
    branchId,
    isDeleted: false,
  })
    .select('name recipe')
    .populate('recipe.inventoryItem', 'name category unit quantity minimumStock costPerUnit');

  if (!menuItem) return error(res, 'Menu item not found', 404);

  const doc = await Recipe.findOne({ restaurantId, branchId, menuItem: menuItemId }).populate(
    'ingredients.inventoryItem',
    'name category unit quantity minimumStock costPerUnit',
  );

  if (doc) {
    return success(
      res,
      {
        menuItemId,
        menuItemName: menuItem.name,
        source: 'recipe',
        recipeId: doc._id,
        ingredients: doc.ingredients,
        updatedAt: doc.updatedAt,
      },
      'Recipe retrieved',
    );
  }

  if (menuItem.recipe?.length) {
    const ingredients = menuItem.recipe.map((r) => ({
      inventoryItem: r.inventoryItem,
      quantity: r.quantity,
      unit: r.inventoryItem?.unit || 'piece',
    }));
    return success(
      res,
      {
        menuItemId,
        menuItemName: menuItem.name,
        source: 'legacy',
        recipeId: null,
        ingredients,
        updatedAt: null,
      },
      'Recipe retrieved (legacy)',
    );
  }

  return success(
    res,
    {
      menuItemId,
      menuItemName: menuItem.name,
      source: 'none',
      recipeId: null,
      ingredients: [],
      updatedAt: null,
    },
    'No recipe for this item',
  );
});

/**
 * @desc Delete recipe
 * @route DELETE /api/restaurant/recipes/menu-item/:menuItemId
 */
const deleteRecipe = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const restaurantId = asObjectId(rid);
  const { menuItemId } = req.params;

  const branchId = asObjectId(req.branchId);
  if (!branchId) return error(res, 'Unable to resolve branch', 403);

  const menuItem = await MenuItem.findOne({
    _id: menuItemId,
    restaurant: restaurantId,
    branchId,
    isDeleted: false,
  }).select('_id');
  if (!menuItem) return error(res, 'Menu item not found', 404);

  await Recipe.deleteOne({ restaurantId, branchId, menuItem: menuItemId });
  await syncMenuItemRecipe(menuItemId, restaurantId, branchId, []);

  return success(res, null, 'Recipe deleted');
});

module.exports = {
  createRecipe,
  updateRecipe,
  getRecipeByMenuItem,
  deleteRecipe,
  searchInventoryForRecipe,
};
