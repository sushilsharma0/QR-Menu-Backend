const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const Restaurant = require('../models/restaurant/Restaurant');
const Subscription = require('../models/shared/Subscription');
const SubscriptionPayment = require('../models/shared/SubscriptionPayment');
const Platform = require('../models/platform/Platform');
const AuditLog = require('../models/platform/AuditLog');
const subscriptionService = require('../services/subscriptionService');
const notificationService = require('../services/notificationService');
const emailService = require('../services/emailService');
const esewaService = require('../services/esewaService');
const khaltiService = require('../services/khaltiService');
const { success, error } = require('../utils/apiResponse');
const { mongoOrForBillingAdminsNotifications } = require('../constants/platformPermissions');

const makeTransactionId = (method) =>
  `${method.toUpperCase()}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;

const notifyPlatformAdmins = async ({ title, message, payment }) => {
  const admins = await Platform.find({
    isActive: true,
    $or: mongoOrForBillingAdminsNotifications(),
  }).select('_id');

  await notificationService.sendBulkNotifications(
    admins.map((admin) => ({
      recipientType: 'platform',
      recipientId: admin._id,
      category: 'subscription',
      type: 'subscription_payment',
      priority: 'high',
      title,
      message,
      actionUrl: '/platform/subscription-payments',
      relatedEntity: { entityType: 'SubscriptionPayment', entityId: payment._id },
      metadata: { paymentId: String(payment._id), transactionId: payment.transactionId },
    })),
  );
};

const notifyRestaurant = async ({ restaurant, title, message, payment, priority = 'medium' }) =>
  notificationService.sendNotification({
    recipientType: 'restaurant',
    recipientId: restaurant._id,
    category: 'subscription',
    type: 'subscription_payment',
    priority,
    title,
    message,
    actionUrl: '/notifications',
    relatedEntity: { entityType: 'SubscriptionPayment', entityId: payment._id },
    metadata: { paymentId: String(payment._id), transactionId: payment.transactionId },
  });

const sendPaymentEmail = async ({ restaurant, subject, title, message, payment, plan }) => {
  if (emailService.sendSubscriptionPaymentEmail) {
    await emailService.sendSubscriptionPaymentEmail(restaurant.email, restaurant.name, {
      subject,
      title,
      message,
      planName: plan?.name,
      amount: payment.amount,
      transactionId: payment.transactionId,
      status: payment.status,
    });
  }
};

const preparePayment = async ({ restaurantId, planId, method }) => {
  if (!planId) {
    const err = new Error('planId is required');
    err.statusCode = 400;
    throw err;
  }

  const [restaurant, plan] = await Promise.all([
    Restaurant.findById(restaurantId),
    Subscription.findById(planId),
  ]);

  if (!restaurant) {
    const err = new Error('Restaurant not found');
    err.statusCode = 404;
    throw err;
  }
  if (!plan || !plan.isActive) {
    const err = new Error('Selected plan is not available');
    err.statusCode = 400;
    throw err;
  }
  if (!restaurant.isKYCVerified) {
    const err = new Error('KYC verification is required before selecting or purchasing a subscription plan.');
    err.statusCode = 403;
    throw err;
  }
  if (restaurant.currentPlan && String(restaurant.currentPlan) === String(plan._id) && restaurant.hasPaidPlanActive()) {
    const err = new Error('You are already using this plan.');
    err.statusCode = 400;
    throw err;
  }

  const existing = await SubscriptionPayment.findOne({
    restaurantId,
    planId,
    status: { $in: ['paid', 'pending_verification'] },
  });
  if (existing) {
    const err = new Error('A successful payment for this plan is already pending verification.');
    err.statusCode = 409;
    throw err;
  }

  await SubscriptionPayment.updateMany(
    { restaurantId, planId, status: 'pending' },
    {
      $set: {
        status: 'failed',
        adminNote: 'Checkout was replaced before gateway verification completed.',
      },
    },
  );

  const transactionId = makeTransactionId(method);
  const payment = await SubscriptionPayment.create({
    restaurantId,
    planId,
    amount: plan.price,
    paymentMethod: method,
    transactionId,
    status: 'pending',
    paymentGatewayData: { initiatedAt: new Date() },
  });

  restaurant.requestedPlan = plan._id;
  restaurant.planRequestDate = new Date();
  restaurant.planRequestStatus = 'awaiting_proof';
  restaurant.planPaymentProofPath = undefined;
  restaurant.planRequestRejectionReason = undefined;
  await restaurant.save();

  return { restaurant, plan, payment };
};

const initiateEsewaPayment = asyncHandler(async (req, res) => {
  try {
    const { restaurant, plan, payment } = await preparePayment({
      restaurantId: req.user.id,
      planId: req.body.planId,
      method: 'esewa',
    });

    let gateway;
    try {
      gateway = esewaService.createPaymentPayload({
        amount: payment.amount,
        transactionId: payment.transactionId,
      });
    } catch (gatewayErr) {
      payment.status = 'failed';
      payment.adminNote = `eSewa payload generation failed: ${gatewayErr.message}`;
      await payment.save();
      throw gatewayErr;
    }

    payment.paymentGatewayData = { ...payment.paymentGatewayData, requestPayload: gateway.payload };
    await payment.save();

    await notifyRestaurant({
      restaurant,
      payment,
      title: 'Payment started',
      message: `Your eSewa payment for ${plan.name} has been created.`,
    });

    return success(res, { payment, gateway }, 'eSewa payment payload generated', 201);
  } catch (err) {
    return error(res, err.message || 'Failed to initiate eSewa payment', err.statusCode || 500);
  }
});

const initiateKhaltiPayment = asyncHandler(async (req, res) => {
  try {
    const { restaurant, plan, payment } = await preparePayment({
      restaurantId: req.user.id,
      planId: req.body.planId,
      method: 'khalti',
    });

    let gateway;
    try {
      gateway = await khaltiService.initiatePayment({
        amount: payment.amount,
        transactionId: payment.transactionId,
        planName: plan.name,
        restaurant,
      });
    } catch (gatewayErr) {
      payment.status = 'failed';
      payment.adminNote = `Khalti initiation failed: ${gatewayErr.message}`;
      payment.paymentGatewayData = {
        ...(payment.paymentGatewayData || {}),
        initiateError: gatewayErr.gatewayData || { message: gatewayErr.message },
      };
      await payment.save();
      throw gatewayErr;
    }

    payment.gatewayReference = gateway.pidx;
    payment.paymentGatewayData = { ...payment.paymentGatewayData, initiateResponse: gateway };
    await payment.save();

    await notifyRestaurant({
      restaurant,
      payment,
      title: 'Payment started',
      message: `Your Khalti payment for ${plan.name} has been created.`,
    });

    return success(res, { payment, gateway }, 'Khalti payment initiated', 201);
  } catch (err) {
    return error(
      res,
      err.message || 'Failed to initiate Khalti payment',
      err.statusCode || 500,
      err.gatewayData,
    );
  }
});

const initiateManualPayment = asyncHandler(async (req, res) => {
  try {
    const { referenceId = '', note = '' } = req.body;
    const trimmedReferenceId = String(referenceId || '').trim();
    if (!trimmedReferenceId) {
      return error(res, 'Statement reference ID is required for manual payment', 400);
    }
    if (!req.file?.path) {
      return error(res, 'Payment proof file is required for manual payment', 400);
    }

    const { restaurant, plan, payment } = await preparePayment({
      restaurantId: req.user.id,
      planId: req.body.planId,
      method: 'manual',
    });

    await markPaymentReadyForReview({
      payment,
      restaurant,
      plan,
      gatewayData: {
        manualSubmission: {
          referenceId: trimmedReferenceId,
          note: String(note || '').trim(),
          submittedAt: new Date(),
        },
      },
      gatewayReference: trimmedReferenceId || undefined,
    });

    payment.screenshot = req.file.path;
    await payment.save();

    restaurant.planPaymentProofPath = req.file.path;
    restaurant.planPaymentReferenceId = trimmedReferenceId;
    await restaurant.save();

    return success(
      res,
      { payment },
      'Manual payment submitted. It is now pending platform verification.',
      201,
    );
  } catch (err) {
    return error(res, err.message || 'Failed to submit manual payment', err.statusCode || 500);
  }
});

const markPaymentReadyForReview = async ({ payment, restaurant, plan, gatewayData, gatewayReference }) => {
  payment.status = 'pending_verification';
  if (gatewayReference) payment.gatewayReference = gatewayReference;
  payment.paymentGatewayData = {
    ...(payment.paymentGatewayData || {}),
    ...gatewayData,
    verifiedAtGateway: new Date(),
  };
  await payment.save();

  restaurant.requestedPlan = plan._id;
  restaurant.planRequestDate = new Date();
  restaurant.planRequestStatus = 'pending_review';
  restaurant.planPaymentProofPath = payment.screenshot || undefined;
  restaurant.planRequestRejectionReason = undefined;
  await restaurant.save();

  await Promise.all([
    notifyRestaurant({
      restaurant,
      payment,
      title: 'Payment submitted',
      message: `Your payment for ${plan.name} is awaiting platform verification.`,
      priority: 'high',
    }),
    notifyPlatformAdmins({
      payment,
      title: 'New subscription payment',
      message: `${restaurant.name} submitted a ${payment.paymentMethod} payment for ${plan.name}.`,
    }),
    sendPaymentEmail({
      restaurant,
      payment,
      plan,
      subject: 'Subscription payment received',
      title: 'Payment received for verification',
      message: 'Your payment was verified by the gateway and is now waiting for platform approval.',
    }),
  ]);
};

const markPaymentFailed = async ({ payment, restaurant, gatewayData, adminNote }) => {
  payment.status = 'failed';
  payment.adminNote = adminNote || 'Payment was cancelled or failed at the gateway.';
  payment.paymentGatewayData = {
    ...(payment.paymentGatewayData || {}),
    ...gatewayData,
    failedAt: new Date(),
  };
  await payment.save();

  const activePaymentForPlan = await SubscriptionPayment.findOne({
    _id: { $ne: payment._id },
    restaurantId: payment.restaurantId,
    planId: payment.planId,
    status: { $in: ['pending', 'paid', 'pending_verification'] },
  });

  if (
    restaurant &&
    !activePaymentForPlan &&
    restaurant.requestedPlan &&
    String(restaurant.requestedPlan) === String(payment.planId)
  ) {
    restaurant.requestedPlan = null;
    restaurant.planRequestDate = null;
    restaurant.planRequestStatus = 'none';
    restaurant.planPaymentProofPath = undefined;
    restaurant.planRequestRejectionReason = undefined;
    await restaurant.save();
  }

  return payment;
};

const verifyEsewaPayment = asyncHandler(async (req, res) => {
  try {
    const callbackData = req.body.data
      ? esewaService.decodeCallbackData(req.body.data)
      : req.body;

    if (!callbackData || !callbackData.transaction_uuid) {
      return error(res, 'Missing eSewa callback data', 400);
    }
    if (!esewaService.verifyCallbackSignature(callbackData)) {
      return error(res, 'Invalid eSewa callback signature', 400);
    }

    const transactionId = callbackData.transaction_uuid;
    const payment = await SubscriptionPayment.findOne({ transactionId, paymentMethod: 'esewa' });
    if (!payment) return error(res, 'Payment record not found', 404);
    if (['approved', 'pending_verification'].includes(payment.status)) {
      return success(res, payment, 'Payment already processed');
    }

    const [restaurant, plan] = await Promise.all([
      Restaurant.findById(payment.restaurantId),
      Subscription.findById(payment.planId),
    ]);
    if (!restaurant || !plan) return error(res, 'Restaurant or plan not found', 404);

    const verification = await esewaService.verifyTransaction({
      transactionId,
      totalAmount: payment.amount,
    });

    const completed = ['COMPLETE', 'COMPLETED', 'SUCCESS'].includes(
      String(verification.status || callbackData.status || '').toUpperCase(),
    );
    if (!completed) {
      await markPaymentFailed({
        payment,
        restaurant,
        gatewayData: { callbackData, verification },
        adminNote: 'eSewa payment was cancelled or not completed.',
      });
      return error(res, 'eSewa payment is not complete', 400, { status: verification.status });
    }

    await markPaymentReadyForReview({
      payment,
      restaurant,
      plan,
      gatewayData: { callbackData, verification },
      gatewayReference: callbackData.transaction_code,
    });

    return success(res, payment, 'eSewa payment verified and submitted for approval');
  } catch (err) {
    return error(res, err.message || 'Failed to verify eSewa payment', err.statusCode || 500, err.gatewayData);
  }
});

const cancelEsewaPayment = asyncHandler(async (req, res) => {
  try {
    const { transaction_uuid: transactionId, cancel_token: cancelToken } = req.body;
    if (!esewaService.verifyCancelToken(transactionId, cancelToken)) {
      return error(res, 'Invalid eSewa cancellation token', 400);
    }

    const payment = await SubscriptionPayment.findOne({ transactionId, paymentMethod: 'esewa' });
    if (!payment) return error(res, 'Payment record not found', 404);
    if (['approved', 'pending_verification'].includes(payment.status)) {
      return success(res, payment, 'Payment already processed');
    }

    const restaurant = await Restaurant.findById(payment.restaurantId);
    await markPaymentFailed({
      payment,
      restaurant,
      gatewayData: { failureCallback: req.body },
      adminNote: 'eSewa payment was cancelled before completion.',
    });

    return success(res, payment, 'eSewa payment cancelled');
  } catch (err) {
    return error(res, err.message || 'Failed to cancel eSewa payment', err.statusCode || 500);
  }
});

const verifyKhaltiPayment = asyncHandler(async (req, res) => {
  try {
    const { pidx, purchase_order_id: purchaseOrderId } = req.body;
    if (!pidx) return error(res, 'pidx is required', 400);

    const orFilters = [{ gatewayReference: pidx }];
    if (purchaseOrderId) orFilters.push({ transactionId: purchaseOrderId });

    const payment = await SubscriptionPayment.findOne({
      $or: orFilters,
      paymentMethod: 'khalti',
    });
    if (!payment) return error(res, 'Payment record not found', 404);
    if (['approved', 'pending_verification'].includes(payment.status)) {
      return success(res, payment, 'Payment already processed');
    }

    const lookup = await khaltiService.lookupPayment(pidx);
    const expectedAmount = khaltiService.toPaisa(payment.amount);
    const [restaurant, plan] = await Promise.all([
      Restaurant.findById(payment.restaurantId),
      Subscription.findById(payment.planId),
    ]);
    if (!restaurant || !plan) return error(res, 'Restaurant or plan not found', 404);

    const lookupStatus = String(lookup.status || '');
    const amountMatches = Number(lookup.total_amount) === expectedAmount;

    if (lookupStatus !== 'Completed' || !amountMatches) {
      const stillPending = ['Pending', 'Initiated'].includes(lookupStatus);
      const cancelledOrFailed = ['User canceled', 'Refunded', 'Expired', 'Failed'].includes(lookupStatus);

      if (stillPending) {
        payment.status = 'pending';
        payment.paymentGatewayData = { ...(payment.paymentGatewayData || {}), callback: req.body, lookup };
        await payment.save();
        return error(res, `Khalti payment is still ${lookupStatus.toLowerCase()}.`, 400, {
          status: lookupStatus,
        });
      }

      const note = !amountMatches && lookupStatus === 'Completed'
        ? `Khalti amount mismatch (expected ${expectedAmount}, got ${lookup.total_amount}).`
        : cancelledOrFailed
          ? `Khalti payment ${lookupStatus.toLowerCase()}.`
          : 'Khalti payment was cancelled or not completed.';

      await markPaymentFailed({
        payment,
        restaurant,
        gatewayData: { callback: req.body, lookup },
        adminNote: note,
      });
      return error(res, note, 400, { status: lookupStatus });
    }

    await markPaymentReadyForReview({
      payment,
      restaurant,
      plan,
      gatewayData: { callback: req.body, lookup },
      gatewayReference: lookup.pidx,
    });

    return success(res, payment, 'Khalti payment verified and submitted for approval');
  } catch (err) {
    return error(res, err.message || 'Failed to verify Khalti payment', err.statusCode || 500, err.gatewayData);
  }
});

const getRestaurantPayments = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const [payments, total] = await Promise.all([
    SubscriptionPayment.find({ restaurantId: req.user.id })
      .populate('planId', 'name duration durationLabel price')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    SubscriptionPayment.countDocuments({ restaurantId: req.user.id }),
  ]);

  return success(res, {
    payments,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      pages: Math.ceil(total / Number(limit)),
    },
  }, 'Subscription payments retrieved');
});

const getPlatformPayments = asyncHandler(async (req, res) => {
  const { status, method, page = 1, limit = 30 } = req.query;
  const query = {};
  if (status === 'review_queue' || !status) {
    query.status = { $in: ['paid', 'pending_verification'] };
  } else if (status !== 'all') {
    query.status = status;
  }
  if (method && method !== 'all') query.paymentMethod = method;

  const skip = (Number(page) - 1) * Number(limit);
  const [payments, total] = await Promise.all([
    SubscriptionPayment.find(query)
      .populate('restaurantId', 'name email phone slug')
      .populate('planId', 'name duration durationLabel price')
      .populate('verifiedBy', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    SubscriptionPayment.countDocuments(query),
  ]);

  return success(res, {
    payments,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      pages: Math.ceil(total / Number(limit)),
    },
  }, 'Subscription payments retrieved');
});

const approvePayment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { adminNote = '' } = req.body;
  const payment = await SubscriptionPayment.findById(id);
  if (!payment) return error(res, 'Payment not found', 404);
  if (!['paid', 'pending_verification'].includes(payment.status)) {
    return error(res, 'Only gateway-verified payments can be approved', 400);
  }

  const [restaurant, plan] = await Promise.all([
    Restaurant.findById(payment.restaurantId),
    Subscription.findById(payment.planId),
  ]);
  if (!restaurant || !plan) return error(res, 'Restaurant or plan not found', 404);

  const result = await subscriptionService.assignPlan(
    payment.restaurantId,
    payment.planId,
    req.user.id,
    adminNote || `Approved ${payment.paymentMethod} payment ${payment.transactionId}`,
    { paymentMethod: 'online', paymentId: payment._id },
  );

  payment.status = 'approved';
  payment.adminNote = adminNote;
  payment.verifiedBy = req.user.id;
  payment.verifiedAt = new Date();
  await payment.save();

  await Promise.all([
    AuditLog.create({
      user: req.user.id,
      userModel: 'Platform',
      action: 'subscription_payment_approve',
      resource: 'plan',
      resourceId: payment.planId,
      details: {
        paymentId: payment._id,
        transactionId: payment.transactionId,
        restaurantId: payment.restaurantId,
        planId: payment.planId,
      },
      ipAddress: req.ip,
    }),
    notifyRestaurant({
      restaurant,
      payment,
      title: 'Payment approved',
      message: `${plan.name} is active until ${new Date(result.planEndDate).toLocaleDateString()}.`,
      priority: 'high',
    }),
    notificationService.sendNotification({
      recipientType: 'restaurant',
      recipientId: restaurant._id,
      category: 'subscription',
      type: 'subscription_activated',
      priority: 'high',
      title: 'Subscription activated',
      message: `Your ${plan.name} subscription is now active.`,
      actionUrl: '/notifications',
      relatedEntity: { entityType: 'SubscriptionPayment', entityId: payment._id },
    }),
    sendPaymentEmail({
      restaurant,
      payment,
      plan,
      subject: 'Subscription activated',
      title: 'Your subscription is active',
      message: `${plan.name} has been activated for your restaurant.`,
    }),
  ]);

  return success(res, { payment, expiresAt: result.planEndDate }, 'Payment approved and plan activated');
});

const rejectPayment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { adminNote = 'Payment rejected by platform admin' } = req.body;
  const payment = await SubscriptionPayment.findById(id);
  if (!payment) return error(res, 'Payment not found', 404);
  if (!['pending', 'paid', 'pending_verification'].includes(payment.status)) {
    return error(res, 'This payment cannot be rejected', 400);
  }

  const [restaurant, plan] = await Promise.all([
    Restaurant.findById(payment.restaurantId),
    Subscription.findById(payment.planId),
  ]);
  if (!restaurant || !plan) return error(res, 'Restaurant or plan not found', 404);

  payment.status = 'rejected';
  payment.adminNote = adminNote;
  payment.verifiedBy = req.user.id;
  payment.verifiedAt = new Date();
  await payment.save();

  if (restaurant.requestedPlan && String(restaurant.requestedPlan) === String(payment.planId)) {
    restaurant.requestedPlan = null;
    restaurant.planRequestDate = null;
    restaurant.planRequestStatus = 'rejected';
    restaurant.planRequestRejectionReason = adminNote;
    await restaurant.save();
  }

  await Promise.all([
    AuditLog.create({
      user: req.user.id,
      userModel: 'Platform',
      action: 'subscription_payment_reject',
      resource: 'plan',
      resourceId: payment.planId,
      details: {
        paymentId: payment._id,
        transactionId: payment.transactionId,
        reason: adminNote,
      },
      ipAddress: req.ip,
    }),
    notifyRestaurant({
      restaurant,
      payment,
      title: 'Payment rejected',
      message: adminNote,
      priority: 'high',
    }),
    sendPaymentEmail({
      restaurant,
      payment,
      plan,
      subject: 'Subscription payment rejected',
      title: 'Payment could not be approved',
      message: adminNote,
    }),
  ]);

  return success(res, payment, 'Payment rejected');
});

module.exports = {
  initiateEsewaPayment,
  initiateKhaltiPayment,
  initiateManualPayment,
  verifyEsewaPayment,
  cancelEsewaPayment,
  verifyKhaltiPayment,
  getRestaurantPayments,
  getPlatformPayments,
  approvePayment,
  rejectPayment,
};
