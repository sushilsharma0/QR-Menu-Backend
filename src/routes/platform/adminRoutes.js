const express = require('express');
const router = express.Router();
const {
  createAdmin,
  getAdmins,
  getAdminById,
  updateAdmin,
  deleteAdmin,
  toggleAdminStatus,
  getNextEmployeeCode,
  getPermissionCatalog,
  updateAdminPermissions,
} = require('../../controllers/platform/adminController');
const verifyToken = require('../../middleware/auth/verifyToken');
const requireRole = require('../../middleware/auth/requireRole');

router.use(verifyToken, requireRole('super_admin'));

router.get('/next-employee-code', getNextEmployeeCode);
router.get('/permission-catalog', getPermissionCatalog);
router.post('/', createAdmin);
router.get('/', getAdmins);
router.get('/:id', getAdminById);
router.put('/:id', updateAdmin);
router.patch('/:id/permissions', updateAdminPermissions);
router.delete('/:id', deleteAdmin);
router.patch('/:id/toggle-status', toggleAdminStatus);

module.exports = router;