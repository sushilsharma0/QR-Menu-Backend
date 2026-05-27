const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const PlatformBillingSettings = require('../../models/platform/PlatformBillingSettings');
const SubscriptionInvoice = require('../../models/shared/SubscriptionInvoice');
const Restaurant = require('../../models/restaurant/Restaurant');
const { success, error } = require('../../utils/apiResponse');
const { readObjectId, readString } = require('../../utils/inputValidation');

const parseNum = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * @route GET /api/platform/billing/settings
 */
const getBillingSettings = asyncHandler(async (req, res) => {
  const settings = await PlatformBillingSettings.getSingleton();
  return success(res, settings, 'Billing settings retrieved');
});

/**
 * @route PATCH /api/platform/billing/settings
 */
const updateBillingSettings = asyncHandler(async (req, res) => {
  const {
    companyLegalName,
    companyAddress,
    taxIdLabel,
    companyTaxId,
    invoicePrefix,
    vatRatePercent,
    pricesAreVatInclusive,
    currencyCode,
    currencySymbol,
  } = req.body;

  const settings = await PlatformBillingSettings.getSingleton();

  if (companyLegalName !== undefined) settings.companyLegalName = String(companyLegalName);
  if (companyAddress !== undefined) settings.companyAddress = String(companyAddress);
  if (taxIdLabel !== undefined) settings.taxIdLabel = String(taxIdLabel);
  if (companyTaxId !== undefined) settings.companyTaxId = String(companyTaxId);
  if (invoicePrefix !== undefined) {
    const p = String(invoicePrefix).trim().slice(0, 20);
    if (p) settings.invoicePrefix = p;
  }
  if (vatRatePercent !== undefined) {
    const r = parseNum(vatRatePercent, settings.vatRatePercent);
    settings.vatRatePercent = Math.max(0, Math.min(100, r));
  }
  if (typeof pricesAreVatInclusive === 'boolean') {
    settings.pricesAreVatInclusive = pricesAreVatInclusive;
  }
  if (currencyCode !== undefined) settings.currencyCode = String(currencyCode).trim().slice(0, 8).toUpperCase();
  if (currencySymbol !== undefined) settings.currencySymbol = String(currencySymbol).slice(0, 8);

  await settings.save();
  return success(res, settings, 'Billing settings updated');
});

/**
 * @route GET /api/platform/billing/invoices
 */
const listInvoices = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const skip = (page - 1) * limit;

  const filter = {};
  const restaurantId = readObjectId(req.query.restaurantId);
  const transactionType = readString(req.query.transactionType, { max: 40 });
  if (restaurantId) filter.restaurant = restaurantId;
  if (transactionType) filter.transactionType = transactionType;
  if (req.query.from || req.query.to) {
    filter.issuedAt = {};
    if (req.query.from) {
      const d = new Date(req.query.from);
      if (!Number.isNaN(d.getTime())) filter.issuedAt.$gte = d;
    }
    if (req.query.to) {
      const d = new Date(req.query.to);
      if (!Number.isNaN(d.getTime())) filter.issuedAt.$lte = d;
    }
  }

  const [items, total] = await Promise.all([
    SubscriptionInvoice.find(filter)
      .populate('restaurant', 'name email slug')
      .populate('subscriptionPlan', 'name planType durationLabel price')
      .sort({ issuedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    SubscriptionInvoice.countDocuments(filter),
  ]);

  return success(res, {
    invoices: items,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  }, 'Invoices retrieved');
});

/**
 * @route GET /api/platform/billing/invoices/:id
 */
const getInvoiceById = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return error(res, 'Invalid invoice id', 400);
  }
  const invoice = await SubscriptionInvoice.findById(req.params.id)
    .populate('restaurant', 'name email phone address city state country pincode slug')
    .populate('subscriptionPlan', 'name planType duration durationLabel price')
    .populate('issuedBy', 'name email')
    .populate('packageHistory')
    .lean();

  if (!invoice) {
    return error(res, 'Invoice not found', 404);
  }

  return success(res, invoice, 'Invoice retrieved');
});

/**
 * Per-restaurant subscription invoice stats (renewals vs total billing events).
 * @route GET /api/platform/billing/stats/by-restaurant
 */
