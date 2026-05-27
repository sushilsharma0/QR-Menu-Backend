const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Restaurant = require('../../models/restaurant/Restaurant');
const RestaurantReferral = require('../../models/restaurant/RestaurantReferral');
const KYC = require('../../models/restaurant/KYC');
const Subscription = require('../../models/shared/Subscription');
const { success, error } = require('../../utils/apiResponse');
const AuditLog = require('../../models/platform/AuditLog');
const { sendKYCStatusEmail, sendWelcomeEmail } = require('../../services/emailService');
const generateSlug = require('../../utils/generateSlug');
const { readNumber, readSearchRegex, readString } = require('../../utils/inputValidation');

/**
 * @desc    Get all restaurants
 * @route   GET /api/platform/restaurants
 * @access  Private (Admin)
 */
const getAllRestaurants = asyncHandler(async (req, res) => {
  const status = readString(req.query.status, { allowed: ['active', 'inactive'] });
  const kycStatus = readString(req.query.kycStatus, { max: 32 });
  const search = readSearchRegex(req.query.search);
  const page = readNumber(req.query.page, { min: 1, max: 10000, integer: true, fallback: 1 });
  const limit = readNumber(req.query.limit, { min: 1, max: 100, integer: true, fallback: 20 });
  
  const query = { isDeleted: false };
  if (status === 'active') query.isActive = true;
  if (status === 'inactive') query.isActive = false;
  
  if (search) {
    query.$or = [
      { name: search },
      { email: search },
      { phone: search }
    ];
  }
  
  const skip = (page - 1) * limit;
  
  let restaurants = await Restaurant.find(query)
    .select('-password')
    .populate('currentPlan', 'name price')
    .populate('requestedPlan', 'name price')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);
  
  // Get KYC status for each restaurant
  const restaurantsWithKYC = await Promise.all(restaurants.map(async (restaurant) => {
    const kyc = await KYC.findOne({ restaurant: restaurant._id });
    return {
      ...restaurant.toObject(),
      kycStatus: kyc ? kyc.status : 'not_submitted',
      kycSubmittedAt: kyc ? kyc.createdAt : null
    };
  }));
  
  // Apply KYC filter if needed
  if (kycStatus && kycStatus !== 'all') {
    const filtered = restaurantsWithKYC.filter(r => r.kycStatus === kycStatus);
    return success(res, {
      restaurants: filtered,
      pagination: { page, limit, total: filtered.length, pages: Math.ceil(filtered.length / limit) }
    }, 'Restaurants retrieved');
  }
  
  const total = await Restaurant.countDocuments(query);
  
  return success(res, {
    restaurants: restaurantsWithKYC,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  }, 'Restaurants retrieved');
});

/**
 * @desc    Get single restaurant by ID
 * @route   GET /api/platform/restaurants/:id
 * @access  Private (Admin)
 */
const getRestaurantById = asyncHandler(async (req, res) => {
  const restaurant = await Restaurant.findById(req.params.id)
    .select('-password')
    .populate('currentPlan', 'name price features limits')
    .populate('requestedPlan', 'name price');
  
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }
  
  const kyc = await KYC.findOne({ restaurant: restaurant._id });
  const PackageHistory = require('../../models/shared/PackageHistory');
  const packageHistory = await PackageHistory.find({ restaurant: restaurant._id })
    .populate('package', 'name')
    .sort({ createdAt: -1 })
    .limit(10);
  const pendingReferral = await RestaurantReferral.findOne({
    $or: [
      { status: 'pending', referrerRestaurant: restaurant._id },
      { status: 'pending', referredRestaurant: restaurant._id },
      { status: 'qualified', referrerRestaurant: restaurant._id },
    ],
  })
    .populate('referrerRestaurant', 'name email')
    .populate('referredRestaurant', 'name email')
    .sort({ createdAt: -1 })
    .lean();

  const referralRole =
    pendingReferral && String(pendingReferral.referrerRestaurant?._id) === String(restaurant._id)
      ? 'referrer'
      : 'referred';
  const referralBenefit = pendingReferral
    ? {
        id: pendingReferral._id,
        status: pendingReferral.status,
        rewardDays: pendingReferral.rewardDays || 30,
        role: referralRole,
        referrerRestaurantName: pendingReferral.referrerRestaurant?.name || '',
        referredRestaurantName: pendingReferral.referredRestaurant?.name || '',
        referralCode: pendingReferral.referralCode,
        message:
          referralRole === 'referrer' && pendingReferral.status === 'qualified'
            ? '1 month will be added when this restaurant activates their next plan.'
            : referralRole === 'referrer'
            ? '1 month will be added in this restaurant\'s next plan after the referred restaurant activates their first plan.'
            : '1 month will be added when this restaurant activates their first plan.',
      }
    : null;
  
  const canAssignCustomPlan = restaurant.canAssignCustomPlan();
  let customPlanBlockedReason = null;
  if (!canAssignCustomPlan) {
    const planName = restaurant.currentPlan?.name || 'Subscription plan';
    const ends = restaurant.planEndDate
      ? new Date(restaurant.planEndDate).toLocaleDateString('en-IN', { dateStyle: 'medium' })
      : null;
    customPlanBlockedReason = ends
      ? `Active catalog subscription (${planName}) until ${ends}.`
      : `Active catalog subscription (${planName}).`;
  }

  return success(res, {
    ...restaurant.toObject(),
    kyc,
    packageHistory,
    referralBenefit,
    canAssignCustomPlan,
    customPlanBlockedReason,
  }, 'Restaurant retrieved');
});

