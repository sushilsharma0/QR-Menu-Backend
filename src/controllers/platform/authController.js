const asyncHandler = require('express-async-handler');
const Platform = require('../../models/platform/Platform');
const { generateToken } = require('../../utils/generateToken');
const { success, error } = require('../../utils/apiResponse');
const AuditLog = require('../../models/platform/AuditLog');
const notificationService = require('../../services/notificationService');

/**
 * @desc    Platform admin login
 * @route   POST /api/platform/auth/login
 * @access  Public
 */
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return error(res, 'Email and password are required', 400);
  }
  
  const admin = await Platform.findOne({ email, isActive: true }).select('+password');
  
  if (!admin) {
    return error(res, 'Invalid credentials', 401);
  }
  
  const isMatch = await admin.comparePassword(password);
  
  if (!isMatch) {
    await AuditLog.create({
      user: admin._id,
      userModel: 'Platform',
      action: 'login_failed',
      resource: 'user',
      resourceId: admin._id,
      details: {
        reason: 'wrong_password',
        email
      },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent')
    });
    return error(res, 'Invalid credentials', 401);
  }
  
  // Update last login
  admin.lastLogin = new Date();
  await admin.save();
  
  // Log audit
  await AuditLog.create({
    user: admin._id,
    userModel: 'Platform',
    action: 'login',
    resource: 'user',
    resourceId: admin._id,
    ipAddress: req.ip,
    userAgent: req.get('User-Agent')
  });

  await notificationService.sendNotification({
    recipientType: 'platform',
    recipientId: admin._id,
    type: 'auth_login',
    category: 'auth',
    priority: 'low',
    title: 'Platform login',
    message: `You signed in to platform dashboard at ${new Date().toLocaleString()}.`,
    metadata: { ipAddress: req.ip },
    actionUrl: '/notifications',
  });
  
  const token = generateToken({
    id: admin._id,
    email: admin.email,
    name: admin.name,
    role: admin.role,
    scope: 'platform',
    permissions: admin.permissions
  });
  
  return success(res, {
    token,
    user: {
      id: admin._id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      permissions: admin.permissions,
      profileImage: admin.profileImage || null,
      bio: admin.bio || '',
    }
  }, 'Login successful');
});

/**
 * @desc    Platform admin logout
 * @route   POST /api/platform/auth/logout
 * @access  Private
 */
const logout = asyncHandler(async (req, res) => {
  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'logout',
    resource: 'user',
    resourceId: req.user.id,
    ipAddress: req.ip,
    userAgent: req.get('User-Agent')
  });
  
  return success(res, null, 'Logout successful');
});

/**
 * @desc    Get platform admin profile
 * @route   GET /api/platform/auth/profile
 * @access  Private
 */
const getProfile = asyncHandler(async (req, res) => {
  const admin = await Platform.findById(req.user.id).select('-password');
  if (!admin) {
    return error(res, 'Admin not found', 404);
  }
  return success(res, {
    id: admin._id,
    name: admin.name,
    email: admin.email,
    role: admin.role,
    bio: admin.bio || '',
    profileImage: admin.profileImage || null,
    employeeCode: admin.employeeCode || null,
    designation: admin.designation || '',
    department: admin.department || '',
    phone: admin.phone || '',
    joiningDate: admin.joiningDate || null,
    payrollEligible: admin.payrollEligible !== false,
    lastLogin: admin.lastLogin || null,
    createdAt: admin.createdAt || null,
    updatedAt: admin.updatedAt || null,
    isActive: admin.isActive !== false,
  }, 'Profile retrieved');
});

/**
 * @desc    Update platform admin profile
 * @route   PUT /api/platform/auth/profile
 * @access  Private
 */
const updateProfile = asyncHandler(async (req, res) => {
  const { name, bio } = req.body;
  const updates = {};

  if (name !== undefined && String(name).trim()) updates.name = String(name).trim();
  if (bio !== undefined) updates.bio = String(bio).trim().slice(0, 500);
  if (req.file?.path) updates.profileImage = req.file.path;

  const admin = await Platform.findByIdAndUpdate(req.user.id, { $set: updates }, { new: true }).select('-password');
  
  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'profile_update',
    resource: 'user',
    resourceId: req.user.id,
    details: updates,
    ipAddress: req.ip
  });
  
  return success(res, {
    id: admin._id,
    name: admin.name,
    email: admin.email,
    role: admin.role,
    bio: admin.bio || '',
    profileImage: admin.profileImage || null,
    employeeCode: admin.employeeCode || null,
    designation: admin.designation || '',
    department: admin.department || '',
  }, 'Profile updated');
});

/**
 * @desc    Change password
 * @route   POST /api/platform/auth/change-password
 * @access  Private
 */
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const validatePassword = require('../../utils/validatePassword');
  
  const admin = await Platform.findById(req.user.id).select('+password');
  if (!admin) {
    return error(res, 'Admin not found', 404);
  }
  
  const isMatch = await admin.comparePassword(currentPassword);
  if (!isMatch) {
    return error(res, 'Current password is incorrect', 400);
  }
  
  const passwordValidation = validatePassword(newPassword);
  if (!passwordValidation.valid) {
    return error(res, passwordValidation.message, 400);
  }
  
  admin.password = newPassword;
  await admin.save();
  
  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'password_change',
    resource: 'user',
    resourceId: req.user.id,
    ipAddress: req.ip
  });
  
  return success(res, null, 'Password changed successfully');
});

module.exports = {
  login,
  logout,
  getProfile,
  updateProfile,
  changePassword
};