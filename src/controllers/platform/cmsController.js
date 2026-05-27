const asyncHandler = require('express-async-handler');
const CMS = require('../../models/platform/CMS');
const { success, error } = require('../../utils/apiResponse');
const AuditLog = require('../../models/platform/AuditLog');

/**
 * @desc    Get all CMS content
 * @route   GET /api/platform/cms
 * @access  Public
 */
const getAllContent = asyncHandler(async (req, res) => {
  const { type, isActive } = req.query;
  const query = {};
  if (type) query.type = type;
  if (isActive) query.isActive = isActive === 'true';
  
  const content = await CMS.find(query).sort({ sortOrder: 1, key: 1 });
  return success(res, content, 'CMS content retrieved');
});

/**
 * @desc    Get CMS content by key
 * @route   GET /api/platform/cms/:key
 * @access  Public
 */
const getContentByKey = asyncHandler(async (req, res) => {
  const content = await CMS.findOne({ key: req.params.key });
  if (!content) {
    return error(res, 'Content not found', 404);
  }
  return success(res, content, 'Content retrieved');
});

/**
 * @desc    Create or update CMS content
 * @route   POST /api/platform/cms
 * @access  Private (Admin)
 */
const upsertContent = asyncHandler(async (req, res) => {
  const { title, content, type, metaTitle, metaDescription, metaKeywords, image, isActive, sortOrder } = req.body;
  const key = req.params.key || req.body.key;
  
  if (!key) {
    return error(res, 'Key is required', 400);
  }
  
  const existing = await CMS.findOne({ key });
  
  const updateData = {
    title,
    content,
    type: type || 'page',
    metaTitle,
    metaDescription,
    metaKeywords,
    image,
    sortOrder: sortOrder || 0,
    updatedBy: req.user.id,
    ...(typeof isActive === 'boolean' && { isActive })
  };
  
  const cmsContent = await CMS.findOneAndUpdate(
    { key },
    updateData,
    { upsert: true, new: true }
  );
  
  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: existing ? 'cms_update' : 'cms_create',
    resource: 'system',
    resourceId: cmsContent._id,
    details: { key, title, type },
    ipAddress: req.ip
  });
  
  return success(res, cmsContent, existing ? 'Content updated' : 'Content created', existing ? 200 : 201);
});

/**
 * @desc    Delete CMS content
 * @route   DELETE /api/platform/cms/:key
 * @access  Private (Admin)
 */
const deleteContent = asyncHandler(async (req, res) => {
  const content = await CMS.findOneAndDelete({ key: req.params.key });
  if (!content) {
    return error(res, 'Content not found', 404);
  }
  
  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'cms_delete',
    resource: 'system',
    resourceId: content._id,
    details: { key: content.key, title: content.title },
    ipAddress: req.ip
  });
  
  return success(res, null, 'Content deleted');
});

/**
 * @desc    Toggle content status
 * @route   PATCH /api/platform/cms/:key/toggle-status
 * @access  Private (Admin)
 */
const toggleContentStatus = asyncHandler(async (req, res) => {
  const content = await CMS.findOne({ key: req.params.key });
  if (!content) {
    return error(res, 'Content not found', 404);
  }
  
  content.isActive = !content.isActive;
  await content.save();
  
  return success(res, { key: content.key, isActive: content.isActive }, `Content ${content.isActive ? 'activated' : 'deactivated'}`);
});

module.exports = {
  getAllContent,
  getContentByKey,
  upsertContent,
  deleteContent,
  toggleContentStatus
};
