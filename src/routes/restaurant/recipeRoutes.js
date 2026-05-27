const express = require('express');
const router = express.Router();
const {
  createRecipe,
  updateRecipe,
  getRecipeByMenuItem,
  deleteRecipe,
  searchInventoryForRecipe,
} = require('../../controllers/restaurant/recipeController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const requireRestaurantSubscriptionAccess = require('../../middleware/restaurant/requireRestaurantSubscriptionAccess');
const requireKYCVerifiedForWrites = require('../../middleware/restaurant/requireKYCVerifiedForWrites');
const requireRestaurantPlanFeatureUnlessBranch = require('../../middleware/restaurant/requireRestaurantPlanFeatureUnlessBranch');
const verifyBranchAccess = require('../../middleware/restaurant/verifyBranchAccess');
const verifyBranchModuleAccess = require('../../middleware/restaurant/verifyBranchModuleAccess');

router.use(verifyToken);
router.use(requireRestaurantSubscriptionAccess);
router.use(requireKYCVerifiedForWrites);
router.use(requireRestaurantPlanFeatureUnlessBranch('menu'));
router.use(verifyBranchAccess);
router.use(verifyBranchModuleAccess('inventory'));

const recipeRoles = ['restaurant', 'branch_admin', 'branch_manager'];

router.get('/inventory-search', requireRole(...recipeRoles), searchInventoryForRecipe);
router.post('/', requireRole(...recipeRoles), createRecipe);
router.put('/menu-item/:menuItemId', requireRole(...recipeRoles), updateRecipe);
router.get('/menu-item/:menuItemId', requireRole(...recipeRoles), getRecipeByMenuItem);
router.delete('/menu-item/:menuItemId', requireRole(...recipeRoles), deleteRecipe);

module.exports = router;
