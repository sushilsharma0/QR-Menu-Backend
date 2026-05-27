const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const CustomerOrder = require('../../models/restaurant/CustomerOrder');
const Table = require('../../models/restaurant/Table');
const Employee = require('../../models/restaurant/Employee');
const InventoryItem = require('../../models/restaurant/InventoryItem');
const { success, error } = require('../../utils/apiResponse');
const { addFieldsPaymentMethodBucket } = require('../../utils/paymentMethodAggregation');

function restaurantIdFromReq(req) {
  return req.restaurantId || req.user?.restaurantId || req.user?.id;
}

function asObjectId(value) {
  return mongoose.Types.ObjectId.isValid(String(value)) ? new mongoose.Types.ObjectId(String(value)) : value;
}

const orderRevenueSum = async (restaurantId, branchId, dateFilter = {}) => {
  const rows = await CustomerOrder.aggregate([
    {
      $match: {
        restaurant: asObjectId(restaurantId),
        branchId: asObjectId(branchId),
        paymentStatus: 'paid',
        isActive: { $ne: false },
        ...dateFilter,
      },
    },
    { $group: { _id: null, total: { $sum: '$grandTotal' } } },
  ]);
  return rows[0]?.total || 0;
};

const pctChange = (current, previous) => {
  if (previous > 0) return ((current - previous) / previous) * 100;
  if (current > 0) return null;
  return 0;
};

/**
 * @desc    Get restaurant dashboard statistics
 * @route   GET /api/restaurant/dashboard/stats
 * @access  Private
 */
