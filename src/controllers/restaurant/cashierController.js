const asyncHandler = require('express-async-handler');
const Order = require('../../models/restaurant/Order');
const Transaction = require('../../models/restaurant/Transaction');
const CustomerOrder = require('../../models/restaurant/CustomerOrder');
const POSInvoice = require('../../models/restaurant/POSInvoice');
const RestaurantCreditCustomer = require('../../models/restaurant/RestaurantCreditCustomer');
const { emitOrderUpdate, emitPaymentUpdate } = require('../../services/socketService');
const { success, error } = require('../../utils/apiResponse');
const notificationService = require('../../services/notificationService');
const { applyRecipeDeductionForCompletedOrder } = require('../../services/recipeInventoryService');
const { ensureSalesReportForOrder } = require('../../services/salesReportService');
const { writeAuditLog } = require('../../utils/auditLog');
const { legacyRestaurantScope } = require('../../utils/tenantScope');

const actorRef = (req) => req.user.employeeId || req.user.id;
const actorModel = (req) => {
  if (req.user?.scope === 'branch_user') return 'BranchAuth';
  if (req.user?.scope === 'employee' || req.user?.employeeId) return 'Employee';
  return 'Restaurant';
};

const lockInvoiceForOrder = async (order, req) => {
  await POSInvoice.findOneAndUpdate(
    {
      restaurant: order.restaurant,
      branchId: order.branchId || null,
      customerOrder: order._id,
      status: { $ne: 'voided' },
    },
    {
      $set: {
        status: 'locked',
        lockedAt: new Date(),
        lockedBy: actorRef(req),
        lockedByModel: actorModel(req),
      },
    },
  );
};

const normalizeCounterMethod = (method = 'cash') => {
  let txMethod = String(method || 'cash').toLowerCase();
  if (['upi', 'card', 'wallet', 'esewa', 'khalti', 'fonepay'].includes(txMethod)) txMethod = 'online';
  return txMethod;
};

