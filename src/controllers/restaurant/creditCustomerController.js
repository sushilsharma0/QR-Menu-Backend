const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const RestaurantCreditCustomer = require('../../models/restaurant/RestaurantCreditCustomer');
const CustomerOrder = require('../../models/restaurant/CustomerOrder');
const Transaction = require('../../models/restaurant/Transaction');
const { success, error } = require('../../utils/apiResponse');
const { sendCreditAccountNotificationEmail } = require('../../services/emailService');
const Restaurant = require('../../models/restaurant/Restaurant');
const { emitOrderUpdate, emitPaymentUpdate } = require('../../services/socketService');
const { ensureSalesReportForOrder } = require('../../services/salesReportService');
const { applyRecipeDeductionForCompletedOrder } = require('../../services/recipeInventoryService');
const { writeAuditLog } = require('../../utils/auditLog');

/**
 * @desc    List credit / house-account customers
 */
const listCreditCustomers = asyncHandler(async (req, res) => {
  const restaurantId = req.user.restaurantId || req.user.id;
  const {
    status = 'all',
    q: search = '',
    page = 1,
    limit = 24,
  } = req.query;
  const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 24));
  const skip = (pageNum - 1) * limitNum;
  const filter = { restaurant: restaurantId, branchId: req.branchId };
  const statusValue = String(status || 'all').toLowerCase();

  if (['pending', 'approved', 'rejected', 'suspended'].includes(statusValue)) {
    filter.status = statusValue;
  }
  if (String(search || '').trim()) {
    const esc = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(esc, 'i');
    filter.$or = [{ name: rx }, { email: rx }, { phone: rx }, { notes: rx }];
  }

  let owingIds = [];
  if (statusValue === 'owing') {
    const owingRows = await CustomerOrder.aggregate([
      {
        $match: {
          restaurant: new mongoose.Types.ObjectId(String(restaurantId)),
          branchId: new mongoose.Types.ObjectId(String(req.branchId)),
          isActive: true,
          isCreditSale: true,
          restaurantCreditCustomer: { $ne: null },
          paymentStatus: { $in: ['pending', 'partial'] },
        },
      },
      {
        $group: {
          _id: '$restaurantCreditCustomer',
          owed: { $sum: { $subtract: ['$grandTotal', { $ifNull: ['$amountPaidTotal', 0] }] } },
        },
      },
      { $match: { owed: { $gt: 0 } } },
    ]);
    owingIds = owingRows.map((row) => row._id);
    filter._id = { $in: owingIds };
  }

  const [items, total, statusAgg, owingAggAll] = await Promise.all([
    RestaurantCreditCustomer.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limitNum).lean(),
    RestaurantCreditCustomer.countDocuments(filter),
    RestaurantCreditCustomer.aggregate([
      { $match: { restaurant: new mongoose.Types.ObjectId(String(restaurantId)), branchId: new mongoose.Types.ObjectId(String(req.branchId)) } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    CustomerOrder.aggregate([
      {
        $match: {
          restaurant: new mongoose.Types.ObjectId(String(restaurantId)),
          branchId: new mongoose.Types.ObjectId(String(req.branchId)),
          isActive: true,
          isCreditSale: true,
          restaurantCreditCustomer: { $ne: null },
          paymentStatus: { $in: ['pending', 'partial'] },
        },
      },
      {
        $group: {
          _id: '$restaurantCreditCustomer',
          owed: { $sum: { $subtract: ['$grandTotal', { $ifNull: ['$amountPaidTotal', 0] }] },
          },
        },
      },
      { $match: { owed: { $gt: 0 } } },
      { $count: 'count' },
    ]),
  ]);

  const customerIds = items.map((i) => i._id);
  const owingAgg = await CustomerOrder.aggregate([
    {
      $match: {
        restaurant: new mongoose.Types.ObjectId(String(restaurantId)),
        branchId: new mongoose.Types.ObjectId(String(req.branchId)),
        isActive: true,
        isCreditSale: true,
        restaurantCreditCustomer: { $in: customerIds },
        paymentStatus: { $in: ['pending', 'partial'] },
      },
    },
    {
      $group: {
        _id: '$restaurantCreditCustomer',
        owed: { $sum: { $subtract: ['$grandTotal', { $ifNull: ['$amountPaidTotal', 0] }] } },
        orders: { $sum: 1 },
      },
    },
  ]);
  const owingMap = Object.fromEntries(owingAgg.map((r) => [String(r._id), { owed: r.owed, openOrders: r.orders }]));

  const enriched = items.map((row) => ({
    ...row,
    balanceOwed: Number(owingMap[String(row._id)]?.owed || 0).toFixed(2),
    openCreditOrders: owingMap[String(row._id)]?.orders || 0,
  }));

  const statusCounts = statusAgg.reduce(
    (acc, row) => ({ ...acc, [row._id || 'unknown']: row.count }),
    { pending: 0, approved: 0, rejected: 0, suspended: 0 },
  );
  statusCounts.owing = owingAggAll[0]?.count || 0;

  return success(
    res,
    {
      items: enriched,
      statusCounts,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.max(1, Math.ceil(total / limitNum)),
      },
    },
    'Credit customers retrieved',
  );
});

