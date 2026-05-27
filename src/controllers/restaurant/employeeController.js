const asyncHandler = require('express-async-handler');
const Employee = require('../../models/restaurant/Employee');
const Restaurant = require('../../models/restaurant/Restaurant');
const { generateToken } = require('../../utils/generateToken');
const validatePassword = require('../../utils/validatePassword');
const { success, error } = require('../../utils/apiResponse');
const {
  sendEmployeeCredentialsEmail,
  isEmailConfigured
} = require('../../services/emailService');
const AuditLog = require('../../models/platform/AuditLog');
const { ensureDefaultBranch } = require('../../services/branchService');
const { resolveRestaurantFromClientInput } = require('../../services/restaurantPublicIdService');

const resolveEffectiveLimit = (restaurant, key) => {
  const savedLimit = Number(restaurant?.planLimits?.[key] ?? 0);
  if (savedLimit > 0) return savedLimit;
  const planLimit = Number(restaurant?.currentPlan?.limits?.[key] ?? 0);
  return planLimit > 0 ? planLimit : 0;
};

const generateTemporaryPassword = (username) => `${String(username || '').trim()}@123`;

/**
 * @desc    Employee login
 * @route   POST /api/restaurant/employees/login
 * @access  Public
 */
const employeeLogin = asyncHandler(async (req, res) => {
  const { username, password, restaurantId } = req.body;
  const {
    getClientIp,
    findActiveLoginLock,
    afterEmployeeLoginFailed,
    lockedResponsePayload,
  } = require('../../services/loginSecurityService');

  if (!username || !password || !restaurantId) {
    return error(res, 'Username, password and restaurant ID are required', 400);
  }

  const clientIp = getClientIp(req);
  const ipLock = await findActiveLoginLock({ ip: clientIp });
  if (ipLock) {
    return error(
      res,
      'Login failed. This connection is temporarily blocked due to suspicious activity.',
      423,
      lockedResponsePayload(ipLock),
    );
  }

  const restaurant = await resolveRestaurantFromClientInput(restaurantId);
  if (!restaurant || !restaurant.isActive) {
    return error(res, 'Invalid restaurant ID or restaurant is inactive', 403, { code: 'INVALID_RESTAURANT_ID' });
  }

  const restaurantLock = await findActiveLoginLock({ restaurantId: restaurant._id, ip: clientIp });
  if (restaurantLock) {
    return error(
      res,
      'Login failed. This restaurant account is locked due to suspicious activity.',
      423,
      lockedResponsePayload(restaurantLock),
    );
  }

  const employee = await Employee.findOne({
    username,
    restaurant: restaurant._id,
    isActive: true
  }).select('+password');
  
  if (!employee) {
    return error(res, 'Login failed. Invalid credentials.', 401);
  }

  const employeeLock = await findActiveLoginLock({ employeeId: employee._id, ip: clientIp });
  if (employeeLock) {
    return error(
      res,
      'Login failed. This staff account is locked due to suspicious activity.',
      423,
      lockedResponsePayload(employeeLock),
    );
  }
  
  const isMatch = await employee.comparePassword(password);

  if (!isMatch) {
    await AuditLog.create({
      user: employee._id,
      userModel: 'Employee',
      action: 'login_failed',
      resource: 'user',
      resourceId: employee._id,
      details: {
        reason: 'wrong_password',
        restaurantId: String(employee.restaurant),
        username,
        email: String(username).toLowerCase(),
      },
      ipAddress: clientIp || req.ip,
      userAgent: req.get('User-Agent')
    });

    const lockResult = await afterEmployeeLoginFailed(req, employee, restaurant._id, username);
    if (lockResult.locked) {
      return error(
        res,
        `Staff account locked after ${lockResult.failedAttempts || lockResult.maxAttempts} failed attempts. Contact your restaurant owner or platform administration to unlock.`,
        423,
        lockedResponsePayload(
          { lockedUntil: lockResult.lockedUntil, reason: lockResult.reason },
          {
            attemptsRemaining: 0,
            failedAttempts: lockResult.failedAttempts,
            maxAttempts: lockResult.maxAttempts,
          },
        ),
      );
    }

    const remaining = lockResult.attemptsRemaining ?? 0;
    const failed = lockResult.failedAttempts ?? 0;
    const max = lockResult.maxAttempts ?? 5;
    return error(
      res,
      `Incorrect password. ${failed} of ${max} failed attempt${failed === 1 ? '' : 's'} — ${remaining} remaining before lock.`,
      401,
      {
        code: 'LOGIN_FAILED',
        attemptsRemaining: remaining,
        failedAttempts: failed,
        maxAttempts: max,
      },
    );
  }

  employee.lastLogin = new Date();
  await employee.save();
  
  const token = generateToken({
    id: employee._id,
    employeeId: employee._id,
    restaurantId: employee.restaurant,
    name: employee.name,
    role: employee.role,
    scope: 'employee',
    branchId: employee.branchId || null,
  });

  await AuditLog.create({
    user: employee._id,
    userModel: 'Employee',
    action: 'login',
    resource: 'user',
    resourceId: employee._id,
    details: {
      restaurantId: String(employee.restaurant),
      role: employee.role
    },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent')
  });
  
  return success(res, {
    token,
    employee: {
      id: employee._id,
      restaurantId: employee.restaurant,
      branchId: employee.branchId || null,
      name: employee.name,
      username: employee.username,
      role: employee.role,
      currency: restaurant?.settings?.currency || 'Rs.',
      mustChangePassword: !employee.isPasswordChanged
    }
  }, 'Login successful');
});

