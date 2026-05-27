const Invoice = require('../models/restaurant/Invoice');
const CustomerOrder = require('../models/restaurant/CustomerOrder');
const TaxSettings = require('../models/restaurant/TaxSettings');

function round2(v) {
  return Math.round(Number(v || 0) * 100) / 100;
}

async function allocateInvoiceNumber(restaurantId) {
  const yyyy = new Date().getFullYear();
  const mm = String(new Date().getMonth() + 1).padStart(2, '0');
  const count = await Invoice.countDocuments({ restaurantId });
  return `INV-${yyyy}${mm}-${String(count + 1).padStart(5, '0')}`;
}

async function issueInvoiceForOrder({ restaurantId, orderId, generatedBy, generatedByModel }) {
  const existing = await Invoice.findOne({ restaurantId, orderId });
  if (existing) return existing;

  const order = await CustomerOrder.findOne({ _id: orderId, restaurant: restaurantId }).select(
    'grandTotal totalAmount taxAmount paymentStatus paymentMethod customerName',
  );
  if (!order) throw new Error('Order not found');

  const tax = await TaxSettings.getForRestaurant(restaurantId);
  const subtotal = round2(order.totalAmount || order.grandTotal || 0);
  const taxAmount = round2(order.taxAmount || (subtotal * (Number(tax.vatRate || 0) / 100)));
  const serviceCharge = round2(subtotal * (Number(tax.serviceChargeRate || 0) / 100));
  const total = round2(order.grandTotal || subtotal + taxAmount + serviceCharge);

  const invoice = await Invoice.create({
    restaurantId,
    invoiceNumber: await allocateInvoiceNumber(restaurantId),
    orderId,
    customerName: order.customerName || '',
    subtotal,
    tax: taxAmount,
    serviceCharge,
    total,
    paymentStatus: order.paymentStatus === 'paid' ? 'paid' : 'pending',
    paymentMethod: order.paymentMethod || 'cash',
    generatedBy,
    generatedByModel,
    lockedAt: new Date(),
  });
  return invoice;
}

const PlatformBillingSettings = require('../models/platform/PlatformBillingSettings');
const SubscriptionInvoice = require('../models/shared/SubscriptionInvoice');
const PackageHistory = require('../models/shared/PackageHistory');

const roundMoney = (n) => Math.round(Number(n) * 100) / 100;

function vatBreakdownIncl(totalInclVat, vatRatePercent) {
  const rate = Number(vatRatePercent) || 0;
  if (rate <= 0) {
    return {
      subtotalExclVat: roundMoney(totalInclVat),
      vatAmount: 0,
      totalInclVat: roundMoney(totalInclVat),
    };
  }
  const total = roundMoney(totalInclVat);
  const subtotalExclVat = roundMoney(total / (1 + rate / 100));
  const vatAmount = roundMoney(total - subtotalExclVat);
  return { subtotalExclVat, vatAmount, totalInclVat: total };
}

function vatBreakdownExcl(subtotalExcl, vatRatePercent) {
  const rate = Number(vatRatePercent) || 0;
  const sub = roundMoney(subtotalExcl);
  const vatAmount = rate > 0 ? roundMoney((sub * rate) / 100) : 0;
  return {
    subtotalExclVat: sub,
    vatAmount,
    totalInclVat: roundMoney(sub + vatAmount),
  };
}