const statsByRestaurant = asyncHandler(async (req, res) => {
  const pipeline = [
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: '$restaurant',
              invoiceCount: { $sum: 1 },
              renewalCount: {
                $sum: { $cond: [{ $eq: ['$transactionType', 'renewed'] }, 1, 0] },
              },
              lastIssuedAt: { $max: '$issuedAt' },
            },
          },
        ],
      },
    },
  ];

  const [facet] = await SubscriptionInvoice.aggregate(pipeline);
  const rows = facet.totals || [];
  const ids = rows.map((r) => r._id).filter(Boolean);
  const restaurants = await Restaurant.find({ _id: { $in: ids } })
    .select('name email slug')
    .lean();
  const byId = Object.fromEntries(restaurants.map((r) => [String(r._id), r]));

  const summary = rows.map((r) => ({
    restaurantId: r._id,
    restaurant: byId[String(r._id)] || null,
    invoiceCount: r.invoiceCount,
    renewalCount: r.renewalCount,
    lastIssuedAt: r.lastIssuedAt,
  }));

  summary.sort((a, b) => (b.lastIssuedAt || 0) - (a.lastIssuedAt || 0));

  return success(res, { summary }, 'Billing stats retrieved');
});

/**
 * Subscription billing activity (list + totals) for date range — compliance / ops.
 * @route GET /api/platform/billing/activity-report
 */
const getSubscriptionActivityReport = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const skip = (page - 1) * limit;

  const filter = {};
  const restaurantId = readObjectId(req.query.restaurantId);
  const transactionType = readString(req.query.transactionType, { max: 40 });
  if (restaurantId) filter.restaurant = restaurantId;
  if (transactionType) filter.transactionType = transactionType;
  if (req.query.from || req.query.to) {
    filter.issuedAt = {};
    if (req.query.from) {
      const d = new Date(req.query.from);
      if (!Number.isNaN(d.getTime())) filter.issuedAt.$gte = d;
    }
    if (req.query.to) {
      const d = new Date(req.query.to);
      if (!Number.isNaN(d.getTime())) {
        d.setHours(23, 59, 59, 999);
        filter.issuedAt.$lte = d;
      }
    }
  }

  const [items, total, agg] = await Promise.all([
    SubscriptionInvoice.find(filter)
      .populate('restaurant', 'name email slug')
      .populate('subscriptionPlan', 'name planType duration durationLabel price priceExclVat')
      .sort({ issuedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    SubscriptionInvoice.countDocuments(filter),
    SubscriptionInvoice.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          invoiceCount: { $sum: 1 },
          subtotalExclVat: { $sum: '$subtotalExclVat' },
          vatAmount: { $sum: '$vatAmount' },
          totalInclVat: { $sum: '$totalInclVat' },
        },
      },
    ]),
  ]);

  const summary = agg[0] || {
    invoiceCount: 0,
    subtotalExclVat: 0,
    vatAmount: 0,
    totalInclVat: 0,
  };

  const rows = items.map((inv) => {
    const sym = inv.issuerSnapshot?.currencySymbol || 'Rs.';
    const plan = inv.subscriptionPlan;
    return {
      invoiceId: inv._id,
      invoiceNumber: inv.invoiceNumber,
      issuedAt: inv.issuedAt,
      transactionType: inv.transactionType,
      restaurant: inv.restaurant,
      planName: plan?.name,
      planType: plan?.planType,
      durationDays: plan?.duration,
      durationLabel: plan?.durationLabel,
      planCatalogPriceExclVat: plan?.priceExclVat,
      planCatalogTotal: plan?.price,
      currencySymbol: sym,
      actualAmountExclVat: inv.subtotalExclVat,
      taxAmount: inv.vatAmount,
      grandTotal: inv.totalInclVat,
      vatRateApplied: inv.vatRateApplied,
    };
  });

  return success(
    res,
    {
      rows,
      summary,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    },
    'Subscription activity report retrieved'
  );
});

module.exports = {
  getBillingSettings,
  updateBillingSettings,
  listInvoices,
  getInvoiceById,
  statsByRestaurant,
  getSubscriptionActivityReport,
};