const settleCustomerOrderPayment = async ({
  req,
  restaurantId,
  order,
  paymentMode,
  paymentMethod = 'cash',
  amount,
  cashAmount,
  onlineAmount,
  keepCreditMethod = false,
  notesPrefix = 'Payment',
}) => {
  const grand = Number(order.grandTotal || 0);
  const alreadyPaid = Number(order.amountPaidTotal || 0);
  const remaining = Math.max(0, grand - alreadyPaid);

  if (remaining <= 0) {
    const err = new Error('Nothing left to pay on this order');
    err.statusCode = 400;
    throw err;
  }

  const transactions = [];
  let paidThisRound = 0;
  let effectiveMethod = normalizeCounterMethod(paymentMethod);

  if (String(paymentMode) === 'both') {
    const cashAmt = Math.max(0, Number(cashAmount) || 0);
    const onlineAmt = Math.max(0, Number(onlineAmount) || 0);
    const sum = cashAmt + onlineAmt;
    if (sum <= 0) {
      const err = new Error('Enter cash and/or online amounts');
      err.statusCode = 400;
      throw err;
    }
    if (sum - remaining > 0.02) {
      const err = new Error('Cash plus online cannot exceed the amount due');
      err.statusCode = 400;
      throw err;
    }

    if (cashAmt > 0) {
      transactions.push(
        await Transaction.create({
          restaurant: restaurantId,
          branchId: req.branchId,
          customerOrder: order._id,
          amount: cashAmt,
          paymentMethod: 'cash',
          status: 'success',
          processedBy: req.user.employeeId || req.user.id,
          notes: `${notesPrefix} cash portion for order ${order.orderNumber}`,
          linkedOrderStatus: order.status,
          linkedOrderPaymentStatus: 'paid',
        }),
      );
    }
    if (onlineAmt > 0) {
      transactions.push(
        await Transaction.create({
          restaurant: restaurantId,
          branchId: req.branchId,
          customerOrder: order._id,
          amount: onlineAmt,
          paymentMethod: 'online',
          status: 'success',
          processedBy: req.user.employeeId || req.user.id,
          notes: `${notesPrefix} online portion for order ${order.orderNumber}`,
          linkedOrderStatus: order.status,
          linkedOrderPaymentStatus: 'paid',
        }),
      );
    }
    paidThisRound = sum;
    effectiveMethod = cashAmt > 0 && onlineAmt > 0 ? 'mixed' : cashAmt > 0 ? 'cash' : 'online';
  } else {
    if (!['cash', 'online'].includes(effectiveMethod)) {
      const err = new Error('paymentMethod must be cash or online');
      err.statusCode = 400;
      throw err;
    }

    let payAmount = Number(amount);
    if (!Number.isFinite(payAmount) || payAmount <= 0) payAmount = remaining;
    payAmount = Math.min(payAmount, remaining);
    if (payAmount <= 0) {
      const err = new Error('Nothing left to pay on this order');
      err.statusCode = 400;
      throw err;
    }

    transactions.push(
      await Transaction.create({
        restaurant: restaurantId,
        branchId: req.branchId,
        customerOrder: order._id,
        amount: payAmount,
        paymentMethod: effectiveMethod,
        status: 'success',
        processedBy: req.user.employeeId || req.user.id,
        notes: `${notesPrefix} for order ${order.orderNumber}`,
        linkedOrderStatus: order.status,
        linkedOrderPaymentStatus: 'paid',
      }),
    );
    paidThisRound = payAmount;
  }

  const newPaidTotal = alreadyPaid + paidThisRound;
  order.amountPaidTotal = newPaidTotal;
  const fullyPaid = newPaidTotal >= grand - 0.02;
  order.paymentStatus = fullyPaid ? 'paid' : 'partial';
  if (!keepCreditMethod && order.paymentMethod !== 'mixed') {
    order.paymentMethod = effectiveMethod;
  }

  if (fullyPaid) {
    if (order.status === 'served') {
      order.status = 'completed';
      if (Array.isArray(order.statusHistory)) {
        order.statusHistory.push({
          status: 'completed',
          timestamp: new Date(),
          updatedBy: req.user.employeeId || req.user.id,
          note: 'Payment completed - thank you',
        });
      }
    } else if (!['completed', 'cancelled'].includes(order.status)) {
      order.status = 'served';
      if (Array.isArray(order.statusHistory)) {
        order.statusHistory.push({
          status: 'served',
          timestamp: new Date(),
          updatedBy: req.user.employeeId || req.user.id,
          note: 'Marked served after payment',
        });
      }
    }
    order.customerPaymentDeferred = false;
    order.guestPaymentPreferenceAt = null;
    order.guestPaymentPreferenceCash = 0;
    order.guestPaymentPreferenceOnline = 0;
  }

  await order.save();
  if (fullyPaid) {
    await ensureSalesReportForOrder(order);
    await lockInvoiceForOrder(order, req);
  }

  if (order.status === 'completed') {
    try {
      await applyRecipeDeductionForCompletedOrder(order, {
        userId: req.user.employeeId || req.user.id,
        userModel: req.user.scope === 'employee' ? 'Employee' : 'Restaurant',
      });
    } catch (err) {
      console.error('recipeInventory deduction failed', err);
    }
  }

  return { order, transactions, transaction: transactions[transactions.length - 1] || null };
};

/**
 * @desc    Process payment for order
 * @route   POST /api/restaurant/cashier/pay
 * @access  Private (Cashier/Restaurant)
 */
