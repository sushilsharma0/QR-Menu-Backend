const mongoose = require('mongoose');

const ticketSchema = new mongoose.Schema({
  ticketNumber: { type: String, unique: true, required: true },
  restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
  subject: { type: String, required: true },
  description: { type: String, required: true },
  category: {
    type: String,
    enum: ['technical', 'billing', 'feature_request', 'account', 'other'],
    default: 'other'
  },
  status: {
    type: String,
    enum: ['open', 'in_progress', 'resolved', 'closed'],
    default: 'open'
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  },
  attachments: [{
    url: String,
    fileName: String,
    uploadedAt: { type: Date, default: Date.now }
  }],
  replies: [{
    responder: {
      id: mongoose.Schema.Types.ObjectId,
      model: { type: String, enum: ['Restaurant', 'Platform'] },
      name: String,
      role: String
    },
    message: String,
    attachments: [{
      url: String,
      fileName: String
    }],
    createdAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Platform' },
  resolvedAt: Date,
  closedAt: Date,
  lastReplyAt: Date,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

ticketSchema.pre('validate', async function(next) {
  if (this.isNew && !this.ticketNumber) {
    const count = await this.constructor.countDocuments();
    this.ticketNumber = `TKT-${Date.now()}-${count + 1}`;
  }
  next();
});

ticketSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Ticket', ticketSchema);
