const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const { success, error } = require('../utils/apiResponse');
const resolveRestaurantId = require('../middleware/restaurant/resolveRestaurantId');
const Invoice = require('../models/restaurant/Invoice');
const CustomerOrder = require('../models/restaurant/CustomerOrder');
const { issueInvoiceForOrder } = require('../services/invoiceService');

function authModel(req) {
  return req.user?.scope === 'employee' ? 'Employee' : 'Restaurant';
}

const listInvoices = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const rows = await Invoice.find({ restaurantId: rid }).sort({ issuedAt: -1 }).limit(100);
  return success(res, rows, 'Invoices retrieved');
});

const createInvoiceFromOrder = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  if (!req.body.orderId) return error(res, 'orderId is required', 400);

  const orderLookup = String(req.body.orderId).trim().replace(/^#/, '');
  const orderQuery = mongoose.Types.ObjectId.isValid(orderLookup)
    ? { _id: orderLookup, restaurant: rid }
    : { orderNumber: orderLookup, restaurant: rid };
  const order = await CustomerOrder.findOne(orderQuery);
  if (!order) return error(res, 'Order not found', 404);
  const invoice = await issueInvoiceForOrder({
    restaurantId: rid,
    orderId: order._id,
    generatedBy: req.user.id,
    generatedByModel: authModel(req),
  });
  return success(res, invoice, 'Invoice generated', 201);
});

const getInvoiceById = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const row = await Invoice.findOne({ _id: req.params.id, restaurantId: rid }).populate('orderId');
  if (!row) return error(res, 'Invoice not found', 404);
  return success(res, row, 'Invoice retrieved');
});

const downloadInvoice = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const row = await Invoice.findOne({ _id: req.params.id, restaurantId: rid }).populate('orderId');
  if (!row) return error(res, 'Invoice not found', 404);

  const lines = [
    `Invoice: ${row.invoiceNumber}`,
    `Date: ${new Date(row.issuedAt).toISOString()}`,
    `Customer: ${row.customerName || '-'}`,
    `Subtotal: ${row.subtotal}`,
    `Tax: ${row.tax}`,
    `Service Charge: ${row.serviceCharge}`,
    `Total: ${row.total}`,
    `Payment Method: ${row.paymentMethod}`,
    `Payment Status: ${row.paymentStatus}`,
  ];
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="${row.invoiceNumber}.txt"`);
  return res.send(lines.join('\n'));
});

module.exports = {
  listInvoices,
  createInvoiceFromOrder,
  getInvoiceById,
  downloadInvoice,
};
