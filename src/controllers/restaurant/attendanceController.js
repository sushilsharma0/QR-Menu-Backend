const asyncHandler = require('express-async-handler');
const Attendance = require('../../models/restaurant/Attendance');
const Employee = require('../../models/restaurant/Employee');
const { success, error } = require('../../utils/apiResponse');
const { legacyRestaurantScope } = require('../../utils/tenantScope');

const todayKey = () => new Date().toISOString().slice(0, 10);

const calculateMinutes = (row) => {
  if (!row.checkInAt || !row.checkOutAt) return 0;
  const minutes = Math.max(0, Math.round((new Date(row.checkOutAt) - new Date(row.checkInAt)) / 60000));
  return Math.max(0, minutes - Number(row.breakMinutes || 0));
};

const getAttendance = asyncHandler(async (req, res) => {
  const {
    dateFrom = todayKey(),
    dateTo = dateFrom,
    employeeId,
    status,
  } = req.query;

  const query = {
    ...legacyRestaurantScope(req),
    isActive: true,
    shiftDate: { $gte: String(dateFrom), $lte: String(dateTo) },
  };
  if (employeeId) query.employee = employeeId;
  if (status && status !== 'all') query.status = status;

  const rows = await Attendance.find(query)
    .populate('employee', 'name username role profileImage isActive')
    .sort({ shiftDate: -1, checkInAt: -1, createdAt: -1 });

  return success(res, rows, 'Attendance retrieved');
});

const upsertAttendance = asyncHandler(async (req, res) => {
  const restaurantId = req.restaurantId || req.user.restaurantId || req.user.id;
  const {
    employeeId,
    shiftDate = todayKey(),
    status = 'present',
    checkInAt,
    checkOutAt,
    scheduledStart = '',
    scheduledEnd = '',
    breakMinutes = 0,
    overtimeMinutes = 0,
    note = '',
  } = req.body;

  if (!employeeId) return error(res, 'Employee is required', 400);

  const employee = await Employee.findOne({
    _id: employeeId,
    restaurant: restaurantId,
    branchId: req.branchId,
  }).select('_id');
  if (!employee) return error(res, 'Employee not found', 404);

  const payload = {
    restaurant: restaurantId,
    restaurantId,
    branchId: req.branchId,
    employee: employee._id,
    shiftDate: String(shiftDate).slice(0, 10),
    status,
    checkInAt: checkInAt ? new Date(checkInAt) : null,
    checkOutAt: checkOutAt ? new Date(checkOutAt) : null,
    scheduledStart,
    scheduledEnd,
    breakMinutes: Math.max(0, Number(breakMinutes || 0)),
    overtimeMinutes: Math.max(0, Number(overtimeMinutes || 0)),
    note: String(note || '').slice(0, 500),
    markedBy: req.user.employeeId || req.user.id,
    isActive: true,
  };
  payload.totalMinutes = calculateMinutes(payload);

  const row = await Attendance.findOneAndUpdate(
    {
      restaurant: restaurantId,
      branchId: req.branchId,
      employee: employee._id,
      shiftDate: payload.shiftDate,
      isActive: true,
    },
    { $set: payload },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).populate('employee', 'name username role profileImage isActive');

  return success(res, row, 'Attendance saved');
});

const checkIn = asyncHandler(async (req, res) => {
  const restaurantId = req.restaurantId || req.user.restaurantId || req.user.id;
  const employeeId = req.params.employeeId || req.user.employeeId || req.user.id;
  const shiftDate = String(req.body.shiftDate || todayKey()).slice(0, 10);
  const employee = await Employee.findOne({ _id: employeeId, restaurant: restaurantId, branchId: req.branchId }).select('_id');
  if (!employee) return error(res, 'Employee not found', 404);

  const row = await Attendance.findOneAndUpdate(
    { restaurant: restaurantId, branchId: req.branchId, employee: employee._id, shiftDate, isActive: true },
    {
      $setOnInsert: {
        restaurant: restaurantId,
        restaurantId,
        branchId: req.branchId,
        employee: employee._id,
        shiftDate,
        status: 'present',
        markedBy: req.user.employeeId || req.user.id,
      },
      $set: { checkInAt: new Date() },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).populate('employee', 'name username role profileImage isActive');

  return success(res, row, 'Checked in');
});

const checkOut = asyncHandler(async (req, res) => {
  const restaurantId = req.restaurantId || req.user.restaurantId || req.user.id;
  const employeeId = req.params.employeeId || req.user.employeeId || req.user.id;
  const shiftDate = String(req.body.shiftDate || todayKey()).slice(0, 10);
  const row = await Attendance.findOne({
    restaurant: restaurantId,
    branchId: req.branchId,
    employee: employeeId,
    shiftDate,
    isActive: true,
  });
  if (!row) return error(res, 'No check-in found for this date', 404);
  row.checkOutAt = new Date();
  row.totalMinutes = calculateMinutes(row);
  await row.save();
  await row.populate('employee', 'name username role profileImage isActive');
  return success(res, row, 'Checked out');
});

module.exports = {
  getAttendance,
  upsertAttendance,
  checkIn,
  checkOut,
};
