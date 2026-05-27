const Table = require('../models/restaurant/Table');

const POS_TAKEAWAY = 'POS-TAKEAWAY';
const POS_DELIVERY = 'POS-DELIVERY';

/**
 * Virtual tables for POS modes that are not tied to a single physical table.
 * Multiple concurrent orders allowed.
 */
async function getOrCreateVirtualPosTable(restaurantId, mode, branchId = null) {
  const tableNumber = mode === 'delivery' ? POS_DELIVERY : POS_TAKEAWAY;
  const query = {
    restaurant: restaurantId,
    tableNumber,
    isDeleted: false,
  };
  if (branchId) query.branchId = branchId;
  let table = await Table.findOne(query);
  if (!table) {
    table = await Table.create({
      restaurant: restaurantId,
      restaurantId,
      branchId: branchId || undefined,
      tableNumber,
      capacity: 0,
      isActive: true,
      allowsConcurrentOrders: true,
      posStatus: 'available',
    });
  } else if (!table.allowsConcurrentOrders) {
    table.allowsConcurrentOrders = true;
    await table.save();
  }
  return table;
}

function generatePickupToken() {
  const n = Math.floor(100000 + Math.random() * 900000);
  return `P${n}`;
}

module.exports = {
  getOrCreateVirtualPosTable,
  generatePickupToken,
  POS_TAKEAWAY,
  POS_DELIVERY,
};