const employeeLogout = asyncHandler(async (req, res) => {
  const employee = await Employee.findOne({
    _id: req.user.id,
    restaurant: req.user.restaurantId,
    branchId: req.user.branchId,
  }).select('restaurant role');
  if (!employee) {
    return error(res, 'Employee not found', 404);
  }

  await AuditLog.create({
    user: employee._id,
    userModel: 'Employee',
    action: 'logout',
    resource: 'user',
    resourceId: employee._id,
    details: {
      restaurantId: String(employee.restaurant),
      role: employee.role
    },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent')
  });

  return success(res, null, 'Logout successful');
});

/**
 * @desc    Create employee
 * @route   POST /api/restaurant/employees
 * @access  Private (Restaurant Admin)
 */
const createEmployee = asyncHandler(async (req, res) => {
  const {
    name,
    email,
    phone,
    username,
    role,
    department,
    designation,
    joiningDate,
    panNumber,
    bankName,
    bankAccountNumber,
    bankBranch,
    salary,
    allowance,
    customTdsPercent,
    customEpfPercent,
    customEmployerEpfPercent,
    branchId,
  } = req.body;
  const restaurantId = req.restaurantId || req.user.restaurantId || req.user.id;
  const effectiveBranchId =
    req.user.scope === 'branch_user'
      ? req.branchId
      : branchId || req.branchId || (await ensureDefaultBranch(restaurantId))?._id;
  
  if (!name || !email || !username || !role) {
    return error(res, 'Name, email, username and role are required', 400);
  }
  
  const exists = await Employee.findOne({ restaurant: restaurantId, branchId: effectiveBranchId, username });
  if (exists) {
    return error(res, 'Username already taken', 409);
  }

  const emailExists = await Employee.findOne({ restaurant: restaurantId, branchId: effectiveBranchId, email });
  if (emailExists) {
    return error(res, 'Email already in use', 409);
  }

  const restaurant = await Restaurant.findById(restaurantId)
    .select('name planLimits currentPlan')
    .populate('currentPlan', 'limits');
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }

  const maxEmployees = resolveEffectiveLimit(restaurant, 'maxEmployees');
  if (maxEmployees > 0) {
    const currentEmployees = await Employee.countDocuments({ restaurant: restaurantId, branchId: effectiveBranchId });
    if (currentEmployees >= maxEmployees) {
      return error(
        res,
        `Plan limit reached: maximum ${maxEmployees} employees allowed`,
        403,
        { code: 'PLAN_LIMIT_EMPLOYEES', maxAllowed: maxEmployees, currentCount: currentEmployees }
      );
    }
  }
  
  if (!isEmailConfigured()) {
    return error(res, 'Email service must be configured before creating employee credentials', 503);
  }

  const temporaryPassword = generateTemporaryPassword(username);
  
  const employee = await Employee.create({
    restaurant: restaurantId,
    restaurantId,
    branchId: effectiveBranchId,
    name,
    email,
    phone,
    username,
    profileImage: req.file?.path || null,
    // Employee model pre-save hook handles hashing
    password: temporaryPassword,
    role,
    department: department || '',
    designation: designation || '',
    joiningDate: joiningDate ? new Date(joiningDate) : null,
    panNumber: panNumber || '',
    bankName: bankName || '',
    bankAccountNumber: bankAccountNumber || '',
    bankBranch: bankBranch || '',
    salary: salary != null ? Number(salary) : 0,
    allowance: allowance != null && allowance !== '' ? Number(allowance) : 0,
    customTdsPercent: customTdsPercent != null ? Number(customTdsPercent) : null,
    customEpfPercent: customEpfPercent != null && customEpfPercent !== '' ? Number(customEpfPercent) : null,
    customEmployerEpfPercent:
      customEmployerEpfPercent != null && customEmployerEpfPercent !== ''
        ? Number(customEmployerEpfPercent)
        : null,
    isPasswordChanged: false,
    isActive: true,
    createdBy: restaurantId
  });

  const restaurantName = restaurant?.name || 'Your restaurant';

  const mailResult = await sendEmployeeCredentialsEmail(email, name, {
    restaurantName,
    restaurantId: String(restaurantId),
    username,
    temporaryPassword
  });
  const credentialsEmailSent = Boolean(mailResult.success);
  if (!credentialsEmailSent) {
    await Employee.deleteOne({ _id: employee._id, restaurant: restaurantId, branchId: effectiveBranchId });
    return error(res, 'Employee credentials email could not be sent; employee was not created', 502);
  }

  const payload = {
    id: employee._id,
    name: employee.name,
    username: employee.username,
    email: employee.email,
    role: employee.role,
    credentialsEmailSent
  };

  return success(res, payload, 'Employee created', 201);
});