const processPayment = asyncHandler(async (req, res) => {
  const {
    orderId,
    paymentMethod = 'cash',
    amount,
    customerOrderId,
    creditCustomerId,
    paymentMode,
    cashAmount: cashAmountBody,
    onlineAmount: onlineAmountBody,
  } = req.body;
  const restaurantId = req.user.restaurantId || req.user.id;
  
  let order;
  
  if (customerOrderId) {
    order = await CustomerOrder.findOne({
      _id: customerOrderId,
      ...legacyRestaurantScope(req),
    });
    
    if (!order) {
      return error(res, 'Order not found', 404);
    }

    if (String(paymentMethod) === 'credit') {
      if (!creditCustomerId) {
        return error(res, 'creditCustomerId is required to post to a house account', 400);
      }
      const cc = await RestaurantCreditCustomer.findOne({
        _id: creditCustomerId,
        restaurant: restaurantId,
        branchId: req.branchId,
        status: 'approved',
      });
      if (!cc) {
        return error(res, 'House account not found or not approved', 404);
      }
      if (order.isCreditSale) {
        return error(res, 'Order is already on a house account', 400);
      }
      if (order.paymentStatus === 'paid') {
        return error(res, 'Order already paid', 400);
      }
      order.restaurantCreditCustomer = cc._id;
      order.isCreditSale = true;
      order.paymentMethod = 'credit';
      order.paymentStatus = 'pending';
      order.amountPaidTotal = 0;
      order.customerPaymentDeferred = false;
      order.guestPaymentPreferenceAt = null;
      order.guestPaymentPreferenceCash = 0;
      order.guestPaymentPreferenceOnline = 0;
      await order.save();
      emitOrderUpdate(restaurantId.toString(), order);
      await writeAuditLog(req, {
        action: 'order_credit_linked',
        resource: 'order',
        resourceId: order._id,
        details: {
          restaurantId: String(restaurantId),
          orderNumber: order.orderNumber,
          creditCustomerId: String(cc._id),
          message: `Order #${order.orderNumber} posted to house account`,
        },
      });
      return success(res, order, 'Charge posted to house account');
    }
    
    if (order.paymentStatus === 'paid') {
      return error(res, 'Order already paid', 400);
    }

    if (order.isCreditSale) {
      return error(res, 'Credit orders must be settled from the house credit section', 403);
    }

    const grand = Number(order.grandTotal || 0);
    const alreadyPaid = Number(order.amountPaidTotal || 0);
    const remaining = Math.max(0, grand - alreadyPaid);

    if (String(paymentMode) === 'both') {
      const cashAmt = Math.max(0, Number(cashAmountBody) || 0);
      const onlineAmt = Math.max(0, Number(onlineAmountBody) || 0);
      const sum = cashAmt + onlineAmt;
      if (sum <= 0) {
        return error(res, 'Enter cash and/or online amounts', 400);
      }
      if (sum - remaining > 0.02) {
        return error(res, 'Cash plus online cannot exceed the amount due', 400);
      }

      const transactions = [];
      if (cashAmt > 0) {
        transactions.push(
          await Transaction.create({
            restaurant: restaurantId,
            branchId: req.branchId,
            customerOrder: order._id,
            amount: cashAmt,
            paymentMethod: 'cash',
            status: 'success',
            processedBy: req.user.employeeId || req.user.id,
            notes: `Cash portion for order ${order.orderNumber}`,
            linkedOrderStatus: order.status,
            linkedOrderPaymentStatus: 'paid',
          }),
        );
      }
      if (onlineAmt > 0) {
        transactions.push(
          await Transaction.create({
            restaurant: restaurantId,
            branchId: req.branchId,
            customerOrder: order._id,
            amount: onlineAmt,
            paymentMethod: 'online',
            status: 'success',
            processedBy: req.user.employeeId || req.user.id,
            notes: `Online portion for order ${order.orderNumber}`,
            linkedOrderStatus: order.status,
            linkedOrderPaymentStatus: 'paid',
          }),
        );
      }

      const newPaidTotal = alreadyPaid + sum;
      order.amountPaidTotal = newPaidTotal;
      const fullyPaid = newPaidTotal >= grand - 0.02;
      order.paymentStatus = fullyPaid ? 'paid' : 'partial';
      if (cashAmt > 0 && onlineAmt > 0) order.paymentMethod = 'mixed';
      else if (cashAmt > 0) order.paymentMethod = 'cash';
      else order.paymentMethod = 'online';

      if (fullyPaid) {
        if (order.status === 'served') {
          order.status = 'completed';
          if (Array.isArray(order.statusHistory)) {
            order.statusHistory.push({
              status: 'completed',
              timestamp: new Date(),
              updatedBy: req.user.employeeId || req.user.id,
              note: 'Payment completed — thank you',
            });
          }
        } else {
          order.status = 'served';
          if (Array.isArray(order.statusHistory)) {
            order.statusHistory.push({
              status: 'served',
              timestamp: new Date(),
              updatedBy: req.user.employeeId || req.user.id,
              note: 'Marked served after payment',
            });
          }
        }
        order.customerPaymentDeferred = false;
        order.guestPaymentPreferenceAt = null;
        order.guestPaymentPreferenceCash = 0;
        order.guestPaymentPreferenceOnline = 0;
      }
      await order.save();
      if (fullyPaid) {
        await ensureSalesReportForOrder(order);
        await lockInvoiceForOrder(order, req);
      }

      if (order.status === 'completed') {
        try {
          await applyRecipeDeductionForCompletedOrder(order, {
            userId: req.user.employeeId || req.user.id,
            userModel: req.user.scope === 'employee' ? 'Employee' : 'Restaurant',
          });
        } catch (err) {
          console.error('recipeInventory deduction failed', err);
        }
      }

      await writeAuditLog(req, {
        action: 'payment_received',
        resource: 'order',
        resourceId: order._id,
        details: {
          restaurantId: String(restaurantId),
          orderNumber: order.orderNumber,
          splitCash: cashAmt,
          splitOnline: onlineAmt,
          paymentStatus: order.paymentStatus,
          orderStatus: order.status,
          message: `Split payment for order #${order.orderNumber}`,
        },
      });

      emitOrderUpdate(restaurantId.toString(), order);
      const lastTx = transactions[transactions.length - 1];
      if (lastTx) {
        emitPaymentUpdate(restaurantId.toString(), {
          _id: lastTx._id,
          receiptNo: lastTx.receiptNo,
          amount: lastTx.amount,
          paymentMethod: lastTx.paymentMethod,
          status: lastTx.status,
          createdAt: lastTx.createdAt,
          customerOrder: {
            _id: order._id,
            orderNumber: order.orderNumber,
            grandTotal: order.grandTotal,
            paymentStatus: order.paymentStatus,
          },
          orderNumber: order.orderNumber,
          paymentStatus: order.paymentStatus,
          orderStatus: order.status,
          linkedOrderStatus: order.status,
        });
      }

      await notificationService.sendNotification({
        recipientType: 'restaurant',
        recipientId: restaurantId,
        category: 'order',
        type: 'payment_received',
        priority: 'high',
        title: 'Payment received',
        message: `Split payment recorded for order #${order.orderNumber}.`,
        relatedEntity: { entityType: 'order', entityId: order._id },
        actionUrl: '/notifications',
      });

      return success(
        res,
        {
          order: {
            id: order._id,
            orderNumber: order.orderNumber,
            status: order.status,
            paymentStatus: order.paymentStatus,
          },
          transactions,
        },
        'Payment processed successfully',
      );
    }

    let payAmount = Number(amount);
    if (!Number.isFinite(payAmount) || payAmount <= 0) payAmount = remaining;
    payAmount = Math.min(payAmount, remaining);
    if (payAmount <= 0) {
      return error(res, 'Nothing left to pay on this order', 400);
    }

    let txMethod = String(paymentMethod || 'cash').toLowerCase();
    if (['upi', 'card', 'wallet', 'esewa', 'khalti', 'fonepay'].includes(txMethod)) txMethod = 'online';
    if (!['cash', 'online'].includes(txMethod)) {
      return error(res, 'paymentMethod must be cash or online', 400);
    }

    const transaction = await Transaction.create({
      restaurant: restaurantId,
      branchId: req.branchId,
      customerOrder: order._id,
      amount: payAmount,
      paymentMethod: txMethod,
      status: 'success',
      processedBy: req.user.employeeId || req.user.id,
      notes: `Payment for order ${order.orderNumber}`,
      linkedOrderStatus: order.status,
      linkedOrderPaymentStatus: 'paid',
    });

    const newPaidTotal = alreadyPaid + payAmount;
    order.amountPaidTotal = newPaidTotal;
    const fullyPaid = newPaidTotal >= grand - 0.02;
    order.paymentStatus = fullyPaid ? 'paid' : 'partial';
    if (customerOrderId && !order.isCreditSale && order.paymentMethod !== 'mixed') {
      order.paymentMethod = txMethod;
    } else if (!customerOrderId && paymentMethod && paymentMethod !== order.paymentMethod) {
      order.paymentMethod = order.paymentMethod === 'mixed' || order.isCreditSale ? order.paymentMethod : paymentMethod;
    }

    if (fullyPaid) {
      if (order.status === 'served') {
        order.status = 'completed';
        if (Array.isArray(order.statusHistory)) {
          order.statusHistory.push({
            status: 'completed',
            timestamp: new Date(),
            updatedBy: req.user.employeeId || req.user.id,
            note: 'Payment completed — thank you',
          });
        }
      } else {
        order.status = 'served';
        if (Array.isArray(order.statusHistory)) {
          order.statusHistory.push({
            status: 'served',
            timestamp: new Date(),
            updatedBy: req.user.employeeId || req.user.id,
            note: 'Marked served after payment',
          });
        }
      }
      order.customerPaymentDeferred = false;
      order.guestPaymentPreferenceAt = null;
      order.guestPaymentPreferenceCash = 0;
      order.guestPaymentPreferenceOnline = 0;
    }
    await order.save();
    if (fullyPaid) {
      await ensureSalesReportForOrder(order);
      await lockInvoiceForOrder(order, req);
    }

    if (order.status === 'completed') {
      try {
        await applyRecipeDeductionForCompletedOrder(order, {
          userId: req.user.employeeId || req.user.id,
          userModel: req.user.scope === 'employee' ? 'Employee' : 'Restaurant',
        });
      } catch (err) {
        console.error('recipeInventory deduction failed', err);
      }
    }

    await writeAuditLog(req, {
      action: 'payment_received',
      resource: 'order',
      resourceId: order._id,
      details: {
        restaurantId: String(restaurantId),
        orderNumber: order.orderNumber,
        transactionId: String(transaction._id),
        receiptNo: transaction.receiptNo,
        amount: transaction.amount,
        paymentMethod: transaction.paymentMethod,
        paymentStatus: order.paymentStatus,
        orderStatus: order.status,
        message: `Payment ${transaction.receiptNo} received for order #${order.orderNumber}`,
      },
    });
    
    emitOrderUpdate(restaurantId.toString(), order);
    emitPaymentUpdate(restaurantId.toString(), {
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
        paymentStatus: order.paymentStatus
      },
      orderNumber: order.orderNumber,
      paymentStatus: order.paymentStatus,
      orderStatus: order.status,
      linkedOrderStatus: order.status
    });

    await notificationService.sendNotification({
      recipientType: 'restaurant',
      recipientId: restaurantId,
      category: 'order',
      type: 'payment_received',
      priority: 'high',
      title: 'Payment received',
      message: `Payment received for order #${order.orderNumber}.`,
      relatedEntity: { entityType: 'order', entityId: order._id },
      actionUrl: '/notifications',
    });
    
    return success(res, {
      order: {
        id: order._id,
        orderNumber: order.orderNumber,
        status: order.status,
        paymentStatus: order.paymentStatus
      },
      transaction
    }, 'Payment processed successfully');
  } else {
    order = await Order.findOne({
      _id: orderId,
      ...legacyRestaurantScope(req),
    });
    
    if (!order) {
      return error(res, 'Order not found', 404);
    }
    
    if (order.status === 'served') {
      return error(res, 'Order already paid', 400);
    }
    
    order.status = 'served';
    order.handledBy = req.user.employeeId || req.user.id;
    await order.save();

    let legacyTxMethod = String(paymentMethod || 'cash').toLowerCase();
    if (['upi', 'card', 'wallet', 'esewa', 'khalti', 'fonepay'].includes(legacyTxMethod)) legacyTxMethod = 'online';
    if (!['cash', 'online'].includes(legacyTxMethod)) legacyTxMethod = 'cash';

    const transaction = await Transaction.create({
      restaurant: restaurantId,
      branchId: req.branchId,
      order: order._id,
      amount: amount || order.totalAmount,
      paymentMethod: legacyTxMethod,
      status: 'success',
      processedBy: req.user.employeeId || req.user.id
    });

    await writeAuditLog(req, {
      action: 'payment_received',
      resource: 'order',
      resourceId: order._id,
      details: {
        restaurantId: String(restaurantId),
        orderNumber: order.orderNumber,
        transactionId: String(transaction._id),
        receiptNo: transaction.receiptNo,
        amount: transaction.amount,
        paymentMethod: transaction.paymentMethod,
        orderStatus: order.status,
        message: `Payment ${transaction.receiptNo} received for order ${order.orderNumber || order._id}`,
      },
    });
    
    emitOrderUpdate(restaurantId.toString(), order);
    emitPaymentUpdate(restaurantId.toString(), {
      _id: transaction._id,
      receiptNo: transaction.receiptNo,
      amount: transaction.amount,
      paymentMethod: transaction.paymentMethod,
      status: transaction.status,
      createdAt: transaction.createdAt,
      order: { _id: order._id, orderNumber: order.orderNumber },
      orderNumber: order.orderNumber,
      orderStatus: order.status
    });
    
    return success(res, {
      order,
      transaction
    }, 'Payment processed successfully');
  }
});