/**
 * @desc    Summary of all credit exposure
 */
const getCreditSummary = asyncHandler(async (req, res) => {
  const restaurantId = req.user.restaurantId || req.user.id;
  const rid = new mongoose.Types.ObjectId(String(restaurantId));

  const [openOrders, byCustomer] = await Promise.all([
    CustomerOrder.aggregate([
      {
        $match: {
          restaurant: rid,
          branchId: new mongoose.Types.ObjectId(String(req.branchId)),
          isActive: true,
          isCreditSale: true,
          paymentStatus: { $in: ['pending', 'partial'] },
        },
      },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          totalGrand: { $sum: '$grandTotal' },
          totalPaid: { $sum: { $ifNull: ['$amountPaidTotal', 0] } },
        },
      },
    ]),
    CustomerOrder.aggregate([
      {
        $match: {
          restaurant: rid,
          branchId: new mongoose.Types.ObjectId(String(req.branchId)),
          isActive: true,
          isCreditSale: true,
          paymentStatus: { $in: ['pending', 'partial'] },
          restaurantCreditCustomer: { $ne: null },
        },
      },
      {
        $group: {
          _id: '$restaurantCreditCustomer',
          owed: { $sum: { $subtract: ['$grandTotal', { $ifNull: ['$amountPaidTotal', 0] }] } },
          orders: { $sum: 1 },
        },
      },
      { $sort: { owed: -1 } },
      { $limit: 50 },
      {
        $lookup: {
          from: RestaurantCreditCustomer.collection.name,
          localField: '_id',
          foreignField: '_id',
          as: 'cust',
        },
      },
      { $unwind: { path: '$cust', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          customerId: '$_id',
          email: '$cust.email',
          name: '$cust.name',
          owed: 1,
          orders: 1,
        },
      },
    ]),
  ]);

  const o = openOrders[0] || { count: 0, totalGrand: 0, totalPaid: 0 };
  const totalOwed = Math.max(0, Number(o.totalGrand || 0) - Number(o.totalPaid || 0));

  return success(
    res,
    {
      openCreditOrderCount: o.count,
      totalOwed: Number(totalOwed.toFixed(2)),
      topCustomers: byCustomer,
    },
    'Credit summary retrieved',
  );
});

