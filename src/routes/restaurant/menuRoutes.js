const express = require('express');
const router = express.Router();
const {
  getCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
  getImageSuggestions,
  getMenuItems,
  getMenuItemById,
  getCustomerMenuItemById,
  getMenuItemsByCategoryName,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  toggleMenuItemAvailability,
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
  exportMenuCsv,
  importMenuCsv,
} = require('../../controllers/restaurant/menuController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const requireRestaurantSubscriptionAccess = require('../../middleware/restaurant/requireRestaurantSubscriptionAccess');
const requireKYCVerifiedForWrites = require('../../middleware/restaurant/requireKYCVerifiedForWrites');
const requireRestaurantPlanFeatureUnlessBranch = require('../../middleware/restaurant/requireRestaurantPlanFeatureUnlessBranch');
const verifyBranchAccess = require('../../middleware/restaurant/verifyBranchAccess');
const verifyBranchModuleAccess = require('../../middleware/restaurant/verifyBranchModuleAccess');
const upload = require('../../config/multer');

router.get('/public/:restaurantSlug', getPublicMenu);

router.get('/items/by-category/:categoryName', getMenuItemsByCategoryName);

router.get('/items/customer/:id', getCustomerMenuItemById);

router.use(verifyToken);
router.use(requireRestaurantSubscriptionAccess);
router.use(requireKYCVerifiedForWrites);
router.use(requireRestaurantPlanFeatureUnlessBranch('menu'));
router.use(verifyBranchAccess);
router.use(verifyBranchModuleAccess('menu'));

const menuReaders = ['restaurant', 'waiter', 'cashier', 'manager', 'kitchen', 'branch_admin', 'branch_manager', 'branch_cashier', 'branch_waiter', 'branch_kitchen'];
const menuWriters = ['restaurant', 'branch_admin', 'branch_manager'];

router.get('/image-suggestions', requireRole(...menuReaders), getImageSuggestions);

router.get('/categories', requireRole(...menuReaders), getCategories);
router.get('/categories/:id', requireRole(...menuReaders), getCategoryById);
router.post('/categories', requireRole(...menuWriters), upload.single('image'), createCategory);
router.put('/categories/:id', requireRole(...menuWriters), upload.single('image'), updateCategory);
router.delete('/categories/:id', requireRole(...menuWriters), deleteCategory);

router.get('/items/export/csv', requireRole(...menuReaders), exportMenuCsv);
router.post('/items/import/csv', requireRole(...menuWriters), importMenuCsv);
router.get('/items', requireRole(...menuReaders), getMenuItems);
router.get('/items/:id', requireRole(...menuReaders), getMenuItemById);
router.post('/items', requireRole(...menuWriters), upload.single('image'), createMenuItem);
router.put('/items/:id', requireRole(...menuWriters), upload.single('image'), updateMenuItem);
router.delete('/items/:id', requireRole(...menuWriters), deleteMenuItem);
router.patch('/items/:id/toggle-availability', requireRole(...menuWriters), toggleMenuItemAvailability);
router.put('/items/:id/variations', requireRole(...menuWriters), assignVariationsToMenuItem);
router.post('/items/:id/variations/duplicate', requireRole(...menuWriters), duplicateMenuItemVariations);
router.patch('/items/:id/variations/:groupId/options/:optionId/stock', requireRole(...menuWriters), updateVariationStock);
router.post('/items/:id/variations/validate', requireRole(...menuReaders), validateMenuItemVariations);

router.get('/variation-groups', requireRole(...menuReaders), listVariationGroups);
router.get('/variation-groups/analytics', requireRole(...menuReaders), getVariationAnalytics);
router.get('/variation-groups/:groupId', requireRole(...menuReaders), getVariationGroup);
router.post('/variation-groups', requireRole(...menuWriters), createVariationGroup);
router.put('/variation-groups/:groupId', requireRole(...menuWriters), updateVariationGroup);
router.delete('/variation-groups/:groupId', requireRole(...menuWriters), deleteVariationGroup);

module.exports = router;