/**
 * @desc    Get all employees
 * @route   GET /api/restaurant/employees
 * @access  Private (Restaurant Admin)
 */
const getEmployees = asyncHandler(async (req, res) => {
  const restaurantId = req.restaurantId || req.user.restaurantId || req.user.id;
  const employees = await Employee.find({ restaurant: restaurantId, branchId: req.branchId })
    .select('name email phone username role department designation joiningDate profileImage isPasswordChanged isActive lastLogin branchId createdAt updatedAt')
    .sort({ createdAt: -1 });
  
  return success(res, employees, 'Employees retrieved');
});

/**
 * @desc    Get employee by ID
 * @route   GET /api/restaurant/employees/:id
 * @access  Private (Restaurant Admin)
 */
const getEmployeeById = asyncHandler(async (req, res) => {
  const restaurantId = req.restaurantId || req.user.restaurantId || req.user.id;
  const employee = await Employee.findOne({
    _id: req.params.id,
    restaurant: restaurantId,
    branchId: req.branchId
  }).select('-password');
  
  if (!employee) {
    return error(res, 'Employee not found', 404);
  }
  
  return success(res, employee, 'Employee retrieved');
});

/**
 * @desc    Update employee
 * @route   PUT /api/restaurant/employees/:id
 * @access  Private (Restaurant Admin)
 */
const updateEmployee = asyncHandler(async (req, res) => {
  const restaurantId = req.restaurantId || req.user.restaurantId || req.user.id;
  const {
    name,
    email,
    phone,
    role,
    isActive,
    department,
    designation,
    joiningDate,
    panNumber,
    bankName,
    bankAccountNumber,
    bankBranch,
    salary,
    allowance,
    customTdsPercent,
    customEpfPercent,
    customEmployerEpfPercent,
  } = req.body;
  const updates = {};
  
  if (name) updates.name = name;
  if (email) updates.email = email;
  if (phone) updates.phone = phone;
  if (role) updates.role = role;
  if (typeof isActive === 'boolean') updates.isActive = isActive;
  if (department !== undefined) updates.department = department;
  if (designation !== undefined) updates.designation = designation;
  if (joiningDate !== undefined) updates.joiningDate = joiningDate ? new Date(joiningDate) : null;
  if (panNumber !== undefined) updates.panNumber = panNumber;
  if (bankName !== undefined) updates.bankName = bankName;
  if (bankAccountNumber !== undefined) updates.bankAccountNumber = bankAccountNumber;
  if (bankBranch !== undefined) updates.bankBranch = bankBranch;
  if (salary !== undefined) updates.salary = Number(salary);
  if (allowance !== undefined) updates.allowance = allowance === '' || allowance == null ? 0 : Number(allowance);
  if (customTdsPercent !== undefined) {
    updates.customTdsPercent = customTdsPercent === '' || customTdsPercent == null
      ? null
      : Number(customTdsPercent);
  }
  if (customEpfPercent !== undefined) {
    updates.customEpfPercent = customEpfPercent === '' || customEpfPercent == null
      ? null
      : Number(customEpfPercent);
  }
  if (customEmployerEpfPercent !== undefined) {
    updates.customEmployerEpfPercent =
      customEmployerEpfPercent === '' || customEmployerEpfPercent == null
        ? null
        : Number(customEmployerEpfPercent);
  }
  if (req.file?.path) updates.profileImage = req.file.path;
  
  const employee = await Employee.findOneAndUpdate(
    { _id: req.params.id, restaurant: restaurantId, branchId: req.branchId },
    updates,
    { new: true }
  ).select('-password');
  
  if (!employee) {
    return error(res, 'Employee not found', 404);
  }
  
  return success(res, employee, 'Employee updated');
});

