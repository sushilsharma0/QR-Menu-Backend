const asyncHandler = require('express-async-handler');
const Table = require('../../models/restaurant/Table');
const CustomerOrder = require('../../models/restaurant/CustomerOrder');
const Restaurant = require('../../models/restaurant/Restaurant');
const resolveRestaurantId = require('../../middleware/restaurant/resolveRestaurantId');
const { generateTableQR, resolveTableFromQrToken } = require('../../services/qrService');
const { emitPosTableUpdated } = require('../../services/socketService');
const { emitOrderUpdate } = require('../../services/socketService');
const { success, error } = require('../../utils/apiResponse');

function restaurantIdFromReq(req) {
  return resolveRestaurantId(req);
}

const generateAndAttachTableQR = async (table, restaurant) => {
  const nextVersion = Number(table.qrTokenVersion || 0) + 1;
  const { qrCode, qrToken, qrTokenHash, qrIssuedAt, qrExpiresAt, qrUrl } = await generateTableQR({
    restaurantSlug: restaurant.slug,
    restaurantId: table.restaurantId || table.restaurant,
    branchId: table.branchId,
    tableId: table._id,
    tableNumber: table.tableNumber,
    version: nextVersion,
  });

  table.qrCode = qrCode;
  table.qrToken = qrToken;
  table.qrTokenHash = qrTokenHash;
  table.qrTokenVersion = nextVersion;
  table.qrIssuedAt = qrIssuedAt;
  table.qrExpiresAt = qrExpiresAt;
  table.qrLastRegeneratedAt = new Date();

  return { qrCode, qrToken, qrUrl };
};

const resolveEffectiveLimit = (restaurant, key) => {
  const savedLimit = Number(restaurant?.planLimits?.[key] ?? 0);
  if (savedLimit > 0) return savedLimit;
  const planLimit = Number(restaurant?.currentPlan?.limits?.[key] ?? 0);
  return planLimit > 0 ? planLimit : 0;
};

/**
 * @desc    Get all tables
 * @route   GET /api/restaurant/tables
 * @access  Private
 */
const getTables = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  if (!restaurantId) return error(res, 'Unable to resolve restaurant', 403);
  const includePos = String(req.query.includePos || '').toLowerCase() === 'true';
  const filter = {
    restaurant: restaurantId,
    branchId: req.branchId,
    isDeleted: false,
  };
  // Virtual POS channels (takeaway/delivery) — not physical QR tables
  if (!includePos) {
    filter.allowsConcurrentOrders = { $ne: true };
  }
  const tables = await Table.find(filter).sort({ tableNumber: 1 });

  return success(res, tables, 'Tables retrieved');
});

/**
 * @desc    Get single table
 * @route   GET /api/restaurant/tables/:id
 * @access  Private
 */
const getTableById = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  if (!restaurantId) return error(res, 'Unable to resolve restaurant', 403);
  const table = await Table.findOne({
    _id: req.params.id,
    restaurant: restaurantId,
    branchId: req.branchId,
    isDeleted: false
  });
  
  if (!table) {
    return error(res, 'Table not found', 404);
  }
  
  return success(res, table, 'Table retrieved');
});

/**
 * @desc    Create table
 * @route   POST /api/restaurant/tables
 * @access  Private
 */