/**
 * @desc    Get operational overview for a restaurant
 * @route   GET /api/platform/restaurants/:id/operations
 * @access  Private (Admin)
 */
const getRestaurantOperationalOverview = asyncHandler(async (req, res) => {
  const restaurant = await Restaurant.findOne({ _id: req.params.id, isDeleted: false })
    .select('name logo slug settings isActive currentPlan planEndDate trialEndsAt planLimits')
    .populate('currentPlan', 'name price limits');

  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }

  const restaurantId = new mongoose.Types.ObjectId(String(restaurant._id));
  const Table = require('../../models/restaurant/Table');
  const Category = require('../../models/restaurant/Category');
  const MenuItem = require('../../models/restaurant/MenuItem');
  const CustomerOrder = require('../../models/restaurant/CustomerOrder');
  const Transaction = require('../../models/restaurant/Transaction');

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - 30);

  const [
    tableCounts,
    menuCounts,
    totalOrders,
    todayOrders,
    monthOrders,
    activeOrders,
    monthRevenueRows,
    totalRevenueRows,
    salesDaily,
    popularItems,
    recentOrders
  ] = await Promise.all([
    Table.aggregate([
      { $match: { restaurant: restaurantId, isDeleted: false } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: ['$isActive', 1, 0] } },
          capacity: { $sum: '$capacity' }
        }
      }
    ]),
    Promise.all([
      Category.countDocuments({ restaurant: restaurantId, isDeleted: false }),
      Category.countDocuments({ restaurant: restaurantId, isActive: true, isDeleted: false }),
      MenuItem.countDocuments({ restaurant: restaurantId, isDeleted: false }),
      MenuItem.countDocuments({ restaurant: restaurantId, isAvailable: true, isDeleted: false }),
      MenuItem.find({ restaurant: restaurantId, isDeleted: false })
        .populate('category', 'name')
        .sort({ updatedAt: -1 })
        .limit(6)
        .select('name price image isAvailable preparationTime category updatedAt')
    ]),
    CustomerOrder.countDocuments({ restaurant: restaurantId }),
    CustomerOrder.countDocuments({ restaurant: restaurantId, createdAt: { $gte: startOfToday } }),
    CustomerOrder.countDocuments({ restaurant: restaurantId, createdAt: { $gte: startOfMonth } }),
    CustomerOrder.aggregate([
      { $match: { restaurant: restaurantId, status: { $in: ['pending', 'confirmed', 'preparing', 'ready'] } } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]),
    Transaction.aggregate([
      { $match: { restaurant: restaurantId, status: 'success', createdAt: { $gte: startOfMonth, $lte: now } } },
      { $group: { _id: null, revenue: { $sum: '$amount' }, transactions: { $sum: 1 } } }
    ]),
    Transaction.aggregate([
      { $match: { restaurant: restaurantId, status: 'success' } },
      { $group: { _id: null, revenue: { $sum: '$amount' }, transactions: { $sum: 1 } } }
    ]),
    Transaction.aggregate([
      { $match: { restaurant: restaurantId, status: 'success', createdAt: { $gte: startDate, $lte: now } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          revenue: { $sum: '$amount' },
          transactions: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]),
    CustomerOrder.aggregate([
      { $match: { restaurant: restaurantId, createdAt: { $gte: startDate } } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.name',
          totalQuantity: { $sum: '$items.quantity' },
          totalRevenue: { $sum: { $multiply: ['$items.quantity', '$items.price'] } }
        }
      },
      { $sort: { totalQuantity: -1 } },
      { $limit: 5 }
    ]),
    CustomerOrder.find({ restaurant: restaurantId })
      .populate('table', 'tableNumber')
      .sort({ createdAt: -1 })
      .limit(8)
      .select('orderNumber customerName table grandTotal status paymentStatus createdAt')
  ]);

  const [totalCategories, activeCategories, totalMenuItems, availableMenuItems, recentMenuItems] = menuCounts;
  const tableSummary = tableCounts[0] || { total: 0, active: 0, capacity: 0 };
  const activeOrderSummary = activeOrders.reduce(
    (acc, item) => ({ ...acc, [item._id]: item.count }),
    { pending: 0, confirmed: 0, preparing: 0, ready: 0 }
  );

  return success(res, {
    restaurant,
    tables: {
      total: tableSummary.total || 0,
      active: tableSummary.active || 0,
      inactive: (tableSummary.total || 0) - (tableSummary.active || 0),
      capacity: tableSummary.capacity || 0
    },
    menu: {
      totalCategories,
      activeCategories,
      totalMenuItems,
      availableMenuItems,
      unavailableMenuItems: totalMenuItems - availableMenuItems,
      recentItems: recentMenuItems
    },
    sales: {
      todayOrders,
      monthOrders,
      totalOrders,
      activeOrders: activeOrderSummary,
      monthRevenue: monthRevenueRows[0]?.revenue || 0,
      monthTransactions: monthRevenueRows[0]?.transactions || 0,
      totalRevenue: totalRevenueRows[0]?.revenue || 0,
      totalTransactions: totalRevenueRows[0]?.transactions || 0,
      daily: salesDaily.map((item) => ({ date: item._id, revenue: item.revenue, transactions: item.transactions })),
      popularItems,
      recentOrders
    }
  }, 'Restaurant operations retrieved');
});

