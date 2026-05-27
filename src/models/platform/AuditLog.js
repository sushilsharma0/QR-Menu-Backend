const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: 'userModel' },
  userModel: { type: String, required: true, enum: ['Platform', 'Restaurant', 'Employee', 'Admin', 'BranchAuth'] },
  action: { type: String, required: true },
  resource: { type: String, enum: ['user', 'restaurant', 'employee', 'menu', 'order', 'kyc', 'plan', 'system', 'table', 'branch', 'branch_auth'] },
  resourceId: mongoose.Schema.Types.ObjectId,
  details: mongoose.Schema.Types.Mixed,
  ipAddress: String,
  userAgent: String,
  timestamp: { type: Date, default: Date.now }
}, { timestamps: true });

auditLogSchema.index({ user: 1, userModel: 1, timestamp: -1 });
auditLogSchema.index({ action: 1, timestamp: -1 });
auditLogSchema.index({ resource: 1, resourceId: 1 });
auditLogSchema.index({ timestamp: -1 });

auditLogSchema.post('save', function(doc) {
  setImmediate(() => {
    try {
      require('../../services/fraudDetectionService').evaluateAuditLog(doc);
    } catch (err) {
      console.warn('Fraud audit hook failed:', err.message);
    }
  });
});

module.exports = mongoose.model('AuditLog', auditLogSchema);
