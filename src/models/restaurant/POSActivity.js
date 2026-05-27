const mongoose = require('mongoose');

const posActivitySchema = new mongoose.Schema(
  {
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    shift: { type: mongoose.Schema.Types.ObjectId, ref: 'POSShift', default: null, index: true },
    actorType: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth'], default: 'Employee' },
    actor: { type: mongoose.Schema.Types.ObjectId, refPath: 'actorType' },
    action: { type: String, required: true, index: true },
    resourceType: { type: String, default: '' },
    resourceId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    risk: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'low', index: true },
    ipAddress: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },
  { timestamps: true }
);

posActivitySchema.index({ restaurant: 1, branchId: 1, createdAt: -1 });
posActivitySchema.index({ restaurant: 1, actor: 1, createdAt: -1 });

module.exports = mongoose.model('POSActivity', posActivitySchema);