const getDashboardStats = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  if (!restaurantId || !req.branchId) return error(res, 'Unable to resolve branch dashboard scope', 403);
  const rid = asObjectId(restaurantId);
  const branchId = req.branchId;
  const branchObjectId = asObjectId(branchId);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const endOfYesterday = new Date(startOfToday.getTime() - 1);

  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const startOfPrevWeek = new Date(startOfWeek);
  startOfPrevWeek.setDate(startOfPrevWeek.getDate() - 7);
  const endOfPrevWeek = new Date(startOfWeek.getTime() - 1);

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLast30Days = new Date(now);
  startOfLast30Days.setDate(startOfLast30Days.getDate() - 30);
  
  const [
    todayOrders,
    weekOrders,
    monthOrders,
    totalOrders,
    todayRevenue,
    yesterdayRevenue,
    weekRevenue,
    previousWeekRevenue,
    monthRevenue,
    totalRevenue,
    pendingOrders,
    preparingOrders,
    readyOrders,
    totalTables,
    activeTables,
    totalEmployees,
    lowStockItems,
    popularItems
  ] = await Promise.all([
    CustomerOrder.countDocuments({ restaurant: restaurantId, branchId, isActive: { $ne: false }, createdAt: { $gte: startOfToday } }),
    CustomerOrder.countDocuments({ restaurant: restaurantId, branchId, isActive: { $ne: false }, createdAt: { $gte: startOfWeek } }),
    CustomerOrder.countDocuments({ restaurant: restaurantId, branchId, isActive: { $ne: false }, createdAt: { $gte: startOfMonth } }),
    CustomerOrder.countDocuments({ restaurant: restaurantId, branchId, isActive: { $ne: false } }),
    orderRevenueSum(restaurantId, branchId, { createdAt: { $gte: startOfToday, $lte: now } }),
    orderRevenueSum(restaurantId, branchId, { createdAt: { $gte: startOfYesterday, $lte: endOfYesterday } }),
    orderRevenueSum(restaurantId, branchId, { createdAt: { $gte: startOfWeek, $lte: now } }),
    orderRevenueSum(restaurantId, branchId, { createdAt: { $gte: startOfPrevWeek, $lte: endOfPrevWeek } }),
    orderRevenueSum(restaurantId, branchId, { createdAt: { $gte: startOfMonth, $lte: now } }),
    orderRevenueSum(restaurantId, branchId, {}),
    CustomerOrder.countDocuments({ restaurant: restaurantId, branchId, isActive: { $ne: false }, status: 'pending' }),
    CustomerOrder.countDocuments({ restaurant: restaurantId, branchId, isActive: { $ne: false }, status: 'preparing' }),
    CustomerOrder.countDocuments({ restaurant: restaurantId, branchId, isActive: { $ne: false }, status: 'ready' }),
    Table.countDocuments({ restaurant: restaurantId, branchId, isDeleted: false }),
    Table.countDocuments({ restaurant: restaurantId, branchId, isActive: { $ne: false }, isDeleted: false }),
    Employee.countDocuments({ restaurant: restaurantId, branchId, isActive: { $ne: false } }),
    InventoryItem.find({
      restaurantId,
      branchId,
      isDeleted: false,
      $expr: { $lte: ['$quantity', '$minimumStock'] },
    }).limit(5).lean(),
    CustomerOrder.aggregate([
      { $match: { restaurant: rid, branchId: branchObjectId, isActive: { $ne: false }, createdAt: { $gte: startOfMonth } } },
      { $unwind: '$items' },
      { $group: { _id: '$items.name', totalQuantity: { $sum: '$items.quantity' }, totalRevenue: { $sum: { $multiply: ['$items.quantity', '$items.price'] } } } },
      { $sort: { totalQuantity: -1 } },
      { $limit: 5 }
    ])
  ]);

  const todayVsYesterdayPercent = pctChange(todayRevenue, yesterdayRevenue);
  const weekVsPrevWeekPercent = pctChange(weekRevenue, previousWeekRevenue);
  
  // Recent orders
  const recentOrders = await CustomerOrder.find({ restaurant: restaurantId, branchId, isActive: { $ne: false } })
    .populate('table', 'tableNumber')
    .sort({ createdAt: -1 })
    .limit(10);
  
  // Order status distribution
  const statusDistribution = await CustomerOrder.aggregate([
    { $match: { restaurant: rid, branchId: branchObjectId, isActive: { $ne: false } } },
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]);

  const [
    paymentStatusDistribution,
    orderChannelDistribution,
    paymentMethodRevenue,
    hourlyOrderFlow,
    tableActivity
  ] = await Promise.all([
    CustomerOrder.aggregate([
      { $match: { restaurant: rid, branchId: branchObjectId, isActive: { $ne: false } } },
      { $group: { _id: '$paymentStatus', count: { $sum: 1 }, amount: { $sum: '$grandTotal' } } },
      { $sort: { count: -1 } }
    ]),
    CustomerOrder.aggregate([
      { $match: { restaurant: rid, branchId: branchObjectId, isActive: { $ne: false }, createdAt: { $gte: startOfLast30Days, $lte: now } } },
      { $group: { _id: { $ifNull: ['$orderChannel', 'unknown'] }, count: { $sum: 1 }, revenue: { $sum: '$grandTotal' } } },
      { $sort: { count: -1 } }
    ]),
    CustomerOrder.aggregate([
      { $match: { restaurant: rid, branchId: branchObjectId, isActive: { $ne: false }, paymentStatus: 'paid', createdAt: { $gte: startOfMonth, $lte: now } } },
      addFieldsPaymentMethodBucket('$paymentMethod', '_paymentMethodBucket'),
      { $group: { _id: '$_paymentMethodBucket', count: { $sum: 1 }, revenue: { $sum: '$grandTotal' } } },
      { $sort: { revenue: -1 } }
    ]),
    CustomerOrder.aggregate([
      { $match: { restaurant: rid, branchId: branchObjectId, isActive: { $ne: false }, createdAt: { $gte: startOfToday, $lte: now } } },
      {
        $group: {
          _id: { $dateToString: { format: '%H:00', date: '$createdAt', timezone: '+05:45' } },
          orders: { $sum: 1 },
          revenue: { $sum: '$grandTotal' }
        }
      },
      { $sort: { _id: 1 } }
    ]),
    CustomerOrder.aggregate([
      { $match: { restaurant: rid, branchId: branchObjectId, isActive: { $ne: false }, createdAt: { $gte: startOfLast30Days, $lte: now } } },
      { $group: { _id: '$table', orders: { $sum: 1 }, revenue: { $sum: '$grandTotal' } } },
      { $sort: { orders: -1 } },
      { $limit: 8 },
      { $lookup: { from: 'tables', localField: '_id', foreignField: '_id', as: 'table' } },
      { $unwind: { path: '$table', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          tableNumber: { $ifNull: ['$table.tableNumber', 'N/A'] },
          orders: 1,
          revenue: 1
        }
      }
    ])
  ]);
  
  return success(res, {
    overview: {
      todayOrders,
      weekOrders,
      monthOrders,
      totalOrders,
      todayRevenue,
      yesterdayRevenue,
      todayVsYesterdayPercent,
      weekRevenue,
      previousWeekRevenue,
      weekVsPrevWeekPercent,
      monthRevenue,
      totalRevenue
    },
    activeOrders: {
      pending: pendingOrders,
      preparing: preparingOrders,
      ready: readyOrders
    },
    resources: {
      totalTables,
      activeTables,
      totalEmployees,
      lowStockCount: lowStockItems.length
    },
    popularItems,
    lowStockItems,
    recentOrders,
    statusDistribution,
    paymentStatusDistribution,
    orderChannelDistribution,
    paymentMethodRevenue,
    hourlyOrderFlow,
    tableActivity
  }, 'Dashboard statistics retrieved');
});