const createTable = asyncHandler(async (req, res) => {
  const { tableNumber, capacity, tableType, floor, area, floorPosition } = req.body;
  const restaurantId = restaurantIdFromReq(req);
  if (!restaurantId) return error(res, 'Unable to resolve restaurant', 403);

  if (!tableNumber) {
    return error(res, 'Table number is required', 400);
  }
  
  const existing = await Table.findOne({
    restaurant: restaurantId,
    branchId: req.branchId,
    tableNumber,
    isDeleted: false
  });
  
  if (existing) {
    return error(res, 'Table number already exists', 409);
  }
  
  const restaurant = await Restaurant.findById(restaurantId)
    .populate('currentPlan', 'limits');
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }

  const deletedTable = await Table.findOne({
    restaurant: restaurantId,
    branchId: req.branchId,
    tableNumber,
    isDeleted: true
  });

  if (deletedTable) {
    deletedTable.capacity = capacity || deletedTable.capacity || 4;
    deletedTable.tableType = tableType || deletedTable.tableType || 'regular';
    deletedTable.floor = floor || deletedTable.floor || 'ground';
    deletedTable.area = area || deletedTable.area || '';
    if (floorPosition && typeof floorPosition === 'object') {
      deletedTable.floorPosition = {
        x: Number(floorPosition.x || 0),
        y: Number(floorPosition.y || 0),
      };
    }
    deletedTable.restaurantId = deletedTable.restaurantId || deletedTable.restaurant;
    deletedTable.isDeleted = false;
    deletedTable.isActive = true;
    const { qrUrl } = await generateAndAttachTableQR(deletedTable, restaurant);

    await deletedTable.save();

    return success(res, { ...deletedTable.toObject(), qrUrl }, 'Table restored', 201);
  }

  const maxTables = resolveEffectiveLimit(restaurant, 'maxTables');
  if (maxTables > 0) {
    const currentTables = await Table.countDocuments({
      restaurant: restaurantId,
      branchId: req.branchId,
      isDeleted: false
    });
    if (currentTables >= maxTables) {
      return error(
        res,
        `Plan limit reached: maximum ${maxTables} tables allowed`,
        403,
        { code: 'PLAN_LIMIT_TABLES', maxAllowed: maxTables, currentCount: currentTables }
      );
    }
  }
  
  const table = await Table.create({
    restaurant: restaurantId,
    restaurantId,
    branchId: req.branchId,
    tableNumber,
    capacity: capacity || 4,
    tableType: tableType || 'regular',
    floor: floor || 'ground',
    area: area || '',
    floorPosition: floorPosition && typeof floorPosition === 'object'
      ? { x: Number(floorPosition.x || 0), y: Number(floorPosition.y || 0) }
      : { x: 0, y: 0 },
    isActive: true
  });
  const { qrUrl } = await generateAndAttachTableQR(table, restaurant);
  await table.save();
  
  return success(res, { ...table.toObject(), qrUrl }, 'Table created', 201);
});

/**
 * @desc    Update table
 * @route   PUT /api/restaurant/tables/:id
 * @access  Private
 */
const updateTable = asyncHandler(async (req, res) => {
  const { tableNumber, capacity, isActive, tableType, floor, area, floorPosition, posStatus, guestCount } = req.body;
  const restaurantId = restaurantIdFromReq(req);
  if (!restaurantId) return error(res, 'Unable to resolve restaurant', 403);

  const table = await Table.findOne({
    _id: req.params.id,
    restaurant: restaurantId,
    branchId: req.branchId,
    isDeleted: false
  });
  
  if (!table) {
    return error(res, 'Table not found', 404);
  }
  
  if (tableNumber && tableNumber !== table.tableNumber) {
    const existing = await Table.findOne({
      restaurant: restaurantId,
      branchId: req.branchId,
      tableNumber,
      isDeleted: false,
      _id: { $ne: table._id }
    });
    if (existing) {
      return error(res, 'Table number already exists', 409);
    }
    table.tableNumber = tableNumber;
  }
  
  if (capacity) table.capacity = capacity;
  if (tableType) table.tableType = tableType;
  if (floor) table.floor = floor;
  if (area != null) table.area = String(area || '');
  if (floorPosition && typeof floorPosition === 'object') {
    table.floorPosition = {
      x: Number(floorPosition.x || 0),
      y: Number(floorPosition.y || 0),
    };
  }
  if (posStatus && ['available', 'occupied', 'reserved', 'billing', 'cleaning'].includes(posStatus)) {
    table.posStatus = posStatus;
  }
  if (guestCount != null) table.guestCount = Math.max(0, Number(guestCount || 0));
  if (typeof isActive === 'boolean') table.isActive = isActive;
  
  await table.save();
  emitPosTableUpdated(String(restaurantId), table);
  
  return success(res, table, 'Table updated');
});

const activeOrderStatuses = ['pending', 'confirmed', 'preparing', 'cooking', 'ready'];

const findScopedTable = async (req, id) => {
  const restaurantId = restaurantIdFromReq(req);
  if (!restaurantId) return null;
  return Table.findOne({
    _id: id,
    restaurant: restaurantId,
    branchId: req.branchId,
    isDeleted: false,
  });
};