/**
 * @desc    Create restaurant (by platform admin)
 * @route   POST /api/platform/restaurants
 * @access  Private (Super Admin)
 */
const createRestaurant = asyncHandler(async (req, res) => {
  const { name, email, phone, password, address, city, state, pincode } = req.body;
  
  if (!name || !email || !phone || !password) {
    return error(res, 'Name, email, phone and password are required', 400);
  }
  
  const nameExists = await Restaurant.findOne({ name });
  if (nameExists) return error(res, 'Restaurant name already taken', 409);
  
  const emailExists = await Restaurant.findOne({ email });
  if (emailExists) return error(res, 'Email already registered', 409);
  
  const slug = await generateSlug(name, Restaurant);
  
  const TRIAL_DAYS = parseInt(process.env.RESTAURANT_TRIAL_DAYS, 10) || 14;
  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + TRIAL_DAYS);

  const restaurant = await Restaurant.create({
    name,
    email,
    phone,
    password,
    address,
    city,
    state,
    pincode,
    slug,
    trialEndsAt,
    planRequestStatus: 'none'
  });
  
  await sendWelcomeEmail(email, name);
  
  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'restaurant_create',
    resource: 'restaurant',
    resourceId: restaurant._id,
    details: { name, email, phone },
    ipAddress: req.ip
  });
  
  return success(res, {
    id: restaurant._id,
    name: restaurant.name,
    email: restaurant.email,
    slug: restaurant.slug
  }, 'Restaurant created successfully', 201);
});

/**
 * @desc    Update restaurant
 * @route   PUT /api/platform/restaurants/:id
 * @access  Private (Admin)
 */