/**
 * @desc    Get sales analytics
 * @route   GET /api/restaurant/dashboard/analytics/sales
 * @access  Private
 */
const getSalesAnalytics = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  if (!restaurantId || !req.branchId) return error(res, 'Unable to resolve branch dashboard scope', 403);
  const { period = 'daily', days = 7 } = req.query;
  
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - parseInt(days));
  
  let groupBy;
  switch (period) {
    case 'hourly':
      groupBy = { $dateToString: { format: '%Y-%m-%d %H:00', date: '$createdAt' } };
      break;
    case 'daily':
    default:
      groupBy = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };
      break;
  }

  const rid = asObjectId(restaurantId);
  const branchObjectId = asObjectId(req.branchId);
  
  const analytics = await CustomerOrder.aggregate([
    {
      $match: {
        restaurant: rid,
        branchId: branchObjectId,
        isActive: { $ne: false },
        paymentStatus: 'paid',
        createdAt: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: groupBy,
        orders: { $sum: 1 },
        revenue: { $sum: '$grandTotal' },
        avgOrderValue: { $avg: '$grandTotal' }
      }
    },
    { $sort: { '_id': 1 } }
  ]);
  
  return success(res, { period, days: parseInt(days), data: analytics }, 'Sales analytics retrieved');
});

/**
 * @desc    Get popular items
 * @route   GET /api/restaurant/dashboard/analytics/popular-items
 * @access  Private
 */
const getPopularItems = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  if (!restaurantId || !req.branchId) return error(res, 'Unable to resolve branch dashboard scope', 403);
  const { days = 30, limit = 10 } = req.query;
  
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - parseInt(days));
  
  const rid = asObjectId(restaurantId);
  const branchObjectId = asObjectId(req.branchId);

  const popularItems = await CustomerOrder.aggregate([
    { $match: { restaurant: rid, branchId: branchObjectId, isActive: { $ne: false }, createdAt: { $gte: startDate } } },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.menuItem',
        name: { $first: '$items.name' },
        totalQuantity: { $sum: '$items.quantity' },
        totalRevenue: { $sum: { $multiply: ['$items.quantity', '$items.price'] } }
      }
    },
    { $sort: { totalQuantity: -1 } },
    { $limit: parseInt(limit) }
  ]);
  
  return success(res, popularItems, 'Popular items retrieved');
});

/**
 * @desc    Get order status statistics
 * @route   GET /api/restaurant/dashboard/analytics/order-status
 * @access  Private
 */
const getOrderStatusStats = asyncHandler(async (req, res) => {
  const restaurantId = restaurantIdFromReq(req);
  if (!restaurantId || !req.branchId) return error(res, 'Unable to resolve branch dashboard scope', 403);
  const rid = asObjectId(restaurantId);
  const branchObjectId = asObjectId(req.branchId);
  
  const stats = await CustomerOrder.aggregate([
    { $match: { restaurant: rid, branchId: branchObjectId, isActive: { $ne: false } } },
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]);
  
  const result = {
    pending: 0,
    confirmed: 0,
    preparing: 0,
    ready: 0,
    served: 0,
    cancelled: 0
  };
  
  stats.forEach(stat => {
    result[stat._id] = stat.count;
  });
  
  return success(res, result, 'Order status statistics retrieved');
});

module.exports = {
  getDashboardStats,
  getSalesAnalytics,
  getPopularItems,
  getOrderStatusStats
};