const findActiveOrderForTable = (req, tableId) =>
  CustomerOrder.findOne({
    restaurant: restaurantIdFromReq(req),
    branchId: req.branchId,
    table: tableId,
    status: { $in: activeOrderStatuses },
    isActive: true,
  });

const moveTableOrder = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  if (!restaurantId) return error(res, 'Unable to resolve restaurant', 403);
  const { targetTableId } = req.body;
  if (!targetTableId) return error(res, 'Target table is required', 400);

  const sourceTable = await findScopedTable(req, req.params.id);
  const targetTable = await findScopedTable(req, targetTableId);
  if (!sourceTable || !targetTable) return error(res, 'Source or target table not found', 404);
  if (String(sourceTable._id) === String(targetTable._id)) return error(res, 'Choose a different target table', 400);

  const sourceOrder = await findActiveOrderForTable(req, sourceTable._id);
  if (!sourceOrder) return error(res, 'Source table has no active order', 400);
  const targetOrder = await findActiveOrderForTable(req, targetTable._id);
  if (targetOrder) return error(res, 'Target table already has an active order. Use merge instead.', 400);

  sourceOrder.table = targetTable._id;
  sourceOrder.statusHistory.push({
    status: sourceOrder.status,
    timestamp: new Date(),
    updatedBy: req.user.employeeId || req.user.id,
    note: `Order moved from Table ${sourceTable.tableNumber} to Table ${targetTable.tableNumber}`,
  });
  await sourceOrder.save();

  sourceTable.posStatus = 'available';
  sourceTable.currentCustomerOrder = null;
  sourceTable.guestCount = 0;
  targetTable.posStatus = 'occupied';
  targetTable.currentCustomerOrder = sourceOrder._id;
  targetTable.guestCount = sourceTable.guestCount || targetTable.guestCount || 0;
  await Promise.all([sourceTable.save(), targetTable.save()]);

  emitPosTableUpdated(String(restaurantId), sourceTable);
  emitPosTableUpdated(String(restaurantId), targetTable);
  emitOrderUpdate(String(restaurantId), sourceOrder);

  return success(res, { order: sourceOrder, sourceTable, targetTable }, 'Order moved to target table');
});

const mergeTableOrder = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  if (!restaurantId) return error(res, 'Unable to resolve restaurant', 403);
  const { targetTableId } = req.body;
  if (!targetTableId) return error(res, 'Target table is required', 400);

  const sourceTable = await findScopedTable(req, req.params.id);
  const targetTable = await findScopedTable(req, targetTableId);
  if (!sourceTable || !targetTable) return error(res, 'Source or target table not found', 404);
  if (String(sourceTable._id) === String(targetTable._id)) return error(res, 'Choose a different target table', 400);

  const sourceOrder = await findActiveOrderForTable(req, sourceTable._id);
  if (!sourceOrder) return error(res, 'Source table has no active order', 400);
  let targetOrder = await findActiveOrderForTable(req, targetTable._id);

  if (!targetOrder) {
    req.body.targetTableId = targetTable._id;
    return moveTableOrder(req, res);
  }

  targetOrder.items.push(...sourceOrder.items.map((item) => item.toObject()));
  targetOrder.totalAmount = Number(targetOrder.totalAmount || 0) + Number(sourceOrder.totalAmount || 0);
  targetOrder.taxAmount = Number(targetOrder.taxAmount || 0) + Number(sourceOrder.taxAmount || 0);
  targetOrder.discountAmount = Number(targetOrder.discountAmount || 0) + Number(sourceOrder.discountAmount || 0);
  targetOrder.grandTotal = Number(targetOrder.grandTotal || 0) + Number(sourceOrder.grandTotal || 0);
  targetOrder.specialRequests = [targetOrder.specialRequests, sourceOrder.specialRequests]
    .filter(Boolean)
    .join('\n');
  targetOrder.statusHistory.push({
    status: targetOrder.status,
    timestamp: new Date(),
    updatedBy: req.user.employeeId || req.user.id,
    note: `Merged order ${sourceOrder.orderNumber} from Table ${sourceTable.tableNumber}`,
  });

  sourceOrder.isActive = false;
  sourceOrder.status = 'cancelled';
  sourceOrder.statusHistory.push({
    status: 'cancelled',
    timestamp: new Date(),
    updatedBy: req.user.employeeId || req.user.id,
    note: `Merged into order ${targetOrder.orderNumber} at Table ${targetTable.tableNumber}`,
  });

  sourceTable.posStatus = 'available';
  sourceTable.currentCustomerOrder = null;
  targetTable.posStatus = 'occupied';
  targetTable.currentCustomerOrder = targetOrder._id;
  targetTable.guestCount = Number(targetTable.guestCount || 0) + Number(sourceTable.guestCount || 0);
  sourceTable.guestCount = 0;

  await Promise.all([targetOrder.save(), sourceOrder.save(), sourceTable.save(), targetTable.save()]);
  emitPosTableUpdated(String(restaurantId), sourceTable);
  emitPosTableUpdated(String(restaurantId), targetTable);
  emitOrderUpdate(String(restaurantId), targetOrder);
  emitOrderUpdate(String(restaurantId), sourceOrder);

  return success(res, { order: targetOrder, mergedOrder: sourceOrder, sourceTable, targetTable }, 'Tables merged');
});

