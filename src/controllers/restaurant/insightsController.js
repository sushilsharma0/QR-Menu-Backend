const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Category = require('../../models/restaurant/Category');
const MenuItem = require('../../models/restaurant/MenuItem');
const Table = require('../../models/restaurant/Table');
const Employee = require('../../models/restaurant/Employee');
const Promotion = require('../../models/restaurant/Promotion');
const CustomerOrder = require('../../models/restaurant/CustomerOrder');
const CustomerIdentity = require('../../models/customer/CustomerIdentity');
const Branch = require('../../models/restaurant/Branch');
const Recipe = require('../../models/restaurant/Recipe');
const InventoryItem = require('../../models/restaurant/InventoryItem');
const SalesReport = require('../../models/restaurant/SalesReport');
const { success, error } = require('../../utils/apiResponse');
const resolveRestaurantId = require('../../middleware/restaurant/resolveRestaurantId');

const asObjectId = (id) => {
  if (!id) return null;
  const s = id.toString ? id.toString() : String(id);
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
};

function branchScope(req) {
  const restaurantId = asObjectId(resolveRestaurantId(req));
  const branchId = asObjectId(req.branchId);
  return { restaurantId, branchId };
}

const getSetupChecklist = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = branchScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve branch scope', 403);

  const baseMenu = { restaurant: restaurantId, branchId, isDeleted: false };
  const baseTable = { restaurant: restaurantId, branchId, isDeleted: false };
  const baseOrder = { restaurant: restaurantId, branchId, isActive: { $ne: false } };

  const [
    categoryCount,
    menuItemCount,
    tableCount,
    employeeCount,
    promotionCount,
    orderCount,
    identityCount,
  ] = await Promise.all([
    Category.countDocuments(baseMenu),
    MenuItem.countDocuments(baseMenu),
    Table.countDocuments(baseTable),
    Employee.countDocuments({ restaurant: restaurantId, branchId, isActive: { $ne: false } }),
    Promotion.countDocuments({ restaurant: restaurantId, branchId, isActive: true }),
    CustomerOrder.countDocuments(baseOrder),
    CustomerIdentity.countDocuments({ restaurant: restaurantId, isActive: true }),
  ]);

  const items = [
    {
      id: 'categories',
      label: 'Create menu categories',
      done: categoryCount > 0,
      segment: 'menu',
      detail: categoryCount > 0 ? `${categoryCount} categories` : 'Add at least one category',
    },
    {
      id: 'menuItems',
      label: 'Add menu items',
      done: menuItemCount >= 3,
      segment: 'menu',
      detail: menuItemCount > 0 ? `${menuItemCount} items` : 'Add your dishes and prices',
    },
    {
      id: 'tables',
      label: 'Set up tables & QR codes',
      done: tableCount > 0,
      segment: 'tables',
      detail: tableCount > 0 ? `${tableCount} tables` : 'Create tables and print QR codes',
    },
    {
      id: 'staff',
      label: 'Add staff accounts',
      done: employeeCount > 0,
      segment: 'employees',
      detail: employeeCount > 0 ? `${employeeCount} staff` : 'Kitchen, cashier, or waiter logins',
    },
    {
      id: 'promotion',
      label: 'Create a promotion (optional)',
      done: promotionCount > 0,
      optional: true,
      segment: 'promotions',
      detail: promotionCount > 0 ? `${promotionCount} active` : 'Discount codes or banners',
    },
    {
      id: 'firstOrder',
      label: 'Receive your first order',
      done: orderCount > 0,
      segment: 'orders',
      detail: orderCount > 0 ? `${orderCount} orders` : 'Run a test QR or POS order',
    },
    {
      id: 'customers',
      label: 'Registered customer IDs (optional)',
      done: identityCount > 0,
      optional: true,
      segment: 'customers',
      detail: identityCount > 0 ? `${identityCount} customers` : 'Guests can sign up from the QR portal',
    },
  ];

  const required = items.filter((i) => !i.optional);
  const doneRequired = required.filter((i) => i.done).length;
  const progress = required.length
    ? Math.round((doneRequired / required.length) * 100)
    : 0;

  return success(res, { items, progress, doneRequired, totalRequired: required.length }, 'Setup checklist');
});