async function allocateSubscriptionInvoiceNumber() {
  const updated = await PlatformBillingSettings.findByIdAndUpdate(
    'global',
    { $inc: { invoiceSequence: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  const prefix = (updated.invoicePrefix || 'INV').replace(/[^A-Za-z0-9-]/g, '');
  const seq = updated.invoiceSequence || 1;
  return `${prefix}-${String(seq).padStart(6, '0')}`;
}

function buildLineDescription(plan) {
  const label = plan.durationLabel || `${plan.duration} days`;
  return `${plan.name} — ${label}`;
}

class InvoiceService {
  /**
   * Create a compliance invoice for a package history row (plan assignment / renewal / upgrade).
   */
  async issueForPackageHistory({ history, restaurant, plan, approvedBy }) {
    if (!history?._id || !restaurant?._id || !plan?._id) {
      throw new Error('issueForPackageHistory: missing history, restaurant, or plan');
    }

    const existing = await SubscriptionInvoice.findOne({ packageHistory: history._id });
    if (existing) {
      return existing;
    }

    const settings = await PlatformBillingSettings.getSingleton();
    const vatRate = Number(settings.vatRatePercent);
    const gross = roundMoney(history.amount);

    let subtotalExclVat;
    let vatAmount;
    let totalInclVat;
    let pricesAreVatInclusive;
    let lineItems;

    const planExcl =
      plan.priceExclVat != null && plan.priceExclVat !== ''
        ? roundMoney(plan.priceExclVat)
        : null;

    const invoiceNumber = await allocateSubscriptionInvoiceNumber();
    const baseDescription = buildLineDescription(plan);
    const taxLabel = settings.taxIdLabel || 'VAT';

    if (planExcl != null) {
      subtotalExclVat = planExcl;
      totalInclVat = gross;
      vatAmount = roundMoney(totalInclVat - subtotalExclVat);
      if (vatAmount < 0) {
        ({ subtotalExclVat, vatAmount, totalInclVat } = vatBreakdownIncl(gross, vatRate));
      }
      pricesAreVatInclusive = false;
      lineItems = [
        {
          description: `${baseDescription} — subtotal (excl. ${taxLabel})`,
          quantity: 1,
          unitPriceInclVat: subtotalExclVat,
          lineTotalInclVat: subtotalExclVat,
        },
        {
          description: `${taxLabel} (${vatRate.toFixed(2)}%)`,
          quantity: 1,
          unitPriceInclVat: vatAmount,
          lineTotalInclVat: vatAmount,
        },
      ];
    } else {
      pricesAreVatInclusive = settings.pricesAreVatInclusive !== false;
      if (pricesAreVatInclusive) {
        ({ subtotalExclVat, vatAmount, totalInclVat } = vatBreakdownIncl(gross, vatRate));
      } else {
        ({ subtotalExclVat, vatAmount, totalInclVat } = vatBreakdownExcl(gross, vatRate));
      }
      lineItems = [
        {
          description: baseDescription,
          quantity: 1,
          unitPriceInclVat: totalInclVat,
          lineTotalInclVat: totalInclVat,
        },
      ];
    }

    const customerSnapshot = {
      name: restaurant.name,
      email: restaurant.email,
      phone: restaurant.phone,
      address: restaurant.address,
      city: restaurant.city,
      state: restaurant.state,
      country: restaurant.country,
      pincode: restaurant.pincode,
    };

    const issuerSnapshot = {
      companyLegalName: settings.companyLegalName,
      companyAddress: settings.companyAddress,
      taxIdLabel: settings.taxIdLabel,
      companyTaxId: settings.companyTaxId,
      vatRatePercent: vatRate,
      pricesAreVatInclusive,
      currencyCode: settings.currencyCode,
      currencySymbol: settings.currencySymbol,
    };

    const invoice = await SubscriptionInvoice.create({
      invoiceNumber,
      restaurant: restaurant._id,
      subscriptionPlan: plan._id,
      packageHistory: history._id,
      lineItems,
      subtotalExclVat,
      vatRateApplied: vatRate,
      vatAmount,
      totalInclVat,
      transactionType: history.action,
      paymentMethod: history.paymentMethod || 'offline',
      billingPeriodStart: history.startDate,
      billingPeriodEnd: history.endDate,
      issuedAt: new Date(),
      issuedBy: approvedBy || undefined,
      customerSnapshot,
      issuerSnapshot,
    });

    await PackageHistory.updateOne({ _id: history._id }, { invoice: invoice._id });

    return invoice;
  }
}

module.exports = {
  roundMoney,
  vatBreakdownIncl,
  vatBreakdownExcl,
  issueInvoiceForOrder,
  InvoiceService: new InvoiceService(),
};
