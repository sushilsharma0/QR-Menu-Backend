const asyncHandler = require('express-async-handler');
const Platform = require('../../models/platform/Platform');
const { success, error } = require('../../utils/apiResponse');
const { generateOTP } = require('../../utils/generateToken');
const validatePassword = require('../../utils/validatePassword');
const { sendWelcomeEmailForPlatform } = require('../../services/emailService');
const AuditLog = require('../../models/platform/AuditLog');
const {
  PLATFORM_PERMISSION_DEFS,
  nestPermissionsForCatalog,
  sanitizePermissions,
  countEnabledPermissions,
} = require('../../constants/platformPermissions');
const { generateNextEmployeeCode } = require('../../services/platformEmployeeCodeService');

/**
 * @desc    Create new admin (super admin only)
 * @route   POST /api/platform/admins
 * @access  Private (Super Admin)
 */
const createAdmin = asyncHandler(async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return error(res, 'Only super admin can create admins', 403);
  }
  
  const {
    name,
    email,
    password,
    permissions,
    employeeCode,
    phone,
    department,
    designation,
    joiningDate,
    salary,
    allowance,
    panNumber,
    bankName,
    bankAccountNumber,
    bankBranch,
  } = req.body;

  if (!name || !email || !password) {
    return error(res, 'Name, email and password are required', 400);
  }
  
  const passwordValidation = validatePassword(password);
  if (!passwordValidation.valid) {
    return error(res, passwordValidation.message, 400);
  }
  
  const exists = await Platform.findOne({ email });
  if (exists) {
    return error(res, 'Email already in use', 409);
  }
  
  const safePermissions = sanitizePermissions(permissions);

  let code = String(employeeCode || '').trim().toUpperCase();
  if (!code) code = await generateNextEmployeeCode();
  const codeTaken = await Platform.findOne({ employeeCode: code });
  if (codeTaken) return error(res, 'Employee ID already in use', 409);

  const admin = await Platform.create({
    name,
    email,
    password,
    role: 'admin',
    permissions: safePermissions,
    employeeCode: code,
    phone: phone || '',
    department: department || '',
    designation: designation || '',
    joiningDate: joiningDate ? new Date(joiningDate) : new Date(),
    salary: Number(salary) || 0,
    allowance: Number(allowance) || 0,
    panNumber: panNumber || '',
    bankName: bankName || '',
    bankAccountNumber: bankAccountNumber || '',
    bankBranch: bankBranch || '',
    payrollEligible: true,
    createdBy: req.user.id,
  });
  
  await sendWelcomeEmailForPlatform(email, name);
  
  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'admin_create',
    resource: 'user',
    resourceId: admin._id,
    details: { name, email, permissions: safePermissions },
    ipAddress: req.ip
  });
  
  return success(res, {
    id: admin._id,
    name: admin.name,
    email: admin.email,
    role: admin.role,
    permissions: admin.permissions,
    employeeCode: admin.employeeCode,
    department: admin.department,
    designation: admin.designation,
    salary: admin.salary,
    isActive: admin.isActive,
  }, 'Admin created successfully', 201);
});

/**
 * @desc    Get all admins
 * @route   GET /api/platform/admins
 * @access  Private (Super Admin)
 */
const getAdmins = asyncHandler(async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return error(res, 'Only super admin can view admins', 403);
  }
  
  const admins = await Platform.find({ role: { $in: ['admin', 'support'] } })
    .select('-password')
    .sort({ createdAt: -1 });
  
  return success(res, admins, 'Admins retrieved');
});

/**
 * @desc    Get single admin by ID
 * @route   GET /api/platform/admins/:id
 * @access  Private (Super Admin)
 */
const getAdminById = asyncHandler(async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return error(res, 'Only super admin can view admin details', 403);
  }
  
  const admin = await Platform.findById(req.params.id).select('-password');
  if (!admin) {
    return error(res, 'Admin not found', 404);
  }
  
  return success(res, admin, 'Admin retrieved');
});

/**
 * @desc    Update admin
 * @route   PUT /api/platform/admins/:id
 * @access  Private (Super Admin)
 */
