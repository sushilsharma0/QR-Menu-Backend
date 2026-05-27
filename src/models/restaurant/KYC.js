const mongoose = require('mongoose');

const kycSchema = new mongoose.Schema({
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', unique: true, required: true },
  ownerName: { type: String, required: true },
  ownerEmail: { type: String },
  ownerPhone: { type: String },
  idType: { type: String, enum: ['passport', 'national_id', 'driving_license', 'pan'], required: true },
  idNumber: { type: String, required: true },
  idDocument: { type: String },
  panNumber: { type: String },
  panDocument: { type: String },
  profilePhoto: { type: String },
  businessRegistrationNo: { type: String },
  businessRegistrationDoc: { type: String },
  addressProof: { type: String },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  rejectionReason: { type: String },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Platform' },
  reviewedAt: Date,
  reviewHistory: [{
    action: String,
    reviewedBy: mongoose.Schema.Types.ObjectId,
    reviewedAt: Date,
    reason: String,
    notes: String
  }],
  notes: String
}, { timestamps: true });

module.exports = mongoose.model('KYC', kycSchema);