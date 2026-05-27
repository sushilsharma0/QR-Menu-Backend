const SalesReport = require('../models/restaurant/SalesReport');
const TransactionLog = require('../models/restaurant/TransactionLog');
const CustomerOrder = require('../models/restaurant/CustomerOrder');
const MenuItem = require('../models/restaurant/MenuItem');

function orderIsReportable(order) {
  return order?.paymentStatus === 'paid' || order?.status === 'completed';
}

async function buildCategoryBreakdown(order) {
  const categoryBreakdown = [];
  const restaurantId = order.restaurant || order.restaurantId;
  const branchId = order.branchId || null;

  for (const item of order.items || []) {
    if (!item.menuItem) continue;
    const menuItem = await MenuItem.findOne({
      _id: item.menuItem,
      restaurant: restaurantId,
      branchId,
      isDeleted: false,
    }).select('category').populate('category', 'name');
    const categoryName = menuItem?.category?.name || 'Uncategorized';
    const amount = Number(item.price || 0) * Number(item.quantity || 0);
    const found = categoryBreakdown.find((x) => x.categoryName === categoryName);
    if (found) found.amount += amount;
    else categoryBreakdown.push({ categoryName, amount });
  }

  return categoryBreakdown;
}

/**
 * Collapse duplicate SalesReport rows for the same order (legacy races).
 * Use after a $match on SalesReport.
 */
function buildSalesReportDedupePipeline() {
  return [
    { $sort: { updatedAt: -1 } },
    { $group: { _id: '$orderId', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } },
  ];
}

async function ensureSalesReportForOrder(order) {
  if (!order || !orderIsReportable(order)) return null;

  const restaurantId = order.restaurant || order.restaurantId;
  const branchId = order.branchId || null;

  const categoryBreakdown = await buildCategoryBreakdown(order);
  const soldAt = order.updatedAt || order.createdAt || new Date();
  const totalRevenue = Number(order.grandTotal || 0);
  const netRevenue = Number(order.totalAmount || order.grandTotal || 0);
  const taxAmount = Number(order.taxAmount || 0);

  const report = await SalesReport.findOneAndUpdate(
    { restaurantId, branchId, orderId: order._id },
    {
      $setOnInsert: {
        restaurantId,
        branchId,
        orderNumber: order.orderNumber || '',
        totalRevenue,
        netRevenue,
        taxAmount,
        refundAmount: 0,
        paymentMethod: order.paymentMethod || 'cash',
        orderChannel: order.orderChannel || 'qr_ordering',
        itemCount: (order.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0),
        categoryBreakdown,
        soldAt,
      },
    },
    { upsert: true, new: true },
  );

  const existingLog = await TransactionLog.findOne({ restaurantId, branchId, orderId: order._id }).select('_id');
  if (!existingLog) {
    try {
      await TransactionLog.create({
        restaurantId,
        branchId,
        orderId: order._id,
        transactionId: `AUTO-${order.orderNumber || order._id}`,
        amount: totalRevenue,
        paymentMethod: order.paymentMethod || 'cash',
        status: 'success',
        taxAmount,
        refundAmount: 0,
        loggedAt: soldAt,
      });
    } catch (e) {
      if (!e || e.code !== 11000) throw e;
    }
  }

  return report;
}

async function syncSalesReportsForRestaurant(restaurantId) {
  const orders = await CustomerOrder.find({
    restaurant: restaurantId,
    isActive: true,
    $or: [{ paymentStatus: 'paid' }, { status: 'completed' }],
  }).select(
    'restaurant restaurantId branchId orderNumber grandTotal totalAmount taxAmount paymentMethod items createdAt updatedAt _id orderChannel paymentStatus status',
  );

  let inserted = 0;
  for (const order of orders) {
    const report = await ensureSalesReportForOrder(order);
    if (report?.createdAt && report.createdAt.getTime() === report.updatedAt?.getTime()) inserted += 1;
  }

  return { inserted };
}

module.exports = {
  buildSalesReportDedupePipeline,
  ensureSalesReportForOrder,
  syncSalesReportsForRestaurant,
};
