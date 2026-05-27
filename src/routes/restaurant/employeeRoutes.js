const express = require('express');
const router = express.Router();
const {
  createEmployee,
  getEmployees,
  getEmployeeById,
  updateEmployee,
  deleteEmployee,
  toggleEmployeeStatus,
  resetEmployeePassword,
  employeeLogin,
  changePassword,
  employeeLogout
} = require('../../controllers/restaurant/employeeController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');
const requireEmployeeScope = require('../../middleware/auth/requireEmployeeScope');
const requireRestaurantSubscriptionAccess = require('../../middleware/restaurant/requireRestaurantSubscriptionAccess');
const requireKYCVerifiedForWrites = require('../../middleware/restaurant/requireKYCVerifiedForWrites');
const requireRestaurantPlanFeatureUnlessBranch = require('../../middleware/restaurant/requireRestaurantPlanFeatureUnlessBranch');
const verifyBranchAccess = require('../../middleware/restaurant/verifyBranchAccess');
const verifyBranchModuleAccess = require('../../middleware/restaurant/verifyBranchModuleAccess');
const upload = require('../../config/multer');
const { authLimiter } = require('../../middleware/rateLimiter');

router.post('/login', authLimiter, employeeLogin);

router.use(verifyToken);

router.patch('/change-password', requireEmployeeScope, changePassword);
router.post('/logout', requireEmployeeScope, employeeLogout);

router.get(
  '/branch-team',
  requireEmployeeScope,
  requireRole('manager', 'admin'),
  requireRestaurantSubscriptionAccess,
  verifyBranchAccess,
  verifyBranchModuleAccess('employees'),
  requireRestaurantPlanFeatureUnlessBranch('employees'),
  getEmployees,
);

router.use(requireRole('restaurant', 'branch_admin', 'branch_manager'));
router.use(requireRestaurantSubscriptionAccess);
router.use(requireKYCVerifiedForWrites);
router.use(requireRestaurantPlanFeatureUnlessBranch('employees'));
router.use(verifyBranchAccess);
router.use(verifyBranchModuleAccess('employees'));

router.post('/', upload.single('employeePhoto'), createEmployee);
router.get('/', getEmployees);
router.get('/:id', getEmployeeById);
router.put('/:id', upload.single('employeePhoto'), updateEmployee);
router.delete('/:id', deleteEmployee);
router.patch('/:id/toggle-status', toggleEmployeeStatus);
router.patch('/:id/reset-password', resetEmployeePassword);

module.exports = router;