const patchCreditCustomer = asyncHandler(async (req, res) => {
  const restaurantId = req.user.restaurantId || req.user.id;
  const { id } = req.params;
  const { status, notes, creditLimit, rejectedReason } = req.body;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return error(res, 'Invalid id', 400);
  }

  const doc = await RestaurantCreditCustomer.findOne({ _id: id, restaurant: restaurantId, branchId: req.branchId });
  if (!doc) return error(res, 'Record not found', 404);

  const prev = doc.status;

  if (typeof notes === 'string') doc.notes = notes.slice(0, 500);
  if (creditLimit != null && creditLimit !== '') {
    const n = Number(creditLimit);
    if (!Number.isNaN(n) && n >= 0) doc.creditLimit = n;
  }

  if (status && ['pending', 'approved', 'rejected', 'suspended'].includes(status)) {
    doc.status = status;
    if (status === 'approved') {
      doc.approvedAt = new Date();
      doc.approvedBy = req.user.id;
      doc.rejectedReason = '';
    }
    if (status === 'rejected') {
      doc.rejectedReason = String(rejectedReason || '').slice(0, 500);
    }
  }

  await doc.save();

  if (prev !== 'approved' && doc.status === 'approved') {
    const r = await Restaurant.findById(restaurantId).select('name').lean();
    await sendCreditAccountNotificationEmail(doc.email, {
      restaurantName: r?.name || 'Restaurant',
      status: 'approved',
      message: `Your request for a house account at ${r?.name || 'the restaurant'} was approved.`,
    }).catch(() => {});
  }
  if (doc.status === 'rejected' && prev !== 'rejected') {
    const r = await Restaurant.findById(restaurantId).select('name').lean();
    await sendCreditAccountNotificationEmail(doc.email, {
      restaurantName: r?.name || 'Restaurant',
      status: 'rejected',
      message: doc.rejectedReason || 'Your credit application was not approved.',
    }).catch(() => {});
  }

  return success(res, doc, 'Updated');
});

const getCreditCustomerLedger = asyncHandler(async (req, res) => {
  const restaurantId = req.user.restaurantId || req.user.id;
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return error(res, 'Invalid id', 400);
  }

  const customer = await RestaurantCreditCustomer.findOne({ _id: id, restaurant: restaurantId, branchId: req.branchId }).lean();
  if (!customer) return error(res, 'Record not found', 404);

  const orders = await CustomerOrder.find({
    restaurant: restaurantId,
    branchId: req.branchId,
    restaurantCreditCustomer: id,
    isCreditSale: true,
    isActive: true,
  })
    .select('orderNumber customerName grandTotal amountPaidTotal paymentStatus paymentMethod status createdAt updatedAt')
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  const orderIds = orders.map((order) => order._id);
  const transactions = await Transaction.find({
    restaurant: restaurantId,
    branchId: req.branchId,
    customerOrder: { $in: orderIds },
  })
    .select('receiptNo amount paymentMethod status createdAt customerOrder processedBy notes')
    .populate('processedBy', 'name username email')
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  const transactionTotals = transactions.reduce(
    (acc, tx) => {
      if (tx.status === 'success') acc.paid += Number(tx.amount || 0);
      if (tx.status === 'refunded') acc.refunded += Number(tx.amount || 0);
      return acc;
    },
    { paid: 0, refunded: 0 },
  );

  const openBalance = orders.reduce((sum, order) => {
    if (!['pending', 'partial'].includes(order.paymentStatus)) return sum;
    return sum + Math.max(0, Number(order.grandTotal || 0) - Number(order.amountPaidTotal || 0));
  }, 0);

  return success(
    res,
    {
      customer,
      orders,
      transactions,
      summary: {
        orderCount: orders.length,
        openBalance: Number(openBalance.toFixed(2)),
        totalPaid: Number(transactionTotals.paid.toFixed(2)),
        totalRefunded: Number(transactionTotals.refunded.toFixed(2)),
      },
    },
    'Credit customer ledger retrieved',
  );
});