/**
 * @desc    Delete employee
 * @route   DELETE /api/restaurant/employees/:id
 * @access  Private (Restaurant Admin)
 */
const deleteEmployee = asyncHandler(async (req, res) => {
  const restaurantId = req.restaurantId || req.user.restaurantId || req.user.id;
  const employee = await Employee.findOneAndDelete({
    _id: req.params.id,
    restaurant: restaurantId,
    branchId: req.branchId
  });
  
  if (!employee) {
    return error(res, 'Employee not found', 404);
  }
  
  return success(res, null, 'Employee deleted');
});

/**
 * @desc    Toggle employee status
 * @route   PATCH /api/restaurant/employees/:id/toggle-status
 * @access  Private (Restaurant Admin)
 */
const toggleEmployeeStatus = asyncHandler(async (req, res) => {
  const restaurantId = req.restaurantId || req.user.restaurantId || req.user.id;
  const employee = await Employee.findOne({
    _id: req.params.id,
    restaurant: restaurantId,
    branchId: req.branchId
  });
  
  if (!employee) {
    return error(res, 'Employee not found', 404);
  }
  
  employee.isActive = !employee.isActive;
  await employee.save();
  
  return success(res, { id: employee._id, isActive: employee.isActive }, `Employee ${employee.isActive ? 'activated' : 'deactivated'}`);
});

/**
 * @desc    Reset employee password
 * @route   POST /api/restaurant/employees/:id/reset-password
 * @access  Private (Restaurant Admin)
 */
const resetEmployeePassword = asyncHandler(async (req, res) => {
  const restaurantId = req.restaurantId || req.user.restaurantId || req.user.id;
  const employee = await Employee.findOne({
    _id: req.params.id,
    restaurant: restaurantId,
    branchId: req.branchId
  });
  
  if (!employee) {
    return error(res, 'Employee not found', 404);
  }
  
  if (!employee.email || !isEmailConfigured()) {
    return error(res, 'Email service must be configured before resetting employee credentials', 503);
  }

  const temporaryPassword = generateTemporaryPassword(employee.username);
  const restaurant = await Restaurant.findById(restaurantId).select('name');
  const restaurantName = restaurant?.name || 'Your restaurant';

  const mailResult = await sendEmployeeCredentialsEmail(employee.email, employee.name, {
    restaurantName,
    restaurantId: String(restaurantId),
    username: employee.username,
    temporaryPassword
  });
  const credentialsEmailSent = Boolean(mailResult.success);
  if (!credentialsEmailSent) {
    return error(res, 'Credentials email could not be sent; password was not changed', 502);
  }

  // Employee model pre-save hook handles hashing
  employee.password = temporaryPassword;
  employee.isPasswordChanged = false;
  await employee.save();

  return success(res, { credentialsEmailSent }, 'Temporary password sent');
});

/**
 * @desc    Change password (employee)
 * @route   POST /api/restaurant/employees/change-password
 * @access  Private (Employee)
 */
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  
  const employee = await Employee.findOne({
    _id: req.user.id,
    restaurant: req.user.restaurantId,
    branchId: req.user.branchId,
  }).select('+password');
  if (!employee) {
    return error(res, 'Employee not found', 404);
  }
  
  const isMatch = await employee.comparePassword(currentPassword);
  if (!isMatch) {
    return error(res, 'Current password is incorrect', 400);
  }
  
  const passwordValidation = validatePassword(newPassword);
  if (!passwordValidation.valid) {
    return error(res, passwordValidation.message, 400);
  }
  
  // Employee model pre-save hook handles hashing
  employee.password = newPassword;
  employee.isPasswordChanged = true;
  await employee.save();
  
  return success(res, null, 'Password changed successfully');
});

module.exports = {
  employeeLogin,
  employeeLogout,
  createEmployee,
  getEmployees,
  getEmployeeById,
  updateEmployee,
  deleteEmployee,
  toggleEmployeeStatus,
  resetEmployeePassword,
  changePassword
};
