const mongoose = require('mongoose');

const guestTableRequestSchema = new mongoose.Schema(
  {
    guestId: { type: String, required: true, index: true },
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    table: { type: mongoose.Schema.Types.ObjectId, ref: 'Table', required: true },
    requestType: {
      type: String,
      enum: ['call_waiter', 'need_water', 'need_tissue', 'need_bill'],
      required: true,
    },
    message: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'seen'], default: 'pending' },
  },
  { timestamps: true },
);

guestTableRequestSchema.index({ restaurant: 1, createdAt: -1 });

module.exports = mongoose.model('GuestTableRequest', guestTableRequestSchema);
