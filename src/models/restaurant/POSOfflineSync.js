const mongoose = require('mongoose');

const posOfflineSyncSchema = new mongoose.Schema(
  {
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    clientRequestId: { type: String, required: true },
    deviceId: { type: String, default: '' },
    action: { type: String, required: true },
    payloadHash: { type: String, required: true },
    result: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    processedBy: { type: mongoose.Schema.Types.ObjectId, refPath: 'processedByModel' },
    processedByModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth'], default: 'Employee' },
    processedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

posOfflineSyncSchema.index(
  { restaurant: 1, branchId: 1, clientRequestId: 1 },
  { unique: true }
);

module.exports = mongoose.model('POSOfflineSync', posOfflineSyncSchema);