const updateAdmin = asyncHandler(async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return error(res, 'Only super admin can update admins', 403);
  }
  
  const {
    name,
    permissions,
    isActive,
    employeeCode,
    phone,
    department,
    designation,
    joiningDate,
    salary,
    allowance,
    panNumber,
    bankName,
    bankAccountNumber,
    bankBranch,
    payrollEligible,
  } = req.body;

  const adminBefore = await Platform.findById(req.params.id);
  if (!adminBefore) return error(res, 'Admin not found', 404);
  if (adminBefore.role === 'super_admin') {
    return error(res, 'Cannot update super admin via this endpoint', 400);
  }

  const updates = {};

  if (name) updates.name = name;
  if (employeeCode !== undefined) {
    const code = String(employeeCode || '').trim().toUpperCase();
    if (code) {
      const taken = await Platform.findOne({
        employeeCode: code,
        _id: { $ne: adminBefore._id },
      });
      if (taken) return error(res, 'Employee ID already in use', 409);
      updates.employeeCode = code;
    }
  }
  if (permissions) updates.permissions = sanitizePermissions(permissions);
  if (typeof isActive === 'boolean') updates.isActive = isActive;
  if (phone !== undefined) updates.phone = phone;
  if (department !== undefined) updates.department = department;
  if (designation !== undefined) updates.designation = designation;
  if (joiningDate !== undefined) updates.joiningDate = joiningDate ? new Date(joiningDate) : null;
  if (salary !== undefined) updates.salary = Number(salary) || 0;
  if (allowance !== undefined) updates.allowance = Number(allowance) || 0;
  if (panNumber !== undefined) updates.panNumber = panNumber;
  if (bankName !== undefined) updates.bankName = bankName;
  if (bankAccountNumber !== undefined) updates.bankAccountNumber = bankAccountNumber;
  if (bankBranch !== undefined) updates.bankBranch = bankBranch;
  if (typeof payrollEligible === 'boolean') updates.payrollEligible = payrollEligible;
  
  const admin = await Platform.findByIdAndUpdate(adminBefore._id, updates, { new: true }).select('-password');
  
  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'admin_update',
    resource: 'user',
    resourceId: admin._id,
    details: updates,
    ipAddress: req.ip
  });
  
  return success(res, admin, 'Admin updated');
});

/**
 * @desc    Delete admin
 * @route   DELETE /api/platform/admins/:id
 * @access  Private (Super Admin)
 */
const deleteAdmin = asyncHandler(async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return error(res, 'Only super admin can delete admins', 403);
  }
  
  const admin = await Platform.findById(req.params.id);
  if (!admin) {
    return error(res, 'Admin not found', 404);
  }
  
  if (admin.role === 'super_admin') {
    return error(res, 'Cannot delete super admin', 400);
  }
  
  await admin.deleteOne();
  
  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'admin_delete',
    resource: 'user',
    resourceId: admin._id,
    details: { name: admin.name, email: admin.email },
    ipAddress: req.ip
  });
  
  return success(res, null, 'Admin deleted');
});

/**
 * @desc    Toggle admin status
 * @route   PATCH /api/platform/admins/:id/toggle-status
 * @access  Private (Super Admin)
 */
const toggleAdminStatus = asyncHandler(async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return error(res, 'Only super admin can toggle admin status', 403);
  }
  
  const admin = await Platform.findById(req.params.id);
  if (!admin) {
    return error(res, 'Admin not found', 404);
  }
  
  if (admin.role === 'super_admin') {
    return error(res, 'Cannot modify super admin status', 400);
  }
  
  admin.isActive = !admin.isActive;
  await admin.save();
  
  return success(res, { id: admin._id, isActive: admin.isActive }, `Admin ${admin.isActive ? 'activated' : 'deactivated'}`);
});

const getNextEmployeeCode = asyncHandler(async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return error(res, 'Only super admin can preview employee IDs', 403);
  }
  const employeeCode = await generateNextEmployeeCode();
  return success(res, { employeeCode }, 'Next employee ID retrieved');
});

const getPermissionCatalog = asyncHandler(async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return error(res, 'Only super admin can view permission catalog', 403);
  }
  return success(res, {
    permissions: PLATFORM_PERMISSION_DEFS,
    nested: nestPermissionsForCatalog(),
  }, 'Permission catalog retrieved');
});

const updateAdminPermissions = asyncHandler(async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return error(res, 'Only super admin can update admin privileges', 403);
  }

  const admin = await Platform.findById(req.params.id);
  if (!admin) return error(res, 'Admin not found', 404);
  if (admin.role === 'super_admin') {
    return error(res, 'Cannot change privileges for super admin', 400);
  }

  admin.permissions = sanitizePermissions(req.body?.permissions || {});
  await admin.save();

  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'admin_permissions_update',
    resource: 'user',
    resourceId: admin._id,
    details: { permissions: admin.permissions, enabledCount: countEnabledPermissions(admin.permissions) },
    ipAddress: req.ip,
  });

  const plain = admin.toObject();
  delete plain.password;
  return success(res, plain, 'Admin privileges updated');
});

module.exports = {
  createAdmin,
  getAdmins,
  getAdminById,
  updateAdmin,
  deleteAdmin,
  toggleAdminStatus,
  getNextEmployeeCode,
  getPermissionCatalog,
  updateAdminPermissions,
};