const getFoodCostReport = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = branchScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve branch scope', 403);

  const days = Math.min(90, Math.max(7, parseInt(req.query.days, 10) || 30));
  const since = new Date();
  since.setDate(since.getDate() - days);

  const items = await MenuItem.find({
    restaurant: restaurantId,
    branchId,
    isDeleted: false,
  })
    .select('name price category isAvailable')
    .populate('category', 'name')
    .lean();

  const recipes = await Recipe.find({ restaurantId, branchId })
    .populate('ingredients.inventoryItem', 'name costPerUnit unit')
    .lean();

  const recipeByMenu = new Map(recipes.map((r) => [String(r.menuItem), r]));

  const salesAgg = await CustomerOrder.aggregate([
    {
      $match: {
        restaurant: restaurantId,
        branchId,
        isActive: { $ne: false },
        createdAt: { $gte: since },
        status: { $nin: ['cancelled'] },
      },
    },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.menuItem',
        name: { $first: '$items.name' },
        qtySold: { $sum: '$items.quantity' },
        revenue: { $sum: { $multiply: ['$items.quantity', '$items.price'] } },
      },
    },
  ]);

  const salesMap = new Map(salesAgg.map((r) => [String(r._id), r]));

  const rows = items.map((item) => {
    const recipe = recipeByMenu.get(String(item._id));
    let recipeCost = 0;
    if (recipe?.ingredients?.length) {
      recipeCost = recipe.ingredients.reduce((sum, ing) => {
        const cpu = Number(ing.inventoryItem?.costPerUnit || 0);
        return sum + cpu * Number(ing.quantity || 0);
      }, 0);
    }
    const price = Number(item.price || 0);
    const margin = price > 0 ? ((price - recipeCost) / price) * 100 : null;
    const sales = salesMap.get(String(item._id)) || { qtySold: 0, revenue: 0 };
    return {
      menuItemId: item._id,
      name: item.name,
      categoryName: item.category?.name || 'Uncategorized',
      price,
      recipeCost: Number(recipeCost.toFixed(2)),
      marginPercent: margin != null ? Number(margin.toFixed(1)) : null,
      hasRecipe: Boolean(recipe?.ingredients?.length),
      qtySold: sales.qtySold,
      revenue: Number(sales.revenue || 0),
      isAvailable: item.isAvailable !== false,
    };
  });

  rows.sort((a, b) => b.revenue - a.revenue);

  const withRecipe = rows.filter((r) => r.hasRecipe);
  const avgMargin =
    withRecipe.length > 0
      ? withRecipe.reduce((s, r) => s + (r.marginPercent || 0), 0) / withRecipe.length
      : null;

  return success(
    res,
    {
      days,
      summary: {
        itemCount: rows.length,
        itemsWithRecipe: withRecipe.length,
        avgMarginPercent: avgMargin != null ? Number(avgMargin.toFixed(1)) : null,
        totalRevenue: rows.reduce((s, r) => s + r.revenue, 0),
      },
      rows,
    },
    'Food cost report',
  );
});

