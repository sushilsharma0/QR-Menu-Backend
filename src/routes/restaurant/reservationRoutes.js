const express = require('express');
const router = express.Router();
const {
  getReservations,
  createReservation,
  updateReservation,
  deleteReservation,
} = require('../../controllers/restaurant/reservationController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const requireEmployeePasswordChanged = require('../../middleware/auth/requireEmployeePasswordChanged');
const requireRestaurantSubscriptionAccess = require('../../middleware/restaurant/requireRestaurantSubscriptionAccess');
const requireKYCVerifiedForWrites = require('../../middleware/restaurant/requireKYCVerifiedForWrites');
const requireRestaurantPlanFeatureUnlessBranch = require('../../middleware/restaurant/requireRestaurantPlanFeatureUnlessBranch');
const verifyBranchAccess = require('../../middleware/restaurant/verifyBranchAccess');
const verifyBranchModuleAccess = require('../../middleware/restaurant/verifyBranchModuleAccess');

router.use(verifyToken);
router.use(requireEmployeePasswordChanged);
router.use(requireRestaurantSubscriptionAccess);
router.use(requireKYCVerifiedForWrites);
router.use(requireRestaurantPlanFeatureUnlessBranch('tables'));
router.use(verifyBranchAccess);
router.use(verifyBranchModuleAccess('tables'));

const readers = ['restaurant', 'waiter', 'cashier', 'manager', 'admin', 'branch_admin', 'branch_manager', 'branch_cashier', 'branch_waiter'];
const writers = ['restaurant', 'waiter', 'manager', 'branch_admin', 'branch_manager', 'branch_waiter'];

router.get('/', requireRole(...readers), getReservations);
router.post('/', requireRole(...writers), createReservation);
router.put('/:id', requireRole(...writers), updateReservation);
router.delete('/:id', requireRole('restaurant', 'manager', 'branch_admin', 'branch_manager'), deleteReservation);

module.exports = router;