/**
 * @desc    Settle a house-credit order from the cashier credit section
 * @route   POST /api/restaurant/cashier/credit/pay
 * @access  Private (Cashier/Restaurant)
 */
const processCreditPayment = asyncHandler(async (req, res) => {
  const {
    customerOrderId,
    paymentMethod = 'cash',
    paymentMode,
    amount,
    cashAmount,
    onlineAmount,
  } = req.body;
  const restaurantId = req.user.restaurantId || req.user.id;

  if (!customerOrderId) return error(res, 'customerOrderId is required', 400);

  const order = await CustomerOrder.findOne({
    _id: customerOrderId,
    ...legacyRestaurantScope(req),
  });

  if (!order) return error(res, 'Order not found', 404);
  if (!order.isCreditSale || !order.restaurantCreditCustomer) {
    return error(res, 'This order is not linked to a house account', 400);
  }
  if (order.paymentStatus === 'paid') {
    return error(res, 'Order already paid', 400);
  }

  const cc = await RestaurantCreditCustomer.findOne({
    _id: order.restaurantCreditCustomer,
    restaurant: restaurantId,
    branchId: req.branchId,
    status: 'approved',
  });
  if (!cc) {
    return error(res, 'House account is not approved for settlement', 403);
  }

  try {
    const { transactions, transaction } = await settleCustomerOrderPayment({
      req,
      restaurantId,
      order,
      paymentMode,
      paymentMethod,
      amount,
      cashAmount,
      onlineAmount,
      keepCreditMethod: true,
      notesPrefix: `House credit settlement (${cc.name})`,
    });

    await writeAuditLog(req, {
      action: 'credit_payment_received',
      resource: 'order',
      resourceId: order._id,
      details: {
        restaurantId: String(restaurantId),
        orderNumber: order.orderNumber,
        creditCustomerId: String(cc._id),
        amount: transactions.reduce((sum, tx) => sum + Number(tx.amount || 0), 0),
        paymentStatus: order.paymentStatus,
        orderStatus: order.status,
        message: `House credit payment received for order #${order.orderNumber}`,
      },
    });

    emitOrderUpdate(restaurantId.toString(), order);
    if (transaction) {
      emitPaymentUpdate(restaurantId.toString(), {
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
        linkedOrderStatus: order.status,
      });
    }

    await notificationService.sendNotification({
      recipientType: 'restaurant',
      recipientId: restaurantId,
      category: 'order',
      type: 'payment_received',
      priority: 'high',
      title: 'House credit payment received',
      message: `House credit payment recorded for order #${order.orderNumber}.`,
      relatedEntity: { entityType: 'order', entityId: order._id },
      actionUrl: '/notifications',
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
        transactions,
      },
      'House credit payment processed successfully',
    );
  } catch (err) {
    return error(res, err.message || 'Payment failed', err.statusCode || 500);
  }
});

