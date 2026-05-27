const express = require('express');
const router = express.Router();
const {
  getAllRestaurants,
  getRestaurantById,
  getRestaurantOperationalOverview,
  createRestaurant,
  updateRestaurant,
  deleteRestaurant,
  toggleRestaurantStatus,
  resetRestaurantPassword,
  getRestaurantStats
} = require('../../controllers/platform/restaurantController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const checkPermission = require('../../middleware/auth/checkPermission');

router.use(verifyToken);

router.get('/stats', requireRole('super_admin', 'admin'), checkPermission('viewAnalytics'), getRestaurantStats);
router.get('/', requireRole('super_admin', 'admin'), checkPermission('manageRestaurants'), getAllRestaurants);
router.get('/:id/operations', requireRole('super_admin', 'admin'), checkPermission('manageRestaurants'), getRestaurantOperationalOverview);
router.get('/:id', requireRole('super_admin', 'admin'), checkPermission('manageRestaurants'), getRestaurantById);
router.post('/', requireRole('super_admin'), createRestaurant);
router.put('/:id', requireRole('super_admin', 'admin'), checkPermission('manageRestaurants'), updateRestaurant);
router.delete('/:id', requireRole('super_admin'), deleteRestaurant);
router.patch('/:id/toggle-status', requireRole('super_admin', 'admin'), checkPermission('manageRestaurants'), toggleRestaurantStatus);
router.patch('/:id/reset-password', requireRole('super_admin'), resetRestaurantPassword);

module.exports = router;
