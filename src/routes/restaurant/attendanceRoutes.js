const express = require('express');
const router = express.Router();
const {
  getAttendance,
  upsertAttendance,
  checkIn,
  checkOut,
} = require('../../controllers/restaurant/attendanceController');
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
router.use(requireRestaurantPlanFeatureUnlessBranch('employees'));
router.use(verifyBranchAccess);
router.use(verifyBranchModuleAccess('employees'));

const readers = ['restaurant', 'manager', 'admin', 'accountant', 'branch_admin', 'branch_manager'];
const writers = ['restaurant', 'manager', 'admin', 'branch_admin', 'branch_manager'];

router.get('/', requireRole(...readers), getAttendance);
router.post('/', requireRole(...writers), upsertAttendance);
router.post('/:employeeId/check-in', requireRole(...writers, 'waiter', 'cashier', 'kitchen', 'accountant', 'branch_waiter', 'branch_cashier', 'branch_kitchen'), checkIn);
router.post('/:employeeId/check-out', requireRole(...writers, 'waiter', 'cashier', 'kitchen', 'accountant', 'branch_waiter', 'branch_cashier', 'branch_kitchen'), checkOut);

module.exports = router;
