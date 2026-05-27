const express = require('express');
const router = express.Router();
const {
  getTables,
  getTableById,
  createTable,
  updateTable,
  deleteTable,
  moveTableOrder,
  mergeTableOrder,
  regenerateQR,
  getTableByQRToken
} = require('../../controllers/restaurant/tableController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const requireRestaurantSubscriptionAccess = require('../../middleware/restaurant/requireRestaurantSubscriptionAccess');
const requireKYCVerifiedForWrites = require('../../middleware/restaurant/requireKYCVerifiedForWrites');
const requireRestaurantPlanFeatureUnlessBranch = require('../../middleware/restaurant/requireRestaurantPlanFeatureUnlessBranch');
const verifyBranchAccess = require('../../middleware/restaurant/verifyBranchAccess');
const verifyBranchModuleAccess = require('../../middleware/restaurant/verifyBranchModuleAccess');

router.get('/qr/:token', getTableByQRToken);

router.use(verifyToken);
router.use(requireRestaurantSubscriptionAccess);
router.use(requireKYCVerifiedForWrites);
router.use(requireRestaurantPlanFeatureUnlessBranch('tables'));
router.use(verifyBranchAccess);
router.use(verifyBranchModuleAccess('tables'));

const tableReaders = ['restaurant', 'waiter', 'cashier', 'manager', 'branch_admin', 'branch_manager', 'branch_cashier', 'branch_waiter'];
const tableWriters = ['restaurant', 'branch_admin', 'branch_manager'];

router.get('/', requireRole(...tableReaders), getTables);
router.get('/:id', requireRole(...tableReaders), getTableById);
router.post('/', requireRole(...tableWriters), createTable);
router.put('/:id', requireRole(...tableWriters), updateTable);
router.delete('/:id', requireRole(...tableWriters), deleteTable);
router.patch('/:id/move-order', requireRole(...tableWriters, 'cashier', 'manager', 'branch_cashier'), moveTableOrder);
router.patch('/:id/merge', requireRole(...tableWriters, 'cashier', 'manager', 'branch_cashier'), mergeTableOrder);
router.patch('/:id/regenerate-qr', requireRole(...tableWriters), regenerateQR);

module.exports = router;
