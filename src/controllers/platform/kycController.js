const asyncHandler = require('express-async-handler');
const KYC = require('../../models/restaurant/KYC');
const Restaurant = require('../../models/restaurant/Restaurant');
const { success, error } = require('../../utils/apiResponse');
const AuditLog = require('../../models/platform/AuditLog');
const { sendKYCStatusEmail } = require('../../services/emailService');
const notificationService = require('../../services/notificationService');

/**
 * @desc    Get all KYC applications
 * @route   GET /api/platform/kyc
 * @access  Private (Admin)
 */
const getKYCApplications = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  
  const query = {};
  if (status && status !== 'all') query.status = status;
  
  const skip = (page - 1) * limit;
  
  const applications = await KYC.find(query)
    .populate('restaurant', 'name email phone address logo city state')
    .populate('reviewedBy', 'name email')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(parseInt(limit));
  
  const total = await KYC.countDocuments(query);
  
  return success(res, {
    applications,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / limit)
    }
  }, 'KYC applications retrieved');
});

/**
 * @desc    Get single KYC application
 * @route   GET /api/platform/kyc/:id
 * @access  Private (Admin)
 */
const getKYCById = asyncHandler(async (req, res) => {
  const kyc = await KYC.findById(req.params.id)
    .populate('restaurant', 'name email phone address logo city state pincode')
    .populate('reviewedBy', 'name email');
  
  if (!kyc) {
    return error(res, 'KYC application not found', 404);
  }
  
  return success(res, kyc, 'KYC application retrieved');
});

/**
 * @desc    Get KYC by restaurant
 * @route   GET /api/platform/kyc/restaurant/:restaurantId
 * @access  Private (Admin)
 */
const getKYCByRestaurant = asyncHandler(async (req, res) => {
  const kyc = await KYC.findOne({ restaurant: req.params.restaurantId })
    .populate('reviewedBy', 'name email');
  
  if (!kyc) {
    return error(res, 'KYC not found for this restaurant', 404);
  }
  
  return success(res, kyc, 'KYC retrieved');
});

/**
 * @desc    Approve KYC
 * @route   PATCH /api/platform/kyc/:id/approve
 * @access  Private (Admin)
 */
const approveKYC = asyncHandler(async (req, res) => {
  const { notes } = req.body;
  
  const kyc = await KYC.findById(req.params.id);
  if (!kyc) {
    return error(res, 'KYC application not found', 404);
  }
  
  if (kyc.status === 'approved') {
    return error(res, 'KYC already approved', 400);
  }
  
  kyc.status = 'approved';
  kyc.reviewedBy = req.user.id;
  kyc.reviewedAt = new Date();
  kyc.notes = notes;
  kyc.reviewHistory = kyc.reviewHistory || [];
  kyc.reviewHistory.push({
    action: 'approved',
    reviewedBy: req.user.id,
    reviewedAt: new Date(),
    notes
  });
  
  await kyc.save();
  
  // Update restaurant KYC status
  await Restaurant.findByIdAndUpdate(kyc.restaurant, { isKYCVerified: true });
  
  // Send email notification
  const restaurant = await Restaurant.findById(kyc.restaurant);
  if (restaurant && restaurant.email) {
    await sendKYCStatusEmail(restaurant.email, restaurant.name, 'approved');
  }
  
  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'kyc_approve',
    resource: 'kyc',
    resourceId: kyc._id,
    details: { restaurantId: kyc.restaurant, notes },
    ipAddress: req.ip
  });

  await notificationService.sendNotification({
    recipientType: 'restaurant',
    recipientId: kyc.restaurant,
    category: 'kyc',
    type: 'kyc_approved',
    priority: 'high',
    title: 'KYC approved',
    message: 'Your KYC has been approved. You can now access all verified features.',
    relatedEntity: { entityType: 'kyc', entityId: kyc._id },
    actionUrl: '/notifications',
  });
  
  return success(res, { status: kyc.status, reviewedAt: kyc.reviewedAt }, 'KYC approved successfully');
});

/**
 * @desc    Reject KYC
 * @route   PATCH /api/platform/kyc/:id/reject
 * @access  Private (Admin)
 */
const rejectKYC = asyncHandler(async (req, res) => {
  const { reason, notes } = req.body;
  
  if (!reason) {
    return error(res, 'Rejection reason is required', 400);
  }
  
  const kyc = await KYC.findById(req.params.id);
  if (!kyc) {
    return error(res, 'KYC application not found', 404);
  }
  
  if (kyc.status === 'rejected') {
    return error(res, 'KYC already rejected', 400);
  }
  
  kyc.status = 'rejected';
  kyc.rejectionReason = reason;
  kyc.reviewedBy = req.user.id;
  kyc.reviewedAt = new Date();
  kyc.notes = notes;
  kyc.reviewHistory = kyc.reviewHistory || [];
  kyc.reviewHistory.push({
    action: 'rejected',
    reviewedBy: req.user.id,
    reviewedAt: new Date(),
    reason,
    notes
  });
  
  await kyc.save();
  
  // Update restaurant KYC status
  await Restaurant.findByIdAndUpdate(kyc.restaurant, { isKYCVerified: false });
  
  // Send email notification
  const restaurant = await Restaurant.findById(kyc.restaurant);
  if (restaurant && restaurant.email) {
    await sendKYCStatusEmail(restaurant.email, restaurant.name, 'rejected', reason);
  }
  
  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'kyc_reject',
    resource: 'kyc',
    resourceId: kyc._id,
    details: { restaurantId: kyc.restaurant, reason, notes },
    ipAddress: req.ip
  });

  await notificationService.sendNotification({
    recipientType: 'restaurant',
    recipientId: kyc.restaurant,
    category: 'kyc',
    type: 'kyc_rejected',
    priority: 'urgent',
    title: 'KYC rejected',
    message: `KYC was rejected: ${reason}`,
    relatedEntity: { entityType: 'kyc', entityId: kyc._id },
    actionUrl: '/notifications',
  });
  
  return success(res, { status: kyc.status, rejectionReason: reason }, 'KYC rejected');
});

/**
 * @desc    Get KYC statistics
 * @route   GET /api/platform/kyc/stats
 * @access  Private (Admin)
 */
const getKYCStats = asyncHandler(async (req, res) => {
  const stats = await KYC.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]);
  
  const result = { pending: 0, approved: 0, rejected: 0, total: 0 };
  stats.forEach(stat => {
    result[stat._id] = stat.count;
    result.total += stat.count;
  });
  
  return success(res, result, 'KYC statistics retrieved');
});

module.exports = {
  getKYCApplications,
  getKYCById,
  getKYCByRestaurant,
  approveKYC,
  rejectKYC,
  getKYCStats
};