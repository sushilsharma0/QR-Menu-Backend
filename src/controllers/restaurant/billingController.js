const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const SubscriptionInvoice = require('../../models/shared/SubscriptionInvoice');
const { success, error } = require('../../utils/apiResponse');

/**
 * @route GET /api/restaurant/billing/invoices
 */
const listMyInvoices = asyncHandler(async (req, res) => {
  const restaurantId = req.user.id;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const skip = (page - 1) * limit;

  const filter = { restaurant: restaurantId };

  const [items, total] = await Promise.all([
    SubscriptionInvoice.find(filter)
      .populate('subscriptionPlan', 'name planType durationLabel price duration')
      .sort({ issuedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    SubscriptionInvoice.countDocuments(filter),
  ]);

  return success(
    res,
    {
      invoices: items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    },
    'Invoices retrieved'
  );
});

/**
 * @route GET /api/restaurant/billing/invoices/:id
 */
const getMyInvoiceById = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return error(res, 'Invalid invoice id', 400);
  }
  const invoice = await SubscriptionInvoice.findOne({
    _id: req.params.id,
    restaurant: req.user.id,
  })
    .populate('subscriptionPlan', 'name planType duration durationLabel price')
    .populate('packageHistory')
    .lean();

  if (!invoice) {
    return error(res, 'Invoice not found', 404);
  }

  return success(res, invoice, 'Invoice retrieved');
});

module.exports = {
  listMyInvoices,
  getMyInvoiceById,
};
