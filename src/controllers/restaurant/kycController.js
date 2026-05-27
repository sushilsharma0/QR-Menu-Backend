const asyncHandler = require('express-async-handler');
const KYC = require('../../models/restaurant/KYC');
const { success, error } = require('../../utils/apiResponse');

/**
 * @desc    Submit KYC application
 * @route   POST /api/restaurant/kyc/submit
 * @access  Private
 */
const submitKYC = asyncHandler(async (req, res) => {
  const { ownerName, ownerEmail, ownerPhone, idType, idNumber, panNumber, businessRegistrationNo } = req.body;
  const restaurantId = req.user.id;
  
  if (!ownerName || !idType || !idNumber) {
    return error(res, 'Owner name, ID type and ID number are required', 400);
  }
  
  const existing = await KYC.findOne({ restaurant: restaurantId });
  if (existing && existing.status === 'approved') {
    return error(res, 'KYC already approved', 400);
  }
  
  const updateData = {
    restaurant: restaurantId,
    ownerName,
    ownerEmail,
    ownerPhone,
    idType,
    idNumber,
    panNumber,
    businessRegistrationNo,
    status: 'pending'
  };
  
  if (req.files) {
    if (req.files.idDocument && req.files.idDocument[0]) {
      updateData.idDocument = req.files.idDocument[0].path;
    }
    if (req.files.panDocument && req.files.panDocument[0]) {
      updateData.panDocument = req.files.panDocument[0].path;
    }
    if (req.files.profilePhoto && req.files.profilePhoto[0]) {
      updateData.profilePhoto = req.files.profilePhoto[0].path;
    }
    if (req.files.businessRegistrationDoc && req.files.businessRegistrationDoc[0]) {
      updateData.businessRegistrationDoc = req.files.businessRegistrationDoc[0].path;
    }
    if (req.files.addressProof && req.files.addressProof[0]) {
      updateData.addressProof = req.files.addressProof[0].path;
    }
  }
  
  const kyc = await KYC.findOneAndUpdate(
    { restaurant: restaurantId },
    updateData,
    { upsert: true, new: true }
  );
  
  return success(res, kyc, 'KYC submitted for review');
});

/**
 * @desc    Get KYC status
 * @route   GET /api/restaurant/kyc/status
 * @access  Private
 */
const getKYCStatus = asyncHandler(async (req, res) => {
  const kyc = await KYC.findOne({ restaurant: req.user.id })
    .populate('reviewedBy', 'name email role');
  
  if (!kyc) {
    return success(res, { status: 'not_submitted' }, 'KYC not submitted');
  }
  
  return success(res, {
    _id: kyc._id,
    status: kyc.status,
    ownerName: kyc.ownerName,
    ownerEmail: kyc.ownerEmail,
    ownerPhone: kyc.ownerPhone,
    idType: kyc.idType,
    idNumber: kyc.idNumber,
    idDocument: kyc.idDocument,
    panNumber: kyc.panNumber,
    panDocument: kyc.panDocument,
    profilePhoto: kyc.profilePhoto,
    businessRegistrationNo: kyc.businessRegistrationNo,
    businessRegistrationDoc: kyc.businessRegistrationDoc,
    addressProof: kyc.addressProof,
    submittedAt: kyc.createdAt,
    updatedAt: kyc.updatedAt,
    reviewedAt: kyc.reviewedAt,
    reviewedBy: kyc.reviewedBy,
    rejectionReason: kyc.rejectionReason
  }, 'KYC status retrieved');
});

/**
 * @desc    Update KYC application
 * @route   PUT /api/restaurant/kyc/update
 * @access  Private
 */
const updateKYC = asyncHandler(async (req, res) => {
  const { ownerName, ownerEmail, ownerPhone, idType, idNumber, panNumber, businessRegistrationNo } = req.body;
  const restaurantId = req.user.id;
  
  const existing = await KYC.findOne({ restaurant: restaurantId });
  if (!existing) {
    return error(res, 'No KYC application found', 404);
  }
  
  if (existing.status === 'approved') {
    return error(res, 'Cannot update approved KYC', 400);
  }
  
  const updateData = { status: 'pending' };
  if (ownerName) updateData.ownerName = ownerName;
  if (ownerEmail) updateData.ownerEmail = ownerEmail;
  if (ownerPhone) updateData.ownerPhone = ownerPhone;
  if (idType) updateData.idType = idType;
  if (idNumber) updateData.idNumber = idNumber;
  if (panNumber) updateData.panNumber = panNumber;
  if (businessRegistrationNo) updateData.businessRegistrationNo = businessRegistrationNo;
  
  if (req.files) {
    if (req.files.idDocument && req.files.idDocument[0]) {
      updateData.idDocument = req.files.idDocument[0].path;
    }
    if (req.files.panDocument && req.files.panDocument[0]) {
      updateData.panDocument = req.files.panDocument[0].path;
    }
    if (req.files.profilePhoto && req.files.profilePhoto[0]) {
      updateData.profilePhoto = req.files.profilePhoto[0].path;
    }
    if (req.files.businessRegistrationDoc && req.files.businessRegistrationDoc[0]) {
      updateData.businessRegistrationDoc = req.files.businessRegistrationDoc[0].path;
    }
    if (req.files.addressProof && req.files.addressProof[0]) {
      updateData.addressProof = req.files.addressProof[0].path;
    }
  }
  
  const kyc = await KYC.findOneAndUpdate(
    { restaurant: restaurantId },
    updateData,
    { new: true }
  );
  
  return success(res, kyc, 'KYC updated successfully');
});

module.exports = {
  submitKYC,
  getKYCStatus,
  updateKYC
};
