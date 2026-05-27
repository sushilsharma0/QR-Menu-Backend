const mongoose = require('mongoose');
const asyncHandler = require('express-async-handler');
const CustomerFeedback = require('../../models/customer/CustomerFeedback');
const { success, error } = require('../../utils/apiResponse');
const AuditLog = require('../../models/platform/AuditLog');
const { readObjectId } = require('../../utils/inputValidation');

/**
 * @desc    List customer feedback / reviews (platform)
 * @route   GET /api/platform/feedback
 * @access  Private (platform staff)
 */
const listFeedback = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const filter = {};

  if (req.query.isActive === 'true') filter.isActive = true;
  if (req.query.isActive === 'false') filter.isActive = false;
  if (req.query.isPublic === 'true') filter.isPublic = true;
  if (req.query.isPublic === 'false') filter.isPublic = false;
  const restaurantId = readObjectId(req.query.restaurant);
  if (restaurantId) filter.restaurant = restaurantId;

  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    CustomerFeedback.find(filter)
      .populate('restaurant', 'name slug logo email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    CustomerFeedback.countDocuments(filter),
  ]);

  return success(
    res,
    {
      items,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 0,
      },
    },
    'Feedback retrieved',
  );
});

/**
 * @desc    Update moderation flags on a review
 * @route   PATCH /api/platform/feedback/:id
 * @access  Private (platform staff)
 */
const patchFeedback = asyncHandler(async (req, res) => {
  const { isActive, isPublic } = req.body;

  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return error(res, 'Invalid feedback id', 400);
  }

  if (typeof isActive !== 'boolean' && typeof isPublic !== 'boolean') {
    return error(res, 'Provide isActive and/or isPublic as booleans', 400);
  }

  const doc = await CustomerFeedback.findById(req.params.id);
  if (!doc) {
    return error(res, 'Feedback not found', 404);
  }

  if (typeof isActive === 'boolean') doc.isActive = isActive;
  if (typeof isPublic === 'boolean') doc.isPublic = isPublic;

  await doc.save();
  await doc.populate('restaurant', 'name slug logo email');

  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'feedback_moderation',
    resource: 'system',
    resourceId: doc._id,
    details: {
      feedbackId: String(doc._id),
      isActive: doc.isActive,
      isPublic: doc.isPublic,
    },
    ipAddress: req.ip,
  }).catch(() => {});

  return success(res, doc, 'Feedback updated');
});

module.exports = {
  listFeedback,
  patchFeedback,
};
