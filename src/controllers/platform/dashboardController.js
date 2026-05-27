const asyncHandler = require('express-async-handler');
const Restaurant = require('../../models/restaurant/Restaurant');
const KYC = require('../../models/restaurant/KYC');
const Platform = require('../../models/platform/Platform');
const Invoice = require('../../models/shared/SubscriptionInvoice');
const { success } = require('../../utils/apiResponse');

/**
 * @desc    Get platform dashboard statistics
 * @route   GET /api/platform/dashboard/stats
 * @access  Private (Admin)
 */
const getDashboardStats = asyncHandler(async (req, res) => {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  
  const [
    totalRestaurants,
    activeRestaurants,
    pendingKYCs,
    totalRevenue,
    todayRevenue,
    monthRevenue,
    activeSubscriptions,
    platformAdmins
  ] = await Promise.all([
    Restaurant.countDocuments({ isDeleted: false }),
    Restaurant.countDocuments({ isActive: true, isDeleted: false }),
    KYC.countDocuments({ status: 'pending' }),
    Invoice.aggregate([{ $group: { _id: null, total: { $sum: '$totalInclVat' } } }]).then(r => r[0]?.total || 0),
    Invoice.aggregate([{ $match: { issuedAt: { $gte: startOfToday } } }, { $group: { _id: null, total: { $sum: '$totalInclVat' } } }]).then(r => r[0]?.total || 0),
    Invoice.aggregate([{ $match: { issuedAt: { $gte: startOfMonth } } }, { $group: { _id: null, total: { $sum: '$totalInclVat' } } }]).then(r => r[0]?.total || 0),
    Restaurant.countDocuments({ currentPlan: { $ne: null }, planEndDate: { $gt: now }, isActive: true }),
    Platform.countDocuments({ isActive: true })
  ]);
  
  // Plan distribution
  const planDistribution = await Restaurant.aggregate([
    { $match: { currentPlan: { $ne: null } } },
    { $group: { _id: '$currentPlan', count: { $sum: 1 } } },
    { $lookup: { from: 'subscriptions', localField: '_id', foreignField: '_id', as: 'plan' } },
    { $unwind: '$plan' },
    { $project: { name: '$plan.name', count: 1 } }
  ]);
  
  return success(res, {
    overview: {
      totalRestaurants,
      activeRestaurants,
      pendingKYCs,
      platformAdmins
    },
    revenue: {
      total: totalRevenue,
      today: todayRevenue,
      thisMonth: monthRevenue
    },
    subscriptions: {
      active: activeSubscriptions,
      planDistribution
    }
  }, 'Dashboard statistics retrieved');
});

/**
 * @desc    Get revenue analytics
 * @route   GET /api/platform/dashboard/analytics/revenue
 * @access  Private (Admin)
 */
const getRevenueAnalytics = asyncHandler(async (req, res) => {
  const { period = 'monthly', year = new Date().getFullYear() } = req.query;
  
  let dateRange = { $gte: new Date(`${year}-01-01`), $lt: new Date(`${parseInt(year) + 1}-01-01`) };
  
  const data = await Invoice.aggregate([
    { $match: { issuedAt: dateRange } },
    {
      $group: {
        _id: {
          $dateToString: {
            format: period === 'daily' ? '%Y-%m-%d' : '%Y-%m',
            date: '$issuedAt'
          }
        },
        revenue: { $sum: '$totalInclVat' },
        invoiceCount: { $sum: 1 },
        avgInvoiceValue: { $avg: '$totalInclVat' }
      }
    },
    { $sort: { '_id': 1 } }
  ]);
  
  return success(res, { period, year: parseInt(year), data }, 'Revenue analytics retrieved');
});

/**
 * @desc    Get restaurant growth
 * @route   GET /api/platform/dashboard/analytics/restaurants
 * @access  Private (Admin)
 */
const getRestaurantGrowth = asyncHandler(async (req, res) => {
  const growth = await Restaurant.aggregate([
    { $match: { isDeleted: false } },
    { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } }, count: { $sum: 1 } } },
    { $sort: { '_id': 1 } }
  ]);
  
  return success(res, growth, 'Restaurant growth retrieved');
});

/**
 * @desc    Get subscription analytics
 * @route   GET /api/platform/dashboard/analytics/subscriptions
 * @access  Private (Admin)
 */
const getSubscriptionAnalytics = asyncHandler(async (req, res) => {
  const planDistribution = await Restaurant.aggregate([
    { $match: { currentPlan: { $ne: null } } },
    { $group: { _id: '$currentPlan', count: { $sum: 1 } } },
    { $lookup: { from: 'subscriptions', localField: '_id', foreignField: '_id', as: 'plan' } },
    { $unwind: '$plan' },
    { $project: { name: '$plan.name', planType: '$plan.planType', price: '$plan.price', count: 1 } }
  ]);
  
  return success(res, planDistribution, 'Subscription analytics retrieved');
});

/** UTC calendar dates YYYY-MM-DD for the last `count` days ending today (UTC). */
function utcDayKeysRolling(count = 7) {
  const keys = [];
  const now = new Date();
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

/**
 * @desc    Last 7 days — daily revenue / invoices / new tenant signups for platform dashboard charts
 * @route   GET /api/platform/dashboard/analytics/trend-7d
 * @access  Private (Admin)
 */
const getSevenDayTrend = asyncHandler(async (req, res) => {
  const keys = utcDayKeysRolling(7);
  const rangeStart = new Date(`${keys[0]}T00:00:00.000Z`);
  const rangeEnd = new Date(`${keys[keys.length - 1]}T23:59:59.999Z`);

  const [invAgg, signupAgg] = await Promise.all([
    Invoice.aggregate([
      {
        $match: {
          issuedAt: { $gte: rangeStart, $lte: rangeEnd },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$issuedAt' },
          },
          revenue: { $sum: '$totalInclVat' },
          invoices: { $sum: 1 },
        },
      },
    ]),
    Restaurant.aggregate([
      {
        $match: {
          isDeleted: false,
          createdAt: { $gte: rangeStart, $lte: rangeEnd },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
          },
          newRestaurants: { $sum: 1 },
        },
      },
    ]),
  ]);

  const invMap = {};
  invAgg.forEach((r) => {
    invMap[r._id] = { revenue: Number(r.revenue || 0), invoices: Number(r.invoices || 0) };
  });
  const regMap = {};
  signupAgg.forEach((r) => {
    regMap[r._id] = Number(r.newRestaurants || 0);
  });

  const data = keys.map((dateKey) => {
    const inv = invMap[dateKey] || { revenue: 0, invoices: 0 };
    return {
      date: dateKey,
      revenue: inv.revenue,
      invoices: inv.invoices,
      newRestaurants: regMap[dateKey] || 0,
    };
  });

  return success(res, { days: keys.length, data }, 'Seven-day dashboard trend retrieved');
});

module.exports = {
  getDashboardStats,
  getRevenueAnalytics,
  getRestaurantGrowth,
  getSubscriptionAnalytics,
  getSevenDayTrend,
};