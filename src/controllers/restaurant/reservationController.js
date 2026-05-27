const asyncHandler = require('express-async-handler');
const Reservation = require('../../models/restaurant/Reservation');
const Table = require('../../models/restaurant/Table');
const { success, error } = require('../../utils/apiResponse');
const { legacyRestaurantScope } = require('../../utils/tenantScope');
const { writeAuditLog } = require('../../utils/auditLog');
const { emitPosTableUpdated } = require('../../services/socketService');

const validStatuses = ['pending', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show'];
const tableStatusForReservation = (status) => {
  if (['pending', 'confirmed'].includes(status)) return 'reserved';
  if (status === 'seated') return 'occupied';
  if (['completed', 'cancelled', 'no_show'].includes(status)) return 'available';
  return null;
};

const parseDate = (value, fallback = new Date()) => {
  const date = value ? new Date(value) : fallback;
  return Number.isNaN(date.getTime()) ? null : date;
};

const getReservations = asyncHandler(async (req, res) => {
  const { status, dateFrom, dateTo, search } = req.query;
  const query = { ...legacyRestaurantScope(req), isActive: true };

  if (status && status !== 'all') {
    const statuses = String(status).split(',').map((s) => s.trim()).filter(Boolean);
    query.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
  }

  if (dateFrom || dateTo) {
    query.reservationAt = {};
    const from = parseDate(dateFrom);
    const to = parseDate(dateTo);
    if (from) query.reservationAt.$gte = from;
    if (to) query.reservationAt.$lte = to;
    if (Object.keys(query.reservationAt).length === 0) delete query.reservationAt;
  }

  if (search && String(search).trim()) {
    const esc = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.$or = [
      { customerName: new RegExp(esc, 'i') },
      { customerPhone: new RegExp(esc, 'i') },
      { customerEmail: new RegExp(esc, 'i') },
    ];
  }

  const reservations = await Reservation.find(query)
    .populate('table', 'tableNumber floor area posStatus')
    .sort({ reservationAt: 1 })
    .limit(300);

  return success(res, reservations, 'Reservations retrieved');
});

const createReservation = asyncHandler(async (req, res) => {
  const restaurantId = req.user.restaurantId || req.user.id;
  const {
    customerName,
    customerPhone = '',
    customerEmail = '',
    partySize = 2,
    reservationAt,
    durationMinutes = 90,
    table,
    notes = '',
    source = 'staff',
    status = 'pending',
  } = req.body;

  if (!customerName || !reservationAt) {
    return error(res, 'Customer name and reservation time are required', 400);
  }
  if (!validStatuses.includes(status)) return error(res, 'Invalid reservation status', 400);

  const reservedAt = parseDate(reservationAt);
  if (!reservedAt) return error(res, 'Invalid reservation time', 400);

  let tableDoc = null;
  if (table) {
    tableDoc = await Table.findOne({
      _id: table,
      restaurant: restaurantId,
      branchId: req.branchId,
      isDeleted: false,
    });
    if (!tableDoc) return error(res, 'Table not found', 404);
  }

  const reservation = await Reservation.create({
    restaurant: restaurantId,
    restaurantId,
    branchId: req.branchId,
    table: tableDoc?._id || null,
    customerName: String(customerName).trim(),
    customerPhone,
    customerEmail,
    partySize: Math.max(1, Number(partySize || 1)),
    reservationAt: reservedAt,
    durationMinutes: Math.max(15, Number(durationMinutes || 90)),
    notes: String(notes || '').slice(0, 700),
    source,
    status,
    statusHistory: [{ status, timestamp: new Date(), updatedBy: req.user.employeeId || req.user.id }],
  });

  if (tableDoc && ['pending', 'confirmed'].includes(status)) {
    tableDoc.posStatus = 'reserved';
    await tableDoc.save();
    emitPosTableUpdated(String(restaurantId), tableDoc);
  }

  await writeAuditLog(req, {
    action: 'reservation_create',
    resource: 'reservation',
    resourceId: reservation._id,
    details: { customerName: reservation.customerName, status: reservation.status },
  });

  await reservation.populate('table', 'tableNumber floor area posStatus');
  return success(res, reservation, 'Reservation created', 201);
});

const updateReservation = asyncHandler(async (req, res) => {
  const reservation = await Reservation.findOne({
    _id: req.params.id,
    ...legacyRestaurantScope(req),
    isActive: true,
  });
  if (!reservation) return error(res, 'Reservation not found', 404);

  const allowed = ['customerName', 'customerPhone', 'customerEmail', 'partySize', 'durationMinutes', 'notes', 'source'];
  allowed.forEach((field) => {
    if (req.body[field] != null) reservation[field] = req.body[field];
  });
  if (req.body.reservationAt) {
    const date = parseDate(req.body.reservationAt);
    if (!date) return error(res, 'Invalid reservation time', 400);
    reservation.reservationAt = date;
  }
  if (req.body.table !== undefined) {
    if (!req.body.table) {
      reservation.table = null;
    } else {
      const table = await Table.findOne({
        _id: req.body.table,
        restaurant: reservation.restaurant,
        branchId: reservation.branchId,
        isDeleted: false,
      });
      if (!table) return error(res, 'Table not found', 404);
      reservation.table = table._id;
    }
  }
  if (req.body.status && req.body.status !== reservation.status) {
    if (!validStatuses.includes(req.body.status)) return error(res, 'Invalid reservation status', 400);
    reservation.status = req.body.status;
    reservation.statusHistory.push({
      status: req.body.status,
      timestamp: new Date(),
      updatedBy: req.user.employeeId || req.user.id,
      note: req.body.note || '',
    });
  }

  await reservation.save();
  const tableStatus = tableStatusForReservation(reservation.status);
  if (reservation.table && tableStatus) {
    const table = await Table.findOne({
      _id: reservation.table,
      restaurant: reservation.restaurant,
      branchId: reservation.branchId,
      isDeleted: false,
    });
    if (table) {
      table.posStatus = tableStatus;
      await table.save();
      emitPosTableUpdated(String(reservation.restaurant), table);
    }
  }
  await reservation.populate('table', 'tableNumber floor area posStatus');
  return success(res, reservation, 'Reservation updated');
});

const deleteReservation = asyncHandler(async (req, res) => {
  const reservation = await Reservation.findOne({
    _id: req.params.id,
    ...legacyRestaurantScope(req),
    isActive: true,
  });
  if (!reservation) return error(res, 'Reservation not found', 404);
  reservation.isActive = false;
  reservation.status = 'cancelled';
  reservation.statusHistory.push({
    status: 'cancelled',
    timestamp: new Date(),
    updatedBy: req.user.employeeId || req.user.id,
    note: 'Deleted from reservations page',
  });
  await reservation.save();
  return success(res, null, 'Reservation deleted');
});

module.exports = {
  getReservations,
  createReservation,
  updateReservation,
  deleteReservation,
};