/**
 * @desc    Delete table (soft delete)
 * @route   DELETE /api/restaurant/tables/:id
 * @access  Private
 */
const deleteTable = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  if (!restaurantId) return error(res, 'Unable to resolve restaurant', 403);

  const table = await Table.findOne({
    _id: req.params.id,
    restaurant: restaurantId,
    branchId: req.branchId,
    isDeleted: false
  });
  
  if (!table) {
    return error(res, 'Table not found', 404);
  }

  if (table.allowsConcurrentOrders) {
    return error(res, 'POS channel tables cannot be deleted from here', 400);
  }

  table.isDeleted = true;
  await table.save();

  return success(res, null, 'Table deleted');
});

/**
 * @desc    Regenerate QR code
 * @route   PATCH /api/restaurant/tables/:id/regenerate-qr
 * @access  Private
 */
const regenerateQR = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  if (!restaurantId) return error(res, 'Unable to resolve restaurant', 403);

  const table = await Table.findOne({
    _id: req.params.id,
    restaurant: restaurantId,
    branchId: req.branchId,
    isDeleted: false
  });
  
  if (!table) {
    return error(res, 'Table not found', 404);
  }
  
  const restaurant = await Restaurant.findById(restaurantId);
  if (!restaurant) {
    return error(res, 'Restaurant not found', 404);
  }
  
  const { qrCode, qrUrl } = await generateAndAttachTableQR(table, restaurant);
  await table.save();
  
  return success(res, { qrCode, qrUrl }, 'QR code regenerated');
});

/**
 * @desc    Get table by QR token
 * @route   GET /api/restaurant/tables/qr/:token
 * @access  Public
 */
const getTableByQRToken = asyncHandler(async (req, res) => {
  const { token } = req.params;
  
  const table = await resolveTableFromQrToken(token, { populateRestaurant: true });
  
  if (!table) {
    return error(res, 'Invalid QR code', 404);
  }
  
  if (!table.restaurant.isActive) {
    return error(res, 'Restaurant is currently inactive', 403);
  }
  
  return success(res, {
    restaurantId: table.restaurant._id,
    branchId: table.branchId,
    restaurantName: table.restaurant.name,
    restaurantSlug: table.restaurant.slug,
    restaurantLogo: table.restaurant.logo,
    favicon: table.restaurant.favicon,
    backgroundPhoto: table.restaurant.backgroundPhoto,
    brandBackgroundImage: table.restaurant.brandBackgroundImage,
    currency: table.restaurant?.settings?.currency || 'Rs.',
    themeSettings: table.restaurant?.settings?.themeSettings || {},
    tableId: table._id,
    tableNumber: table.tableNumber
  }, 'Table verified');
});

module.exports = {
  getTables,
  getTableById,
  createTable,
  updateTable,
  deleteTable,
  moveTableOrder,
  mergeTableOrder,
  regenerateQR,
  getTableByQRToken
};