/**
 * @desc    Get all transactions
 * @route   GET /api/restaurant/cashier/transactions
 * @access  Private (Cashier/Restaurant)
 */
const getTransactions = asyncHandler(async (req, res) => {
  const restaurantId = req.user.restaurantId || req.user.id;
  const { page = 1, limit = 20, method, status, startDate, endDate, q } = req.query;
  
  const [branchCustomerOrders, branchLegacyOrders] = await Promise.all([
    CustomerOrder.find(legacyRestaurantScope(req)).select('_id').lean(),
    Order.find(legacyRestaurantScope(req)).select('_id').lean(),
  ]);
  const branchCustomerOrderIds = branchCustomerOrders.map((order) => order._id);
  const branchLegacyOrderIds = branchLegacyOrders.map((order) => order._id);
  const query = {
    restaurant: restaurantId,
    branchId: req.branchId,
    $or: [
      { customerOrder: { $in: branchCustomerOrderIds } },
      { order: { $in: branchLegacyOrderIds } },
    ],
  };
  if (method) query.paymentMethod = method;
  if (status) query.status = status;
  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }
  const qTrim = q != null ? String(q).trim() : '';
  if (qTrim) {
    const esc = qTrim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const orderMatches = await CustomerOrder.find({
      ...legacyRestaurantScope(req),
      orderNumber: new RegExp(esc, 'i'),
    })
      .select('_id')
      .lean();
    const orderIds = orderMatches.map((o) => o._id);
    query.$and = [
      { $or: query.$or },
      { $or: [{ receiptNo: new RegExp(esc, 'i') }, { customerOrder: { $in: orderIds } }] },
    ];
    delete query.$or;
  }
  
  const skip = (page - 1) * limit;
  
  const transactions = await Transaction.find(query)
    .populate('order', 'totalAmount items status orderNumber')
    .populate('customerOrder', 'orderNumber customerName grandTotal status paymentStatus')
    .populate('processedBy', 'name username email')
    .populate('refundedBy', 'name email')
    .populate('statusHistory.updatedBy', 'name email')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(parseInt(limit));
  
  const total = await Transaction.countDocuments(query);
  
  const summaryMatch = { ...query };

  // Get summary
  const summary = await Transaction.aggregate([
    { $match: summaryMatch },
    {
      $group: {
        _id: null,
        totalAmount: { $sum: '$amount' },
        totalRevenue: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, '$amount', 0] } },
        totalTransactions: { $sum: 1 },
        successfulTransactions: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
        pendingTransactions: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
        failedTransactions: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
        refundedTransactions: { $sum: { $cond: [{ $eq: ['$status', 'refunded'] }, 1, 0] } },
        byCash: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, 1, 0] } },
        byCard: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'card'] }, 1, 0] } },
        byOnline: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'online'] }, 1, 0] } },
        byUpi: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'upi'] }, 1, 0] } },
        byWallet: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'wallet'] }, 1, 0] } },
        amountByCash: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, '$amount', 0] } },
        amountByCard: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'card'] }, '$amount', 0] } },
        amountByOnline: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'online'] }, '$amount', 0] } },
        amountByUpi: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'upi'] }, '$amount', 0] } },
        amountByWallet: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'wallet'] }, '$amount', 0] } },
        averageAmount: { $avg: '$amount' },
        totalRefunded: { $sum: { $cond: [{ $eq: ['$status', 'refunded'] }, '$amount', 0] } },
        refundCount: { $sum: { $cond: [{ $eq: ['$refunded', true] }, 1, 0] } }
      }
    }
  ]);

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const existingDateFilter = summaryMatch.createdAt || {};
  const earliestToday = existingDateFilter.$gte
    ? new Date(Math.max(new Date(existingDateFilter.$gte).getTime(), startOfToday.getTime()))
    : startOfToday;

  const todayMatch = {
    ...summaryMatch,
    createdAt: {
      ...existingDateFilter,
      $gte: earliestToday
    }
  };

  const todaySummary = await Transaction.aggregate([
    { $match: todayMatch },
    {
      $group: {
        _id: null,
        todayAmount: { $sum: '$amount' },
        todayTransactions: { $sum: 1 }
      }
    }
  ]);
  
  return success(res, {
    transactions,
    summary: {
      ...(summary[0] || {
        totalAmount: 0,
        totalRevenue: 0,
        totalTransactions: 0,
        successfulTransactions: 0,
        pendingTransactions: 0,
        failedTransactions: 0,
        refundedTransactions: 0,
        byCash: 0,
        byCard: 0,
        byOnline: 0,
        byUpi: 0,
        byWallet: 0,
        amountByCash: 0,
        amountByCard: 0,
        amountByOnline: 0,
        amountByUpi: 0,
        amountByWallet: 0,
        averageAmount: 0
      }),
      ...(todaySummary[0] || {
        todayAmount: 0,
        todayTransactions: 0
      })
    },
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / limit)
    }
  }, 'Transactions retrieved');
});

