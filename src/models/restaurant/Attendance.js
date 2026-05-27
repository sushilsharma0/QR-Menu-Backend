const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema(
  {
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    shiftDate: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ['present', 'late', 'absent', 'half_day', 'leave'],
      default: 'present',
      index: true,
    },
    checkInAt: { type: Date, default: null },
    checkOutAt: { type: Date, default: null },
    scheduledStart: { type: String, default: '' },
    scheduledEnd: { type: String, default: '' },
    breakMinutes: { type: Number, default: 0, min: 0 },
    overtimeMinutes: { type: Number, default: 0, min: 0 },
    totalMinutes: { type: Number, default: 0, min: 0 },
    note: { type: String, default: '' },
    markedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

attendanceSchema.pre('validate', function setRestaurantId(next) {
  if (!this.restaurantId && this.restaurant) this.restaurantId = this.restaurant;
  next();
});

attendanceSchema.index(
  { restaurant: 1, branchId: 1, employee: 1, shiftDate: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);

module.exports = mongoose.model('Attendance', attendanceSchema);
