const mongoose = require('mongoose');

const fraudAlertSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', default: null, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    type: {
      type: String,
      enum: [
        'fake_refund',
        'suspicious_discount',
        'excessive_void_bills',
        'duplicate_orders',
        'multiple_failed_payments',
        'suspicious_payroll_edits',
        'unusual_sales_spike',
        'multiple_failed_login_attempts',
      ],
      required: true,
      index: true,
    },
    severity: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium', index: true },
    status: { type: String, enum: ['open', 'investigating', 'resolved', 'dismissed'], default: 'open', index: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    actor: { type: mongoose.Schema.Types.ObjectId, refPath: 'actorModel', default: null },
    actorModel: { type: String, enum: ['Restaurant', 'Employee', 'BranchAuth', 'Platform', 'Admin'], default: 'Restaurant' },
    resourceType: { type: String, default: '' },
    resourceId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    dedupeKey: { type: String, required: true, index: true },
    evidence: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    investigation: {
      assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Platform', default: null },
      startedAt: { type: Date, default: null },
      notes: { type: String, default: '' },
    },
    expiresAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

fraudAlertSchema.index({ dedupeKey: 1, status: 1 });
fraudAlertSchema.index({ restaurantId: 1, branchId: 1, createdAt: -1 });

module.exports = mongoose.model('FraudAlert', fraudAlertSchema);