/**
 * @desc    Get single transaction
 * @route   GET /api/restaurant/cashier/transactions/:id
 * @access  Private (Cashier/Restaurant)
 */
const getTransactionById = asyncHandler(async (req, res) => {
  const branchCustomerOrders = await CustomerOrder.find(legacyRestaurantScope(req)).select('_id').lean();
  const branchLegacyOrders = await Order.find(legacyRestaurantScope(req)).select('_id').lean();
  const transaction = await Transaction.findOne({
    _id: req.params.id,
    restaurant: req.user.restaurantId || req.user.id,
    branchId: req.branchId,
    $or: [
      { customerOrder: { $in: branchCustomerOrders.map((order) => order._id) } },
      { order: { $in: branchLegacyOrders.map((order) => order._id) } },
    ],
  })
    .populate('order')
    .populate('customerOrder')
    .populate('processedBy', 'name');
  
  if (!transaction) {
    return error(res, 'Transaction not found', 404);
  }
  
  return success(res, transaction, 'Transaction retrieved');
});

/**
 * @desc    Refund transaction
 * @route   POST /api/restaurant/cashier/transactions/:id/refund
 * @access  Private (Cashier/Restaurant)
 */
const refundTransaction = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const restaurantId = req.user.restaurantId || req.user.id;
  const [branchCustomerOrders, branchLegacyOrders] = await Promise.all([
    CustomerOrder.find(legacyRestaurantScope(req)).select('_id').lean(),
    Order.find(legacyRestaurantScope(req)).select('_id').lean(),
  ]);
  
  const transaction = await Transaction.findOne({
    _id: req.params.id,
    restaurant: restaurantId,
    branchId: req.branchId,
    $or: [
      { customerOrder: { $in: branchCustomerOrders.map((order) => order._id) } },
      { order: { $in: branchLegacyOrders.map((order) => order._id) } },
    ],
  });
  
  if (!transaction) {
    return error(res, 'Transaction not found', 404);
  }
  
  if (transaction.status === 'refunded') {
    return error(res, 'Transaction already refunded', 400);
  }
  
  if (transaction.status !== 'success') {
    return error(res, 'Can only refund successful transactions', 400);
  }
  
  // Track refund in transaction
  transaction.status = 'refunded';
  transaction.refunded = true;
  transaction.refundAmount = transaction.amount;
  transaction.refundReason = reason || 'Manual refund';
  transaction.refundedAt = new Date();
  transaction.refundedBy = req.user.employeeId || req.user.id;
  
  // Add to status history
  transaction.statusHistory.push({
    status: 'refunded',
    timestamp: new Date(),
    updatedBy: req.user.employeeId || req.user.id,
    note: reason || 'Refunded'
  });
  
  await transaction.save();
  
  // Update order payment status
  if (transaction.customerOrder) {
    const order = await CustomerOrder.findOneAndUpdate(
      { _id: transaction.customerOrder, ...legacyRestaurantScope(req) },
      { paymentStatus: 'failed', paymentMethod: null },
      { new: true }
    );
    
    if (order && Array.isArray(order.statusHistory)) {
      order.statusHistory.push({
        status: order.status,
        timestamp: new Date(),
        updatedBy: req.user.employeeId || req.user.id,
        note: `Payment refunded - ${reason || 'No reason provided'}`
      });
      await order.save();
    }
    
    emitOrderUpdate(restaurantId.toString(), order);
  }
  
  if (transaction.order) {
    const order = await Order.findOneAndUpdate(
      { _id: transaction.order, ...legacyRestaurantScope(req) },
      { status: 'pending' },
      { new: true }
    );
    
    emitOrderUpdate(restaurantId.toString(), order);
  }
  
  emitPaymentUpdate(restaurantId.toString(), {
    _id: transaction._id,
    receiptNo: transaction.receiptNo,
    status: transaction.status,
    refunded: true,
    refundAmount: transaction.refundAmount,
    refundReason: transaction.refundReason,
    refundedAt: transaction.refundedAt
  });

  await writeAuditLog(req, {
    action: 'payment_refunded',
    resource: 'order',
    resourceId: transaction.customerOrder || transaction.order,
    details: {
      restaurantId: String(restaurantId),
      transactionId: String(transaction._id),
      receiptNo: transaction.receiptNo,
      amount: transaction.refundAmount,
      reason: transaction.refundReason,
      message: `Refund processed for receipt ${transaction.receiptNo}`,
    },
  });

  await notificationService.sendNotification({
    recipientType: 'restaurant',
    recipientId: restaurantId,
    category: 'order',
    type: 'refund_processed',
    priority: 'high',
    title: 'Refund processed',
    message: `Refund completed for receipt ${transaction.receiptNo}.`,
    actionUrl: '/notifications',
    metadata: { refundAmount: transaction.refundAmount, reason: transaction.refundReason },
  });
  
  return success(res, transaction, 'Transaction refunded successfully');
});

module.exports = {
  processPayment,
  processCreditPayment,
  getTransactions,
  getTransactionById,
  refundTransaction
};