const payCreditCustomerOrder = asyncHandler(async (req, res) => {
  const restaurantId = req.user.restaurantId || req.user.id;
  const { id, orderId } = req.params;
  const { paymentMethod = 'cash', amount } = req.body;

  if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(orderId)) {
    return error(res, 'Invalid id', 400);
  }

  const customer = await RestaurantCreditCustomer.findOne({
    _id: id,
    restaurant: restaurantId,
    branchId: req.branchId,
    status: 'approved',
  });
  if (!customer) return error(res, 'Approved credit customer not found', 404);

  const order = await CustomerOrder.findOne({
    _id: orderId,
    restaurant: restaurantId,
    branchId: req.branchId,
    restaurantCreditCustomer: id,
    isCreditSale: true,
    isActive: true,
  });
  if (!order) return error(res, 'Credit order not found for this customer', 404);
  if (order.paymentStatus === 'paid') return error(res, 'Order already paid', 400);

  const grand = Number(order.grandTotal || 0);
  const alreadyPaid = Number(order.amountPaidTotal || 0);
  const due = Math.max(0, grand - alreadyPaid);
  if (due <= 0) return error(res, 'Nothing left to pay on this credit order', 400);

  let method = String(paymentMethod || 'cash').toLowerCase();
  if (['upi', 'card', 'wallet', 'esewa', 'khalti', 'fonepay'].includes(method)) method = 'online';
  if (!['cash', 'online'].includes(method)) {
    return error(res, 'paymentMethod must be cash or online', 400);
  }

  let payAmount = Number(amount);
  if (!Number.isFinite(payAmount) || payAmount <= 0) payAmount = due;
  if (payAmount - due > 0.02) return error(res, 'Payment cannot exceed balance due', 400);
  payAmount = Math.min(payAmount, due);

  const transaction = await Transaction.create({
    restaurant: restaurantId,
    branchId: req.branchId,
    customerOrder: order._id,
    amount: payAmount,
    paymentMethod: method,
    status: 'success',
    processedBy: req.user.employeeId || req.user.id,
    notes: `Credit customer payment (${customer.name}) for order ${order.orderNumber}`,
    linkedOrderStatus: order.status,
    linkedOrderPaymentStatus: 'paid',
  });

  const newPaidTotal = alreadyPaid + payAmount;
  const fullyPaid = newPaidTotal >= grand - 0.02;
  order.amountPaidTotal = newPaidTotal;
  order.paymentStatus = fullyPaid ? 'paid' : 'partial';
  order.paymentMethod = 'credit';

  if (fullyPaid) {
    order.customerPaymentDeferred = false;
    order.guestPaymentPreferenceAt = null;
    order.guestPaymentPreferenceCash = 0;
    order.guestPaymentPreferenceOnline = 0;
    if (order.status === 'served') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        timestamp: new Date(),
        updatedBy: req.user.employeeId || req.user.id,
        note: 'Credit balance paid',
      });
    }
  }

  await order.save();
  if (fullyPaid) {
    await ensureSalesReportForOrder(order);
    if (order.status === 'completed') {
      try {
        await applyRecipeDeductionForCompletedOrder(order, {
          userId: req.user.employeeId || req.user.id,
          userModel: req.user.scope === 'employee' ? 'Employee' : 'Restaurant',
        });
      } catch (recipeErr) {
        console.error('recipeInventory deduction failed', recipeErr);
      }
    }
  }

  await writeAuditLog(req, {
    action: 'credit_customer_payment_received',
    resource: 'order',
    resourceId: order._id,
    details: {
      restaurantId: String(restaurantId),
      creditCustomerId: String(customer._id),
      orderNumber: order.orderNumber,
      transactionId: String(transaction._id),
      receiptNo: transaction.receiptNo,
      amount: transaction.amount,
      paymentMethod: transaction.paymentMethod,
      paymentStatus: order.paymentStatus,
      message: `Credit payment recorded for ${customer.name} on order #${order.orderNumber}`,
    },
  });

  emitOrderUpdate(String(restaurantId), order);
  emitPaymentUpdate(String(restaurantId), {
    _id: transaction._id,
    receiptNo: transaction.receiptNo,
    amount: transaction.amount,
    paymentMethod: transaction.paymentMethod,
    status: transaction.status,
    createdAt: transaction.createdAt,
    customerOrder: {
      _id: order._id,
      orderNumber: order.orderNumber,
      grandTotal: order.grandTotal,
      paymentStatus: order.paymentStatus,
    },
    orderNumber: order.orderNumber,
    paymentStatus: order.paymentStatus,
    orderStatus: order.status,
  });

  return success(
    res,
    {
      order: {
        id: order._id,
        orderNumber: order.orderNumber,
        status: order.status,
        paymentStatus: order.paymentStatus,
        amountPaidTotal: order.amountPaidTotal,
      },
      transaction,
    },
    fullyPaid ? 'Credit balance marked paid' : 'Credit payment recorded',
  );
});

module.exports = {
  listCreditCustomers,
  getCreditSummary,
  getCreditCustomerLedger,
  payCreditCustomerOrder,
  patchCreditCustomer,
};