const compareBranches = asyncHandler(async (req, res) => {
  const restaurantId = asObjectId(resolveRestaurantId(req));
  if (!restaurantId) return error(res, 'Unable to resolve restaurant', 403);

  const days = Math.min(90, Math.max(7, parseInt(req.query.days, 10) || 30));
  const since = new Date();
  since.setDate(since.getDate() - days);

  const branches = await Branch.find({ restaurantId, isDeleted: false })
    .select('name slug isDefault isActive')
    .lean();

  const comparisons = await Promise.all(
    branches.map(async (branch) => {
      const branchId = branch._id;
      const branchFilter = branch.isDefault
        ? { $or: [{ branchId }, { branchId: null }, { branchId: { $exists: false } }] }
        : { branchId };

      const orderMatch = { restaurant: restaurantId, ...branchFilter, createdAt: { $gte: since } };
      const salesMatch = { restaurantId, ...branchFilter, soldAt: { $gte: since } };

      const [orderStats, salesStats, employeeCount, tableCount] = await Promise.all([
        CustomerOrder.aggregate([
          { $match: { ...orderMatch, isActive: { $ne: false }, status: { $nin: ['cancelled'] } } },
          {
            $group: {
              _id: null,
              orders: { $sum: 1 },
              revenue: { $sum: '$grandTotal' },
            },
          },
        ]),
        SalesReport.aggregate([
          { $match: salesMatch },
          { $group: { _id: null, revenue: { $sum: '$totalRevenue' }, netRevenue: { $sum: '$netRevenue' } } },
        ]),
        Employee.countDocuments({ restaurant: restaurantId, ...branchFilter, isActive: { $ne: false } }),
        Table.countDocuments({ restaurant: restaurantId, ...branchFilter, isDeleted: false }),
      ]);

      const o = orderStats[0] || {};
      const s = salesStats[0] || {};
      return {
        branchId,
        name: branch.name,
        slug: branch.slug,
        isDefault: branch.isDefault,
        isActive: branch.isActive,
        orders: Number(o.orders || 0),
        orderRevenue: Number(o.revenue || 0),
        salesRevenue: Number(s.revenue || 0),
        netRevenue: Number(s.netRevenue || 0),
        employees: employeeCount,
        tables: tableCount,
      };
    }),
  );

  comparisons.sort((a, b) => b.orderRevenue - a.orderRevenue);

  return success(res, { days, branches: comparisons }, 'Branch comparison');
});

const listDeliveryDispatch = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = branchScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve branch scope', 403);

  const status = req.query.status || 'active';
  const statusFilter =
    status === 'all'
      ? {}
      : status === 'completed'
        ? { status: { $in: ['completed', 'cancelled'] } }
        : { status: { $nin: ['completed', 'cancelled'] } };

  const baseDeliveryMatch = {
    restaurant: restaurantId,
    branchId,
    isActive: { $ne: false },
    orderChannel: 'delivery',
  };

  const [orders, activeCount] = await Promise.all([
    CustomerOrder.find({
      ...baseDeliveryMatch,
      ...statusFilter,
    })
      .populate('table', 'tableNumber')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean(),
    CustomerOrder.countDocuments({
      ...baseDeliveryMatch,
      status: { $nin: ['completed', 'cancelled'] },
    }),
  ]);

  const rows = orders.map((o) => ({
    _id: o._id,
    orderNumber: o.orderNumber,
    status: o.status,
    paymentStatus: o.paymentStatus,
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    grandTotal: o.grandTotal,
    createdAt: o.createdAt,
    deliveryAddress: o.posDetails?.deliveryAddress || '',
    riderName: o.posDetails?.riderName || '',
    riderPhone: o.posDetails?.riderPhone || '',
    deliveryCharge: o.posDetails?.deliveryCharge || 0,
    tableNumber: o.table?.tableNumber,
  }));

  return success(res, { orders: rows, activeCount }, 'Delivery dispatch list');
});

const patchDeliveryDispatch = asyncHandler(async (req, res) => {
  const { restaurantId, branchId } = branchScope(req);
  if (!restaurantId || !branchId) return error(res, 'Unable to resolve branch scope', 403);

  const { riderName, riderPhone, deliveryAddress } = req.body;
  const order = await CustomerOrder.findOne({
    _id: req.params.id,
    restaurant: restaurantId,
    branchId,
    orderChannel: 'delivery',
    isActive: { $ne: false },
  });

  if (!order) return error(res, 'Delivery order not found', 404);

  order.posDetails = order.posDetails || {};
  if (riderName !== undefined) order.posDetails.riderName = String(riderName).trim();
  if (riderPhone !== undefined) order.posDetails.riderPhone = String(riderPhone).trim();
  if (deliveryAddress !== undefined) order.posDetails.deliveryAddress = String(deliveryAddress).trim();
  order.markModified('posDetails');
  await order.save();

  return success(res, {
    _id: order._id,
    riderName: order.posDetails.riderName,
    riderPhone: order.posDetails.riderPhone,
    deliveryAddress: order.posDetails.deliveryAddress,
  }, 'Delivery details updated');
});

module.exports = {
  getSetupChecklist,
  getFoodCostReport,
  compareBranches,
  listDeliveryDispatch,
  patchDeliveryDispatch,
};