const updateRestaurant = asyncHandler(async (req, res) => {
  const { name, phone, address, city, state, pincode, isActive, description, openingTime, closingTime } = req.body;
  const updates = {};
  
  if (name) updates.name = name;
  if (phone) updates.phone = phone;
  if (address) updates.address = address;
  if (city) updates.city = city;
  if (state) updates.state = state;
  if (pincode) updates.pincode = pincode;
  if (description) updates.description = description;
  if (openingTime) updates.openingTime = openingTime;
  if (closingTime) updates.closingTime = closingTime;
  if (typeof isActive === 'boolean') updates.isActive = isActive;
  
  const restaurant = await Restaurant.findByIdAndUpdate(req.params.id, updates, { new: true }).select('-password');
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }
  
  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'restaurant_update',
    resource: 'restaurant',
    resourceId: restaurant._id,
    details: updates,
    ipAddress: req.ip
  });
  
  return success(res, restaurant, 'Restaurant updated');
});

/**
 * @desc    Delete restaurant (soft delete)
 * @route   DELETE /api/platform/restaurants/:id
 * @access  Private (Super Admin)
 */
const deleteRestaurant = asyncHandler(async (req, res) => {
  const restaurant = await Restaurant.findByIdAndUpdate(req.params.id, { isDeleted: true, isActive: false }, { new: true });
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }
  
  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'restaurant_delete',
    resource: 'restaurant',
    resourceId: restaurant._id,
    details: { name: restaurant.name },
    ipAddress: req.ip
  });
  
  return success(res, null, 'Restaurant deleted');
});

/**
 * @desc    Toggle restaurant status
 * @route   PATCH /api/platform/restaurants/:id/toggle-status
 * @access  Private (Admin)
 */
const toggleRestaurantStatus = asyncHandler(async (req, res) => {
  const restaurant = await Restaurant.findById(req.params.id);
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }
  
  restaurant.isActive = !restaurant.isActive;
  await restaurant.save();
  
  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'restaurant_status_toggle',
    resource: 'restaurant',
    resourceId: restaurant._id,
    details: { isActive: restaurant.isActive },
    ipAddress: req.ip
  });
  
  return success(res, { id: restaurant._id, isActive: restaurant.isActive }, `Restaurant ${restaurant.isActive ? 'activated' : 'deactivated'}`);
});

/**
 * @desc    Reset restaurant password
 * @route   POST /api/platform/restaurants/:id/reset-password
 * @access  Private (Super Admin)
 */
const resetRestaurantPassword = asyncHandler(async (req, res) => {
  const { newPassword } = req.body;
  const validatePassword = require('../../utils/validatePassword');
  
  if (!newPassword) {
    return error(res, 'New password is required', 400);
  }
  
  const passwordValidation = validatePassword(newPassword);
  if (!passwordValidation.valid) {
    return error(res, passwordValidation.message, 400);
  }
  
  const restaurant = await Restaurant.findById(req.params.id);
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }
  
  restaurant.password = newPassword;
  await restaurant.save();
  
  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'restaurant_password_reset',
    resource: 'restaurant',
    resourceId: restaurant._id,
    ipAddress: req.ip
  });
  
  return success(res, null, 'Password reset successfully');
});

/**
 * @desc    Get restaurant statistics
 * @route   GET /api/platform/restaurants/stats
 * @access  Private (Admin)
 */
const getRestaurantStats = asyncHandler(async (req, res) => {
  const total = await Restaurant.countDocuments({ isDeleted: false });
  const active = await Restaurant.countDocuments({ isActive: true, isDeleted: false });
  const inactive = await Restaurant.countDocuments({ isActive: false, isDeleted: false });
  const kycPending = await KYC.countDocuments({ status: 'pending' });
  const kycApproved = await KYC.countDocuments({ status: 'approved' });
  const kycRejected = await KYC.countDocuments({ status: 'rejected' });
  
  return success(res, {
    total,
    active,
    inactive,
    kyc: { pending: kycPending, approved: kycApproved, rejected: kycRejected }
  }, 'Statistics retrieved');
});

module.exports = {
  getAllRestaurants,
  getRestaurantById,
  getRestaurantOperationalOverview,
  createRestaurant,
  updateRestaurant,
  deleteRestaurant,
  toggleRestaurantStatus,
  resetRestaurantPassword,
  getRestaurantStats
};
