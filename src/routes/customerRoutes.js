const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const CustomerOrder = require('../models/restaurant/CustomerOrder');
const Table = require('../models/restaurant/Table');
const MenuItem = require('../models/restaurant/MenuItem');
const Transaction = require('../models/restaurant/Transaction');
const POSOrder = require('../models/restaurant/POSOrder');
const Promotion = require('../models/restaurant/Promotion');
const Restaurant = require('../models/restaurant/Restaurant');
const Branch = require('../models/restaurant/Branch');
const Employee = require('../models/restaurant/Employee');
const Guest = require('../models/customer/Guest');
const CustomerIdentity = require('../models/customer/CustomerIdentity');
const CustomerIdentityOtp = require('../models/customer/CustomerIdentityOtp');
const CustomerCart = require('../models/customer/CustomerCart');
const CustomerFeedback = require('../models/customer/CustomerFeedback');
const PlatformSiteSettings = require('./../models/platform/PlatformSiteSettings');
const { generateRandomToken, generateOTP } = require('../utils/generateToken');
const { emitGuestTableRequest, emitOrderUpdate, emitPaymentUpdate } = require('../services/socketService');
const { createNewOrderNotifications } = require('../services/notifications/orderNotificationService');
const notificationService = require('../services/notificationService');
const GuestLoyalty = require('../models/customer/GuestLoyalty');
const GuestTableRequest = require('../models/customer/GuestTableRequest');
const { success, error } = require('../utils/apiResponse');
const { getPublicLandingSiteConfig } = require('../controllers/platform/settingsController');
const { validatePromo } = require('../services/promotionService');
const { branchMenuItemBaseFilter, resolveCustomerMenuBranchId } = require('../services/branchService');
const crypto = require('crypto');
const RestaurantCreditCustomer = require('../models/restaurant/RestaurantCreditCustomer');
const CreditCheckoutOtp = require('../models/customer/CreditCheckoutOtp');
const {
  sendOrderConfirmationEmail,
  sendCreditCheckoutOtpEmail,
  sendCustomerIdentityOtpEmail,
  sendCreditBillEmail,
} = require('../services/emailService');
const { sendOrderReceivedSms } = require('../services/smsService');
const { calculateLoyaltyPoints } = require('../services/loyaltyService');
const { ensureSalesReportForOrder } = require('../services/salesReportService');
const { applyRecipeDeductionForCompletedOrder } = require('../services/recipeInventoryService');
const validatePassword = require('../utils/validatePassword');
const { passwordResetLimiter, strictLimiter } = require('../middleware/rateLimiter');
const { hashToken, resolveTableFromQrToken } = require('../services/qrService');
const {
  buildOrderLineFromMenuItem,
  calculateMenuItemPrice,
  decrementVariationStockForOrderItems,
  roundMoney,
} = require('../services/variationService');

const generateGuestId = () => `GST-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
const generateCustomerId = () => `CUS-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
const generateGuestSessionToken = () => crypto.randomBytes(32).toString('base64url');
const GUEST_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const normalizeDeviceInfo = (deviceInfo = {}) => ({
  userAgent: String(deviceInfo.userAgent || ''),
  platform: String(deviceInfo.platform || ''),
  language: String(deviceInfo.language || ''),
  timezone: String(deviceInfo.timezone || ''),
});

const computeCartTotal = (items = []) =>
  roundMoney(items.reduce((sum, item) => {
    if (item.priceSnapshot?.lineSubtotal != null) return sum + Number(item.priceSnapshot.lineSubtotal || 0);
    return sum + Number(item.price || 0) * Number(item.quantity || 0);
  }, 0));
const MAX_ORDER_ITEM_QUANTITY = 50;
const MAX_ORDER_LINES = 100;

const getServiceChargeAmount = (restaurant, subtotal) =>
  roundMoney((Number(subtotal || 0) * Number(restaurant?.settings?.serviceChargePercent || 0)) / 100);

const getNextBatchNumber = (order) => Math.max(0, ...(order.itemBatches || []).map((batch) => Number(batch.batchNumber || 0))) + 1;
const ORDER_EDIT_WINDOW_MS = 5 * 60 * 1000;

const getOrderEditMeta = (order) => {
  if (!order?.createdAt) return { canEdit: false, editDeadline: null, editSecondsRemaining: 0 };
  const editDeadline = new Date(new Date(order.createdAt).getTime() + ORDER_EDIT_WINDOW_MS);
  const editSecondsRemaining = Math.max(0, Math.floor((editDeadline.getTime() - Date.now()) / 1000));
  const canEdit =
    editSecondsRemaining > 0 &&
    ['pending', 'confirmed'].includes(order.status) &&
    order.paymentStatus !== 'paid' &&
    order.isActive !== false;
  return { canEdit, editDeadline, editSecondsRemaining };
};

const readCheckoutRequestId = (req) =>
  String(req.get('Idempotency-Key') || req.body?.idempotencyKey || req.body?.checkoutRequestId || '')
    .trim()
    .slice(0, 120);

function readOrderQuantity(value) {
  const quantity = Number(value);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ORDER_ITEM_QUANTITY) {
    return null;
  }
  return quantity;
}

const recalculateOrderTotals = (order, restaurant) => {
  const subtotal = roundMoney((order.items || []).reduce((sum, item) => sum + Number(item.subtotal || 0), 0));
  const serviceChargeAmount = getServiceChargeAmount(restaurant, subtotal);
  order.totalAmount = subtotal;
  order.posDetails = {
    ...(order.posDetails?.toObject ? order.posDetails.toObject() : order.posDetails || {}),
    serviceChargeAmount,
  };
  order.grandTotal = roundMoney(subtotal + Number(order.taxAmount || 0) + serviceChargeAmount - Number(order.discountAmount || 0));
};

const buildKitchenBatchAlert = ({ order, restaurantId, table, items, subtotal, taxAmount, serviceChargeAmount, discountAmount, batchNumber }) => ({
  _id: order._id,
  orderNumber: order.orderNumber,
  restaurant: restaurantId,
  table,
  tableNumber: table?.tableNumber,
  guestId: order.guestId,
  items,
  grandTotal: roundMoney(subtotal + taxAmount + serviceChargeAmount - discountAmount),
  paymentMethod: order.paymentMethod,
  orderChannel: order.orderChannel,
  isAdditionalBatch: true,
  batchNumber,
  createdAt: new Date(),
});

const getTodayStart = () => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return start;
};

const clearStaleCartIfNeeded = async (cart) => {
  if (!cart || !Array.isArray(cart.items) || cart.items.length === 0) return cart;
  const updatedAt = cart.updatedAt ? new Date(cart.updatedAt) : null;
  if (!updatedAt || updatedAt >= getTodayStart()) return cart;
  cart.items = [];
  cart.totalAmount = 0;
  await cart.save();
  return cart;
};

const normalizeCartCustomizations = (customizations = []) =>
  (Array.isArray(customizations) ? customizations : [])
    .map((row) => ({
      name: String(row?.name || '').trim(),
      value: String(row?.value || '').trim(),
    }))
    .filter((row) => row.name || row.value)
    .sort((a, b) => `${a.name}:${a.value}`.localeCompare(`${b.name}:${b.value}`));

const normalizeCartAddOns = (addOns = []) =>
  (Array.isArray(addOns) ? addOns : [])
    .map((addOn) => String(addOn || '').trim())
    .filter(Boolean)
    .sort();

const normalizeCartVariations = (selectedVariations = []) =>
  (Array.isArray(selectedVariations) ? selectedVariations : [])
    .map((row) => ({
      groupId: String(row?.groupId || ''),
      optionId: String(row?.optionId || ''),
      quantity: Math.max(1, Number(row?.quantity || 1)),
    }))
    .filter((row) => row.groupId || row.optionId)
    .sort((a, b) => `${a.groupId}:${a.optionId}:${a.quantity}`.localeCompare(`${b.groupId}:${b.optionId}:${b.quantity}`));

const refreshCartLineSnapshot = (item) => {
  if (!item?.priceSnapshot) return;
  const quantity = Number(item.quantity || 0);
  const unitPrice = Number(item.priceSnapshot.unitPrice ?? item.price ?? 0);
  const taxRate = Number(item.priceSnapshot.taxRate || 0);
  const lineSubtotal = roundMoney(unitPrice * quantity);
  const taxAmount = roundMoney((lineSubtotal * taxRate) / 100);
  item.priceSnapshot.lineSubtotal = lineSubtotal;
  item.priceSnapshot.taxAmount = taxAmount;
  item.priceSnapshot.lineTotal = roundMoney(lineSubtotal + taxAmount);
};

const guestRequestLabels = {
  call_waiter: 'Call waiter',
  need_water: 'Need water',
  need_tissue: 'Need tissue',
  need_bill: 'Request bill',
};

const createGuestTableRequestNotifications = async ({ doc, table, guestId, requestType }) => {
  const restaurantId = String(table.restaurant);
  const branchId = table.branchId ? String(table.branchId) : null;
  const label = guestRequestLabels[requestType] || 'Guest request';
  const tableNumber = table.tableNumber || '-';
  const payload = {
    requestId: String(doc._id),
    guestId,
    restaurantId,
    branchId,
    tableId: String(table._id),
    tableNumber,
    requestType,
    message: doc.message || '',
    createdAt: doc.createdAt,
  };

  await notificationService.sendNotification({
    recipientType: 'restaurant',
    recipientId: restaurantId,
    restaurant: restaurantId,
    restaurantId,
    branchId,
    type: 'GUEST_TABLE_REQUEST',
    category: 'service',
    priority: requestType === 'call_waiter' || requestType === 'need_bill' ? 'high' : 'medium',
    title: label,
    message: `Table ${tableNumber} requested ${label.toLowerCase()}.`,
    relatedEntity: { entityType: 'guest_table_request', entityId: doc._id },
    actionUrl: '/notifications',
    metadata: payload,
  });

  const employeeQuery = {
    restaurant: table.restaurant,
    isActive: true,
    role: { $in: ['waiter', 'manager'] },
  };
  if (branchId) {
    employeeQuery.$or = [{ branchId: table.branchId }, { branchId: null }, { branchId: { $exists: false } }];
  }

  const employees = await Employee.find(employeeQuery).select('_id role branchId');
  await Promise.all(
    employees.map((employee) =>
      notificationService.sendNotification({
        recipientType: 'employee',
        recipientId: employee._id,
        restaurant: restaurantId,
        restaurantId,
        branchId,
        employee: employee._id,
        type: 'GUEST_TABLE_REQUEST',
        category: 'service',
        priority: employee.role === 'waiter' ? 'high' : 'medium',
        title: label,
        message: `Table ${tableNumber} requested ${label.toLowerCase()}.`,
        relatedEntity: { entityType: 'guest_table_request', entityId: doc._id },
        actionUrl: '/notifications',
        metadata: payload,
      }),
    ),
  );

  return payload;
};

const compactCartItems = (cart) => {
  if (!cart || !Array.isArray(cart.items) || cart.items.length < 2) return cart;
  const merged = [];
  const indexByKey = new Map();

  cart.items.forEach((item) => {
    const key = lineKeyFromDoc(item);
    const existingIndex = indexByKey.get(key);
    if (existingIndex == null) {
      indexByKey.set(key, merged.length);
      merged.push(item);
      return;
    }

    const existing = merged[existingIndex];
    existing.quantity = Math.min(
      MAX_ORDER_ITEM_QUANTITY,
      Number(existing.quantity || 0) + Number(item.quantity || 0),
    );
    refreshCartLineSnapshot(existing);
  });

  cart.items = merged;
  return cart;
};

const cartLineKey = (menuItemId, customizations = [], cookingInstructions = '', addOns = [], selectedVariations = []) =>
  JSON.stringify({
    m: String(menuItemId),
    s: normalizeCartCustomizations(customizations),
    c: String(cookingInstructions || ''),
    a: normalizeCartAddOns(addOns),
    v: normalizeCartVariations(selectedVariations),
  });

const lineKeyFromDoc = (item) =>
  cartLineKey(
    item.menuItem,
    item.customizations || [],
    item.cookingInstructions || '',
    item.addOns || [],
    item.selectedVariations || [],
  );

const getTableFromQr = async (qrToken) => {
  if (!qrToken) return null;
  return resolveTableFromQrToken(qrToken);
};

const readGuestSessionToken = (req) =>
  String(req.get('X-Guest-Session') || req.body?.guestSessionToken || req.query?.guestSessionToken || '')
    .trim();

const applyGuestSession = (guest, sessionToken = null) => {
  const token = sessionToken || generateGuestSessionToken();
  const now = new Date();
  guest.sessionTokenHash = hashToken(token);
  guest.sessionIssuedAt = guest.sessionIssuedAt || now;
  guest.sessionExpiresAt = new Date(now.getTime() + GUEST_SESSION_TTL_MS);
  guest.sessionLastActiveAt = now;
  guest.sessionRevokedAt = null;
  return token;
};

const validateGuestSession = (guest, sessionToken) => {
  if (!guest.sessionTokenHash) return true;
  if (!sessionToken) return false;
  if (guest.sessionRevokedAt) return false;
  if (guest.sessionExpiresAt && guest.sessionExpiresAt < new Date()) return false;
  return guest.sessionTokenHash === hashToken(sessionToken);
};

const validateOrderGuestSession = async ({ order, guestId, req }) => {
  if (!order || !guestId) return false;
  const guest = await Guest.findOne({
    guestId: String(guestId),
    restaurant: order.restaurant,
    branchId: order.branchId || null,
    table: order.table,
    isActive: true,
  });
  if (!guest || !validateGuestSession(guest, readGuestSessionToken(req))) return false;
  guest.sessionLastActiveAt = new Date();
  guest.lastVisitedAt = new Date();
  await guest.save();
  return true;
};

const resolveGuest = async ({ qrToken, guestId, guestSessionToken, deviceInfo }) => {
  const table = await getTableFromQr(qrToken);
  if (!table) return { error: 'Invalid or inactive table QR', status: 400 };

  let guest = null;
  let sessionToken = guestSessionToken || '';
  let shouldReuseProvidedGuestId = false;
  if (guestId) {
    guest = await Guest.findOne({
      guestId,
      restaurant: table.restaurant,
      branchId: table.branchId || null,
      table: table._id,
      isActive: true,
    });
    if (guest && !validateGuestSession(guest, guestSessionToken)) {
      return { error: 'Guest session expired or invalid. Please scan the table QR again.', status: 403 };
    }
    shouldReuseProvidedGuestId = Boolean(guest);
  }

  if (!guest) {
    let created = null;
    for (let i = 0; i < 5; i += 1) {
      // Reuse provided guestId only when it already belongs to this table.
      // If the provided id is unknown for this table, generate a new one to
      // avoid duplicate-key collisions and cross-table identity leakage.
      const candidateGuestId =
        i === 0 && shouldReuseProvidedGuestId && guestId ? guestId : generateGuestId();
      try {
        created = await Guest.create({
          guestId: candidateGuestId,
          restaurant: table.restaurant,
          branchId: table.branchId || null,
          table: table._id,
          qrTokenHash: hashToken(qrToken),
          deviceInfo: normalizeDeviceInfo(deviceInfo),
          lastVisitedAt: new Date(),
          sessionTokenHash: hashToken(sessionToken || (sessionToken = generateGuestSessionToken())),
          sessionIssuedAt: new Date(),
          sessionExpiresAt: new Date(Date.now() + GUEST_SESSION_TTL_MS),
          sessionLastActiveAt: new Date(),
          sessionRevokedAt: null,
          isActive: true,
        });
        break;
      } catch (err) {
        if (err?.code !== 11000) throw err;
      }
    }
    guest = created;
  } else {
    guest.lastVisitedAt = new Date();
    guest.branchId = guest.branchId || table.branchId || null;
    guest.qrTokenHash = hashToken(qrToken);
    sessionToken = applyGuestSession(guest, guestSessionToken);
    if (deviceInfo) {
      guest.deviceInfo = normalizeDeviceInfo(deviceInfo);
    }
    await guest.save();
  }

  if (!guest) {
    return { error: 'Failed to create guest session', status: 500 };
  }

  return { guest, table, guestSessionToken: sessionToken };
};

const mergeLoyaltyIntoGuestId = async ({ fromGuestIds, toGuestId, restaurantId }) => {
  const ids = [...new Set((fromGuestIds || []).filter(Boolean).filter((id) => id !== toGuestId))];
  if (!ids.length) {
    return GuestLoyalty.findOne({ guestId: toGuestId, restaurant: restaurantId }).lean();
  }

  const sourceRows = await GuestLoyalty.find({ guestId: { $in: ids }, restaurant: restaurantId }).lean();
  const points = sourceRows.reduce((sum, row) => sum + Number(row.points || 0), 0);
  const lifetimePoints = sourceRows.reduce((sum, row) => sum + Number(row.lifetimePoints || 0), 0);
  const target = await GuestLoyalty.findOneAndUpdate(
    { guestId: toGuestId, restaurant: restaurantId },
    { $inc: { points, lifetimePoints } },
    { upsert: true, new: true },
  ).lean();
  await GuestLoyalty.deleteMany({ guestId: { $in: ids }, restaurant: restaurantId });
  return target;
};

const getCartForGuest = async ({ guestId, table }) => {
  const cart = await CustomerCart.findOne({
    guestId,
    restaurant: table.restaurant,
    table: table._id,
  });
  const activeCart = await clearStaleCartIfNeeded(cart);
  if (!activeCart) return activeCart;
  const beforeCount = activeCart.items.length;
  compactCartItems(activeCart);
  if (activeCart.items.length !== beforeCount) {
    activeCart.totalAmount = computeCartTotal(activeCart.items);
    await activeCart.save();
  }
  await activeCart.populate('items.menuItem', 'name image isAvailable customizations variationGroups');
  return activeCart;
};

router.get('/landing/site-config', getPublicLandingSiteConfig);

router.get('/landing/stats', async (req, res) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [totalRestaurants, totalOrders, dailyActiveGuests, topRestaurants] = await Promise.all([
      Restaurant.countDocuments({ isDeleted: false, isActive: true }),
      CustomerOrder.countDocuments({ isActive: true, status: { $ne: 'cancelled' } }),
      Guest.countDocuments({ isActive: true, lastVisitedAt: { $gte: thirtyDaysAgo } }),
      CustomerOrder.aggregate([
        { $match: { isActive: true, status: { $ne: 'cancelled' } } },
        {
          $group: {
            _id: '$restaurant',
            totalOrders: { $sum: 1 },
          },
        },
        { $sort: { totalOrders: -1 } },
        { $limit: 12 },
        {
          $lookup: {
            from: 'restaurants',
            localField: '_id',
            foreignField: '_id',
            as: 'restaurant',
          },
        },
        { $unwind: '$restaurant' },
        { $match: { 'restaurant.isDeleted': false, 'restaurant.isActive': true } },
        {
          $project: {
            _id: 0,
            restaurantId: '$restaurant._id',
            name: '$restaurant.name',
            logo: '$restaurant.logo',
            totalOrders: 1,
          },
        },
      ]),
    ]);

    const restaurants = topRestaurants.map((restaurant) => {
      const code = String(restaurant.name || '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() || '')
        .join('') || 'RS';

      return {
        ...restaurant,
        code,
      };
    });

    return success(
      res,
      {
        stats: {
          totalRestaurants,
          totalOrders,
          dailyActiveGuests,
        },
        restaurants,
      },
      'Landing statistics retrieved'
    );
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to retrieve landing statistics', 500);
  }
});

router.post('/guest/session', strictLimiter, async (req, res) => {
  try {
    const { qrToken, guestId, deviceInfo } = req.body;
    if (!qrToken) return error(res, 'QR token is required', 400);

    const resolved = await resolveGuest({
      qrToken,
      guestId,
      guestSessionToken: readGuestSessionToken(req),
      deviceInfo,
    });
    if (resolved.error) return error(res, resolved.error, resolved.status);

    const { guest, table } = resolved;
    const [cart, recentOrders] = await Promise.all([
      getCartForGuest({ guestId: guest.guestId, table }),
      CustomerOrder.find({
        guestId: guest.guestId,
        restaurant: table.restaurant,
        table: table._id,
        isActive: true,
      })
        .sort({ createdAt: -1 })
        .limit(20),
    ]);

    return success(
      res,
      {
        guestId: guest.guestId,
        guestSessionToken: resolved.guestSessionToken,
        guestSessionExpiresAt: guest.sessionExpiresAt,
        tableId: table._id,
        restaurantId: table.restaurant,
        cart: cart || { items: [], totalAmount: 0 },
        orders: recentOrders,
      },
      'Guest session resolved'
    );
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to resolve guest session', 500);
  }
});

router.get('/cart/:guestId', async (req, res) => {
  try {
    const { guestId } = req.params;
    const { qrToken } = req.query;
    const resolved = await resolveGuest({ qrToken, guestId, guestSessionToken: readGuestSessionToken(req) });
    if (resolved.error) return error(res, resolved.error, resolved.status);
    const { guest, table } = resolved;
    const cart = await getCartForGuest({ guestId: guest.guestId, table });
    return success(res, cart || { items: [], totalAmount: 0 }, 'Cart retrieved');
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to retrieve cart', 500);
  }
});

router.post('/cart/:guestId/items', async (req, res) => {
  try {
    const { guestId } = req.params;
    const {
      qrToken,
      menuItemId,
      quantity = 1,
      notes = '',
      cookingInstructions = '',
      customizations = [],
      addOns = [],
      selectedVariations = [],
    } = req.body;
    const resolved = await resolveGuest({ qrToken, guestId, guestSessionToken: readGuestSessionToken(req) });
    if (resolved.error) return error(res, resolved.error, resolved.status);
    const { guest, table } = resolved;

    const menuBranch = await branchMenuItemBaseFilter(table);
    const menuItem = await MenuItem.findOne({
      _id: menuItemId,
      restaurant: menuBranch.restaurant,
      branchId: menuBranch.branchId,
      isDeleted: false,
      isAvailable: true,
    });
    if (!menuItem) return error(res, 'Menu item not found or unavailable', 404);
    const qty = readOrderQuantity(quantity);
    if (qty == null) {
      return error(res, `Quantity must be a whole number between 1 and ${MAX_ORDER_ITEM_QUANTITY}`, 400);
    }

    const cart =
      (await CustomerCart.findOne({
        guestId: guest.guestId,
        restaurant: table.restaurant,
        table: table._id,
      })) ||
      new CustomerCart({
        guestId: guest.guestId,
        restaurant: table.restaurant,
        table: table._id,
        items: [],
        totalAmount: 0,
      });

    const pricing = calculateMenuItemPrice(menuItem, selectedVariations, {
      branchId: menuBranch.branchId,
      orderType: 'qr_ordering',
    });
    if (!pricing.valid) {
      return error(res, pricing.errors.join(', '), 400);
    }
    const lineSubtotal = roundMoney(pricing.unitPrice * qty);
    const lineTax = roundMoney(pricing.taxAmount * qty);
    const priceSnapshot = {
      basePrice: pricing.basePrice,
      variationPrice: pricing.variationPrice,
      addOnPrice: pricing.addOnPrice,
      discountAmount: pricing.discountAmount,
      taxRate: pricing.taxRate,
      taxAmount: lineTax,
      unitPrice: pricing.unitPrice,
      lineSubtotal,
      lineTotal: roundMoney(lineSubtotal + lineTax),
    };

    const key = cartLineKey(menuItem._id, customizations, cookingInstructions, addOns, pricing.selectedVariations);
    const index = cart.items.findIndex((item) => lineKeyFromDoc(item) === key);
    if (index >= 0) {
      cart.items[index].quantity = Math.min(MAX_ORDER_ITEM_QUANTITY, Number(cart.items[index].quantity || 0) + qty);
      if (notes) cart.items[index].notes = notes;
      cart.items[index].price = pricing.unitPrice;
      const nextQty = cart.items[index].quantity;
      cart.items[index].priceSnapshot = {
        ...priceSnapshot,
        lineSubtotal: roundMoney(pricing.unitPrice * nextQty),
        taxAmount: roundMoney(pricing.taxAmount * nextQty),
        lineTotal: roundMoney((pricing.unitPrice + pricing.taxAmount) * nextQty),
      };
    } else {
      cart.items.push({
        menuItem: menuItem._id,
        quantity: qty,
        price: pricing.unitPrice,
        notes: String(notes || ''),
        cookingInstructions: String(cookingInstructions || ''),
        customizations: Array.isArray(customizations) ? customizations : [],
        addOns: Array.isArray(addOns) ? addOns : [],
        selectedVariations: pricing.selectedVariations,
        priceSnapshot,
      });
    }

    compactCartItems(cart);
    cart.totalAmount = computeCartTotal(cart.items);
    await cart.save();
    await cart.populate('items.menuItem', 'name image isAvailable customizations variationGroups');

    return success(res, cart, 'Item added to cart');
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to add item to cart', 500);
  }
});

router.patch('/cart/:guestId/items/:menuItemId', async (req, res) => {
  try {
    const { guestId, menuItemId } = req.params;
    const { qrToken, quantity, notes, lineId } = req.body;
    const resolved = await resolveGuest({ qrToken, guestId, guestSessionToken: readGuestSessionToken(req) });
    if (resolved.error) return error(res, resolved.error, resolved.status);
    const { guest, table } = resolved;

    const cart = await CustomerCart.findOne({
      guestId: guest.guestId,
      restaurant: table.restaurant,
      table: table._id,
    });
    if (!cart) return error(res, 'Cart not found', 404);

    let index = -1;
    if (lineId) {
      index = cart.items.findIndex((item) => String(item._id) === String(lineId));
    }
    if (index < 0) {
      index = cart.items.findIndex((item) => String(item.menuItem) === String(menuItemId));
    }
    if (index < 0) return error(res, 'Cart item not found', 404);

    const qty = Number(quantity);
    let removedLine = false;
    if (Number.isInteger(qty) && qty <= 0) {
      cart.items.splice(index, 1);
      removedLine = true;
    } else if (readOrderQuantity(quantity) != null) {
      cart.items[index].quantity = qty;
    } else {
      return error(res, `Quantity must be a whole number between 1 and ${MAX_ORDER_ITEM_QUANTITY}`, 400);
    }

    if (typeof notes === 'string' && cart.items[index]) {
      cart.items[index].notes = notes;
    }
    if (!removedLine && cart.items[index]?.priceSnapshot) {
      const unitPrice = Number(cart.items[index].priceSnapshot.unitPrice || cart.items[index].price || 0);
      const unitTax = roundMoney((unitPrice * Number(cart.items[index].priceSnapshot.taxRate || 0)) / 100);
      const nextQty = Number(cart.items[index].quantity || 0);
      cart.items[index].priceSnapshot.lineSubtotal = roundMoney(unitPrice * nextQty);
      cart.items[index].priceSnapshot.taxAmount = roundMoney(unitTax * nextQty);
      cart.items[index].priceSnapshot.lineTotal = roundMoney((unitPrice + unitTax) * nextQty);
    }

    compactCartItems(cart);
    cart.totalAmount = computeCartTotal(cart.items);
    await cart.save();
    await cart.populate('items.menuItem', 'name image isAvailable customizations variationGroups');
    return success(res, cart, 'Cart item updated');
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to update cart item', 500);
  }
});

router.delete('/cart/:guestId/items/:menuItemId', async (req, res) => {
  try {
    const { guestId, menuItemId } = req.params;
    const { qrToken, lineId } = req.query;
    const resolved = await resolveGuest({ qrToken, guestId, guestSessionToken: readGuestSessionToken(req) });
    if (resolved.error) return error(res, resolved.error, resolved.status);
    const { guest, table } = resolved;

    const cart = await CustomerCart.findOne({
      guestId: guest.guestId,
      restaurant: table.restaurant,
      table: table._id,
    });
    if (!cart) return success(res, { items: [], totalAmount: 0 }, 'Cart item removed');

    if (lineId) {
      cart.items = cart.items.filter((item) => String(item._id) !== String(lineId));
    } else {
      const idx = cart.items.findIndex((item) => String(item.menuItem) === String(menuItemId));
      if (idx >= 0) cart.items.splice(idx, 1);
    }
    compactCartItems(cart);
    cart.totalAmount = computeCartTotal(cart.items);
    await cart.save();
    await cart.populate('items.menuItem', 'name image isAvailable customizations variationGroups');
    return success(res, cart, 'Cart item removed');
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to remove cart item', 500);
  }
});

router.delete('/cart/:guestId', async (req, res) => {
  try {
    const { guestId } = req.params;
    const { qrToken } = req.query;
    const resolved = await resolveGuest({ qrToken, guestId, guestSessionToken: readGuestSessionToken(req) });
    if (resolved.error) return error(res, resolved.error, resolved.status);
    const { guest, table } = resolved;

    await CustomerCart.findOneAndUpdate(
      { guestId: guest.guestId, restaurant: table.restaurant, table: table._id },
      { $set: { items: [], totalAmount: 0 } },
      { upsert: true }
    );
    return success(res, { items: [], totalAmount: 0 }, 'Cart cleared');
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to clear cart', 500);
  }
});

router.post('/credit/apply', strictLimiter, async (req, res) => {
  try {
    const { qrToken, guestId, name, email, phone } = req.body;
    if (!qrToken || !guestId || !name || !email) {
      return error(res, 'QR token, guest, name and email are required', 400);
    }
    const resolved = await resolveGuest({ qrToken, guestId, guestSessionToken: readGuestSessionToken(req) });
    if (resolved.error) return error(res, resolved.error, resolved.status);
    const { table } = resolved;
    const emailNorm = String(email).trim().toLowerCase();
    let doc = await RestaurantCreditCustomer.findOne({ restaurant: table.restaurant, branchId: table.branchId, email: emailNorm });
    if (doc) {
      if (doc.status === 'approved') {
        return success(res, { status: 'already_approved', email: emailNorm }, 'Account already approved');
      }
      doc.name = String(name).trim().slice(0, 120);
      doc.phone = String(phone || '').trim().slice(0, 32);
      if (doc.status === 'rejected') doc.status = 'pending';
      await doc.save();
      return success(res, { status: doc.status, id: doc._id }, 'Application updated');
    }
    doc = await RestaurantCreditCustomer.create({
      restaurant: table.restaurant,
      branchId: table.branchId,
      email: emailNorm,
      name: String(name).trim().slice(0, 120),
      phone: String(phone || '').trim().slice(0, 32),
      status: 'pending',
    });
    return success(res, { status: 'pending', id: doc._id }, 'Application received', 201);
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) return error(res, 'An application for this email already exists', 400);
    return error(res, 'Failed to submit application', 500);
  }
});

router.post('/credit/request-otp', passwordResetLimiter, async (req, res) => {
  try {
    const { qrToken, guestId, email } = req.body;
    if (!qrToken || !guestId || !email) return error(res, 'QR token, guest and email are required', 400);
    const resolved = await resolveGuest({ qrToken, guestId, guestSessionToken: readGuestSessionToken(req) });
    if (resolved.error) return error(res, resolved.error, resolved.status);
    const { guest, table } = resolved;
    const emailNorm = String(email).trim().toLowerCase();
    const cc = await RestaurantCreditCustomer.findOne({
      restaurant: table.restaurant,
      branchId: table.branchId,
      email: emailNorm,
      status: 'approved',
    });
    if (!cc) {
      return error(res, 'No approved credit account for this email at this restaurant', 403);
    }
    await CreditCheckoutOtp.deleteMany({
      restaurant: table.restaurant,
      email: emailNorm,
      guestId: guest.guestId,
    });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await CreditCheckoutOtp.create({
      restaurant: table.restaurant,
      email: emailNorm,
      guestId: guest.guestId,
      code,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const r = await Restaurant.findById(table.restaurant).select('name').lean();
    await sendCreditCheckoutOtpEmail(emailNorm, code, r?.name);
    return success(res, { sent: true }, 'Verification code sent to email');
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to send verification code', 500);
  }
});

router.post('/checkout', strictLimiter, async (req, res) => {
  try {
    const {
      qrToken,
      guestId,
      items,
      paymentMethod = 'cash',
      paymentMode: paymentModeBody,
      checkoutTiming = 'pay_now',
      cashAmount = 0,
      onlineAmount = 0,
      creditEmail = '',
      creditOtp = '',
      customerName = '',
      customerPhone = '',
      customerEmail = '',
      specialRequests = '',
      promoCode = '',
      orderChannel: orderChannelBody = '',
      fulfillmentMode = '',
      deferPayment: deferPaymentRaw,
      appendToActiveOrder: appendToActiveOrderRaw = false,
    } = req.body;

    const deferPayment = deferPaymentRaw === true || deferPaymentRaw === 'true';
    const appendToActiveOrder = appendToActiveOrderRaw === true || appendToActiveOrderRaw === 'true';
    const requestedOrderChannel =
      String(orderChannelBody).trim() === 'takeaway' || String(fulfillmentMode).trim() === 'parcel'
        ? 'takeaway'
        : 'qr_ordering';
    const posMode = requestedOrderChannel === 'takeaway' ? 'takeaway' : 'dine_in';
    const savedSpecialRequests = [
      String(specialRequests || '').trim(),
      requestedOrderChannel === 'takeaway' ? 'Parcel order - pack for takeaway' : '',
    ].filter(Boolean).join('\n');

    if (!qrToken || !guestId || !Array.isArray(items) || items.length === 0) {
      return error(res, 'QR token, guest ID and items are required', 400);
    }
    if (items.length > MAX_ORDER_LINES) {
      return error(res, `A single checkout can contain at most ${MAX_ORDER_LINES} lines`, 400);
    }

    const resolved = await resolveGuest({ qrToken, guestId, guestSessionToken: readGuestSessionToken(req) });
    if (resolved.error) return error(res, resolved.error, resolved.status);
    const { guest, table } = resolved;
    const checkoutRequestId = readCheckoutRequestId(req);

    if (checkoutRequestId) {
      const existing = await CustomerOrder.findOne({
        restaurant: table.restaurant,
        guestId: guest.guestId,
        checkoutRequestId,
        isActive: true,
      }).select('_id orderNumber qrToken paymentStatus paymentMethod isCreditSale cashPaidAtCheckout onlinePaidAtCheckout discountAmount grandTotal');
      if (existing) {
        return success(
          res,
          {
            orderId: existing._id,
            orderNumber: existing.orderNumber,
            trackToken: existing.qrToken,
            paymentStatus: existing.paymentStatus,
            paymentMethod: existing.paymentMethod,
            isCreditSale: existing.isCreditSale,
            cashPaidAtCheckout: existing.cashPaidAtCheckout,
            onlinePaidAtCheckout: existing.onlinePaidAtCheckout,
            discountAmount: existing.discountAmount,
            totalAmount: existing.grandTotal,
            idempotentReplay: true,
          },
          'Checkout already processed',
          200,
        );
      }
    }

    const menuBranch = await branchMenuItemBaseFilter(table);

    let totalAmount = 0;
    let taxAmount = 0;
    const orderItems = [];

    for (const item of items) {
      const menuItem = await MenuItem.findOne({
        _id: item.menuItemId || item.menuItem || item._id,
        restaurant: menuBranch.restaurant,
        branchId: menuBranch.branchId,
        isDeleted: false,
      });

      if (!menuItem) {
        return error(res, `Menu item not found: ${item.menuItemId || item.menuItem || item._id}`, 404);
      }

      if (!menuItem.isAvailable) {
        return error(res, `${menuItem.name} is currently unavailable`, 400);
      }

      const quantity = readOrderQuantity(item.quantity);
      if (quantity == null) {
        return error(res, `Quantity must be a whole number between 1 and ${MAX_ORDER_ITEM_QUANTITY}`, 400);
      }
      let orderLine;
      try {
        orderLine = buildOrderLineFromMenuItem(menuItem, { ...item, quantity }, {
          branchId: menuBranch.branchId,
          orderType: requestedOrderChannel,
        });
      } catch (err) {
        return error(res, err.message || 'Invalid variation selections', err.statusCode || 400);
      }
      const subtotal = orderLine.subtotal;
      const itemTax = orderLine.taxAmount;

      totalAmount += subtotal;
      taxAmount += itemTax;
      orderItems.push(orderLine);
    }

    let discountAmount = 0;
    let appliedPromo = null;
    if (promoCode) {
      const promoValidation = await validatePromo({
        restaurantId: table.restaurant,
        branchId: menuBranch.branchId,
        code: promoCode,
        subtotal: totalAmount,
        items: orderItems.map((item) => ({
          menuItemId: item.menuItem,
          price: item.price,
          quantity: item.quantity,
        })),
      });

      if (!promoValidation.valid) {
        return error(res, promoValidation.message, 400);
      }

      discountAmount = promoValidation.discountAmount;
      appliedPromo = promoValidation.promo;
    }

    const restaurantDoc = await Restaurant.findById(table.restaurant).select('name settings').lean();
    const serviceChargeAmount = getServiceChargeAmount(restaurantDoc, totalAmount);
    const grandTotal = roundMoney(Math.max(0, totalAmount + taxAmount + serviceChargeAmount - discountAmount));
    const orderTrackingToken = generateRandomToken(32);
    const normalizedCustomerName = String(customerName || '').trim();
    const savedCustomerName =
      normalizedCustomerName && !['guest', 'qr customer', 'guest user'].includes(normalizedCustomerName.toLowerCase())
        ? normalizedCustomerName
        : `Guest ${guest.guestId}`;

    let timing = checkoutTiming === 'credit' ? 'credit' : 'pay_now';
    let restaurantCreditCustomerRef = null;
    let isCreditSale = false;
    let paymentStatus = 'pending';
    let amountPaidTotal = 0;
    let normalizedMethod = 'cash';
    let cashPaidAtCheckout = 0;
    let onlinePaidAtCheckout = 0;
    let customerPaymentDeferred = false;

    if (deferPayment) {
      timing = 'deferred';
      customerPaymentDeferred = true;
      normalizedMethod = 'pending';
      paymentStatus = 'pending';
      amountPaidTotal = 0;
      cashPaidAtCheckout = 0;
      onlinePaidAtCheckout = 0;
      isCreditSale = false;
      restaurantCreditCustomerRef = null;
    } else if (timing === 'credit') {
      const emailNorm = String(creditEmail || customerEmail || '').trim().toLowerCase();
      const otpRaw = String(creditOtp || '').trim();
      if (!emailNorm || !otpRaw) {
        return error(res, 'Credit checkout requires email and verification code', 400);
      }
      const ccust = await RestaurantCreditCustomer.findOne({
        restaurant: table.restaurant,
        branchId: table.branchId,
        email: emailNorm,
        status: 'approved',
      });
      if (!ccust) {
        return error(res, 'No approved house account for this email', 403);
      }
      const otpDoc = await CreditCheckoutOtp.findOne({
        restaurant: table.restaurant,
        email: emailNorm,
        guestId: guest.guestId,
      }).sort({ createdAt: -1 });
      if (!otpDoc || otpDoc.code !== otpRaw || otpDoc.expiresAt < new Date()) {
        return error(res, 'Invalid or expired verification code. Request a new code.', 400);
      }
      await CreditCheckoutOtp.deleteMany({
        restaurant: table.restaurant,
        email: emailNorm,
        guestId: guest.guestId,
      });
      restaurantCreditCustomerRef = ccust._id;
      isCreditSale = true;
      paymentStatus = 'pending';
      amountPaidTotal = 0;
      normalizedMethod = 'credit';
    } else {
      const rawMode = String(paymentModeBody || '').toLowerCase();
      const rawMethod = String(paymentMethod || 'cash').toLowerCase();
      const mode = rawMode || (['online', 'upi', 'card', 'wallet', 'esewa', 'khalti', 'fonepay'].includes(rawMethod) ? 'online' : 'cash');
      if (mode === 'cash') normalizedMethod = 'cash';
      else if (mode === 'online') normalizedMethod = 'online';
      else if (mode === 'both') normalizedMethod = 'mixed';
      else return error(res, 'Invalid payment mode', 400);

      cashPaidAtCheckout = 0;
      onlinePaidAtCheckout = 0;
      paymentStatus = 'pending';
      amountPaidTotal = 0;
    }

    const activeOrder = appendToActiveOrder
      ? await CustomerOrder.findOne({
        guestId: guest.guestId,
        restaurant: table.restaurant,
        table: table._id,
        isActive: true,
        createdAt: { $gte: getTodayStart() },
        status: { $nin: ['served', 'completed', 'cancelled'] },
        paymentStatus: { $ne: 'paid' },
        orderChannel: requestedOrderChannel,
      }).sort({ createdAt: -1 })
      : null;

    if (activeOrder && deferPayment) {
      const batchNumber = getNextBatchNumber(activeOrder);
      const previousStatus = activeOrder.status;
      activeOrder.items.push(...orderItems);
      activeOrder.taxAmount = roundMoney(Number(activeOrder.taxAmount || 0) + taxAmount);
      activeOrder.discountAmount = roundMoney(Number(activeOrder.discountAmount || 0) + discountAmount);
      activeOrder.itemBatches.push({
        batchNumber,
        items: orderItems,
        subtotal: roundMoney(totalAmount),
        taxAmount: roundMoney(taxAmount),
        discountAmount: roundMoney(discountAmount),
        serviceChargeAmount,
        grandTotal,
        statusHistory: [{ status: 'pending', timestamp: new Date(), note: 'Additional items added by customer' }],
      });
      if (previousStatus === 'ready') {
        activeOrder.status = 'preparing';
        activeOrder.statusHistory.push({
          status: 'preparing',
          timestamp: new Date(),
          note: `Additional batch #${batchNumber} added after order was ready`,
        });
      }
      recalculateOrderTotals(activeOrder, restaurantDoc);
      await activeOrder.save();
      await decrementVariationStockForOrderItems(orderItems);
      await activeOrder.populate('table', 'tableNumber');

      await createNewOrderNotifications(buildKitchenBatchAlert({
        order: activeOrder,
        restaurantId: table.restaurant,
        table: activeOrder.table,
        items: orderItems,
        subtotal: totalAmount,
        taxAmount,
        serviceChargeAmount,
        discountAmount,
        batchNumber,
      }));
      emitOrderUpdate(table.restaurant, activeOrder);

      if (appliedPromo) {
        appliedPromo.usedCount = Number(appliedPromo.usedCount || 0) + 1;
        await appliedPromo.save();
      }

      await CustomerCart.findOneAndUpdate(
        { guestId: guest.guestId, restaurant: table.restaurant, table: table._id },
        { $set: { items: [], totalAmount: 0 } },
        { upsert: true }
      );

      const pointsEarned = calculateLoyaltyPoints(grandTotal, restaurantDoc);
      const loyalty = pointsEarned > 0
        ? await GuestLoyalty.findOneAndUpdate(
          { guestId: guest.guestId, restaurant: table.restaurant },
          { $inc: { points: pointsEarned, lifetimePoints: pointsEarned } },
          { upsert: true, new: true },
        ).lean()
        : await GuestLoyalty.findOne({ guestId: guest.guestId, restaurant: table.restaurant }).lean();
      let smsStatus = { sent: false, skipped: true };
      if (activeOrder.customerPhone) {
        try {
          smsStatus = await sendOrderReceivedSms({
            phone: activeOrder.customerPhone,
            restaurantName: restaurantDoc?.name,
            orderNumber: activeOrder.orderNumber,
            editMinutes: 5,
          });
        } catch (smsErr) {
          console.error('checkout sms', smsErr);
          smsStatus = { sent: false, skipped: false, error: true };
        }
      }

      return success(
        res,
        {
          orderId: activeOrder._id,
          orderNumber: activeOrder.orderNumber,
          trackToken: activeOrder.qrToken,
          appended: true,
          batchNumber,
          paymentStatus: activeOrder.paymentStatus,
          paymentMethod: activeOrder.paymentMethod,
          orderChannel: activeOrder.orderChannel,
          isCreditSale: activeOrder.isCreditSale,
          cashPaidAtCheckout: activeOrder.cashPaidAtCheckout,
          onlinePaidAtCheckout: activeOrder.onlinePaidAtCheckout,
          promoCode: appliedPromo?.code || null,
          discountAmount: activeOrder.discountAmount,
          subtotal: activeOrder.totalAmount,
          taxAmount: activeOrder.taxAmount,
          serviceChargeAmount: activeOrder.posDetails?.serviceChargeAmount || 0,
          totalAmount: activeOrder.grandTotal,
          loyaltyPointsEarned: pointsEarned,
          loyaltyPointsBalance: loyalty?.points ?? pointsEarned,
          smsSent: Boolean(smsStatus.sent),
          smsSkipped: Boolean(smsStatus.skipped),
          nextAction: 'pay_after_served',
        },
        'Items added to your active order',
        200
      );
    }

    const order = await CustomerOrder.create({
      qrToken: orderTrackingToken,
      guestId: guest.guestId,
      restaurant: table.restaurant,
      restaurantId: table.restaurantId || table.restaurant,
      branchId: menuBranch.branchId,
      table: table._id,
      customerName: savedCustomerName,
      customerPhone,
      customerEmail: String(customerEmail || creditEmail || '').trim() || undefined,
      restaurantCreditCustomer: restaurantCreditCustomerRef,
      isCreditSale,
      customerPaymentDeferred,
      cashPaidAtCheckout,
      onlinePaidAtCheckout,
      items: orderItems,
      totalAmount,
      taxAmount,
      discountAmount,
      grandTotal,
      specialRequests: savedSpecialRequests,
      orderChannel: requestedOrderChannel,
      paymentMethod: normalizedMethod,
      paymentStatus,
      amountPaidTotal,
      checkoutRequestId,
      statusHistory: [{ status: 'pending', timestamp: new Date() }],
      itemBatches: [{
        batchNumber: 1,
        items: orderItems,
        subtotal: roundMoney(totalAmount),
        taxAmount: roundMoney(taxAmount),
        discountAmount: roundMoney(discountAmount),
        serviceChargeAmount,
        grandTotal,
        statusHistory: [{ status: 'pending', timestamp: new Date(), note: 'Initial order' }],
      }],
      posDetails: {
        mode: posMode,
        serviceChargeAmount,
      },
    });

    await order.populate('table', 'tableNumber');
    await decrementVariationStockForOrderItems(orderItems);
    await POSOrder.create({
      restaurant: table.restaurant,
      customerOrder: order._id,
      source: 'qr_menu',
    });
    await createNewOrderNotifications(order);

    if (appliedPromo) {
      appliedPromo.usedCount = Number(appliedPromo.usedCount || 0) + 1;
      await appliedPromo.save();
    }

    await CustomerCart.findOneAndUpdate(
      { guestId: guest.guestId, restaurant: table.restaurant, table: table._id },
      { $set: { items: [], totalAmount: 0 } },
      { upsert: true }
    );

    const pointsEarned = calculateLoyaltyPoints(grandTotal, restaurantDoc);
    const loyalty = pointsEarned > 0
      ? await GuestLoyalty.findOneAndUpdate(
        { guestId: guest.guestId, restaurant: table.restaurant },
        { $inc: { points: pointsEarned, lifetimePoints: pointsEarned } },
        { upsert: true, new: true },
      ).lean()
      : await GuestLoyalty.findOne({ guestId: guest.guestId, restaurant: table.restaurant }).lean();

    const rinfo = restaurantDoc;
    const billTo = String(customerEmail || creditEmail || '').trim();
    if (billTo && timing !== 'deferred') {
      try {
        if (isCreditSale) {
          await sendCreditBillEmail(billTo, {
            restaurantName: rinfo?.name,
            orderNumber: order.orderNumber,
            grandTotal: order.grandTotal,
            items: orderItems,
            isCreditSale: true,
          });
        } else {
          await sendOrderConfirmationEmail(billTo, order.orderNumber, orderItems, order.grandTotal);
          if (normalizedMethod === 'mixed') {
            await sendCreditBillEmail(billTo, {
              restaurantName: rinfo?.name,
              orderNumber: order.orderNumber,
              grandTotal: order.grandTotal,
              items: orderItems,
              isCreditSale: false,
            });
          }
        }
      } catch (mailErr) {
        console.error('checkout email', mailErr);
      }
    }

    let smsStatus = { sent: false, skipped: true };
    if (customerPhone) {
      try {
        smsStatus = await sendOrderReceivedSms({
          phone: customerPhone,
          restaurantName: rinfo?.name,
          orderNumber: order.orderNumber,
          editMinutes: 5,
        });
      } catch (smsErr) {
        console.error('checkout sms', smsErr);
        smsStatus = { sent: false, skipped: false, error: true };
      }
    }

    let nextAction = 'pay_at_counter';
    if (timing === 'deferred') nextAction = 'pay_after_served';
    else if (isCreditSale) nextAction = 'credit_recorded';
    else if (normalizedMethod === 'online') nextAction = 'awaiting_gateway_or_staff_confirmation';
    else if (normalizedMethod === 'mixed') nextAction = 'awaiting_split_payment_confirmation';

    return success(
      res,
      {
        orderId: order._id,
        orderNumber: order.orderNumber,
        trackToken: order.qrToken,
        paymentStatus: order.paymentStatus,
        paymentMethod: order.paymentMethod,
        orderChannel: order.orderChannel,
        isCreditSale,
        cashPaidAtCheckout,
        onlinePaidAtCheckout,
        promoCode: appliedPromo?.code || null,
        discountAmount: order.discountAmount,
        totalAmount: order.grandTotal,
        loyaltyPointsEarned: pointsEarned,
        loyaltyPointsBalance: loyalty?.points ?? pointsEarned,
        smsSent: Boolean(smsStatus.sent),
        smsSkipped: Boolean(smsStatus.skipped),
        nextAction,
      },
      'Checkout completed successfully',
      201
    );
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to checkout', 500);
  }
});

router.post('/promo/validate', strictLimiter, async (req, res) => {
  try {
    const { qrToken, code, items = [] } = req.body;
    if (!qrToken || !code || !Array.isArray(items)) {
      return error(res, 'QR token, promo code and items are required', 400);
    }

    const table = await getTableFromQr(qrToken);
    if (!table) return error(res, 'Invalid or inactive table QR', 400);

    const menuBranch = await branchMenuItemBaseFilter(table);

    let subtotal = 0;
    const normalizedItems = [];
    for (const item of items) {
      const menuItem = await MenuItem.findOne({
        _id: item.menuItemId || item.menuItem || item._id,
        restaurant: menuBranch.restaurant,
        branchId: menuBranch.branchId,
        isDeleted: false,
      });
      if (!menuItem) continue;
      const quantity = readOrderQuantity(item.quantity);
      if (quantity == null) {
        return error(res, `Quantity must be a whole number between 1 and ${MAX_ORDER_ITEM_QUANTITY}`, 400);
      }
      subtotal += Number(menuItem.price) * quantity;
      normalizedItems.push({
        menuItemId: menuItem._id,
        price: menuItem.price,
        quantity,
      });
    }

    const promoValidation = await validatePromo({
      restaurantId: table.restaurant,
      branchId: menuBranch.branchId,
      code,
      subtotal,
      items: normalizedItems,
    });

    if (!promoValidation.valid) {
      return error(res, promoValidation.message, 400);
    }

    return success(
      res,
      {
        code: promoValidation.promo.code,
        name: promoValidation.promo.name,
        discountAmount: promoValidation.discountAmount,
      },
      'Promo applied'
    );
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to validate promo', 500);
  }
});

/**
 * Public restaurant profile: serves the About + Privacy details captured by the
 * restaurant admin panel. Customer "About" and "Privacy" pages render entirely
 * from this response.
 */
router.get('/restaurant/:restaurantSlug/profile', async (req, res) => {
  try {
    const { restaurantSlug } = req.params;
    const restaurant = await Restaurant.findOne({
      slug: restaurantSlug,
      isActive: true,
      isDeleted: false,
    })
      .select(
        'name slug logo favicon backgroundPhoto brandBackgroundImage description address city state pincode country '
        + 'phone email openingTime closingTime about privacyPolicy settings.currency settings.themeSettings createdAt'
      )
      .lean();

    if (!restaurant) return error(res, 'Restaurant not found', 404);

    const branchId = await resolveCustomerMenuBranchId(restaurant._id, { qrToken: req.query.qrToken });
    const branch = branchId
      ? await Branch.findOne({ _id: branchId, restaurantId: restaurant._id, isDeleted: false })
        .select('name logo banner phone email address city state country openingHours about privacyPolicy settings.themeSettings')
        .lean()
      : null;
    const about = branch?.about && Object.keys(branch.about).length ? branch.about : (restaurant.about || {});
    const privacy = branch?.privacyPolicy && Object.keys(branch.privacyPolicy).length ? branch.privacyPolicy : (restaurant.privacyPolicy || {});
    const addressParts = [
      branch?.address || restaurant.address,
      branch?.city || restaurant.city,
      branch?.state || restaurant.state,
      restaurant.pincode,
    ]
      .map((p) => (p ? String(p).trim() : ''))
      .filter(Boolean);

    return success(
      res,
      {
        id: restaurant._id,
        slug: restaurant.slug,
        name: branch?.name || restaurant.name,
        logo: branch?.logo || restaurant.logo,
        favicon: restaurant.favicon,
        backgroundPhoto: branch?.banner || restaurant.backgroundPhoto,
        brandBackgroundImage: branch?.banner || restaurant.brandBackgroundImage,
        description: restaurant.description || '',
        phone: branch?.phone || restaurant.phone || '',
        email: branch?.email || restaurant.email || '',
        address: addressParts.join(', '),
        country: branch?.country || restaurant.country || '',
        openingTime: restaurant.openingTime,
        closingTime: restaurant.closingTime,
        currency: restaurant?.settings?.currency || 'Rs.',
        themeSettings: branch?.settings?.themeSettings?.activeTheme ? branch.settings.themeSettings : (restaurant?.settings?.themeSettings || {}),
        createdAt: restaurant.createdAt,
        about: {
          tagline: about.tagline || '',
          aboutText: about.aboutText || '',
          cuisine: about.cuisine || '',
          priceRange: about.priceRange || '',
          establishedYear: about.establishedYear || null,
          rating: about.rating ?? null,
          reviewCount: about.reviewCount ?? null,
          features: Array.isArray(about.features) ? about.features : [],
          gallery: Array.isArray(about.gallery) ? about.gallery : [],
          hours: about.hours || {},
          socials: about.socials || {},
        },
        privacyPolicy: {
          enabled: privacy.enabled === true,
          lastUpdated: privacy.lastUpdated || null,
          sections: Array.isArray(privacy.sections) ? privacy.sections : [],
          contactEmail: privacy.contactEmail || '',
          contactPhone: privacy.contactPhone || '',
          contactAddress: privacy.contactAddress || '',
        },
      },
      'Restaurant profile retrieved'
    );
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to retrieve restaurant profile', 500);
  }
});

const getPublicOffers = async (req, res) => {
  try {
    const { restaurantSlug } = req.params;
    const restaurant = await Restaurant.findOne({ slug: restaurantSlug, isActive: true, isDeleted: false });
    if (!restaurant) return error(res, 'Restaurant not found', 404);

    const branchId = await resolveCustomerMenuBranchId(restaurant._id, { qrToken: req.query.qrToken });
    if (!branchId) return error(res, 'Unable to resolve branch for offers', 400);

    const now = new Date();
    const promotions = await Promotion.find({
      restaurant: restaurant._id,
      branchId,
      isDeleted: false,
      isActive: true,
      startAt: { $lte: now },
      endAt: { $gte: now },
      bannerText: { $ne: '' },
    }).select('name code bannerText bannerColor discountType discountValue minOrderAmount endAt');

    return success(res, promotions, 'Promotions retrieved');
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to fetch promotions', 500);
  }
};

router.get('/offers/:restaurantSlug', getPublicOffers);
router.get('/promotions/:restaurantSlug/banners', getPublicOffers);

router.get('/feedback/settings/:restaurantSlug', async (req, res) => {
  try {
    const { restaurantSlug } = req.params;
    const restaurant = await Restaurant.findOne({ slug: restaurantSlug, isActive: true, isDeleted: false })
      .select('name settings.feedbackEnabled settings.showFeedbackOnLanding');
    if (!restaurant) return error(res, 'Restaurant not found', 404);
    const settings = await PlatformSiteSettings.getSingleton();
    const platformOn = settings.feedbackEnabled !== false;
    const restaurantOn = restaurant.settings?.feedbackEnabled !== false;

    return success(res, {
      feedbackEnabled: platformOn && restaurantOn,
      showFeedbackOnLanding: settings.showFeedbackOnLanding !== false && restaurant.settings?.showFeedbackOnLanding !== false,
    }, 'Feedback settings retrieved');
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to retrieve feedback settings', 500);
  }
});

router.get('/feedback/summary/:restaurantSlug', async (req, res) => {
  try {
    const { restaurantSlug } = req.params;
    const restaurant = await Restaurant.findOne({ slug: restaurantSlug, isActive: true, isDeleted: false })
      .select('_id settings.feedbackEnabled settings.showFeedbackOnLanding');
    if (!restaurant) return error(res, 'Restaurant not found', 404);

    const [total, publicCount, averageAgg] = await Promise.all([
      CustomerFeedback.countDocuments({ restaurant: restaurant._id, isActive: true }),
      CustomerFeedback.countDocuments({ restaurant: restaurant._id, isActive: true, isPublic: true }),
      CustomerFeedback.aggregate([
        { $match: { restaurant: restaurant._id, isActive: true } },
        { $group: { _id: null, averageSystemRating: { $avg: '$systemRating' } } },
      ]),
    ]);

    return success(res, {
      total,
      publicCount,
      averageSystemRating: Number((averageAgg[0]?.averageSystemRating || 0).toFixed(1)),
      feedbackEnabled: restaurant.settings?.feedbackEnabled !== false,
      showFeedbackOnLanding: restaurant.settings?.showFeedbackOnLanding !== false,
    }, 'Feedback summary retrieved');
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to retrieve feedback summary', 500);
  }
});

router.post('/feedback', strictLimiter, async (req, res) => {
  try {
    const { qrToken, guestId, systemRating, serviceRating, comment = '', customerName = 'Guest customer' } = req.body;
    if (!qrToken || !systemRating || !serviceRating) {
      return error(res, 'QR token, system rating and service rating are required', 400);
    }

    let resolved = await resolveGuest({ qrToken, guestId, guestSessionToken: readGuestSessionToken(req) });
    let guest = resolved.guest;
    let table = resolved.table;

    if (resolved.error) {
      const order = await CustomerOrder.findOne({ qrToken, isActive: true }).populate(
        'table',
        'tableNumber restaurant',
      );
      if (!order) return error(res, resolved.error, resolved.status);
      const restaurantId = order.table?.restaurant || order.restaurant;
      if (!restaurantId) return error(res, 'Order has no restaurant context', 400);
      const tableId = order.table?._id || order.table || null;
      table = { _id: tableId, restaurant: restaurantId };
      guest = {
        guestId: order.guestId || guestId || 'paid-order-guest',
      };
    }

    const settings = await PlatformSiteSettings.getSingleton();
    if (settings.feedbackEnabled === false) {
      return error(res, 'Feedback is disabled by platform admin', 403);
    }

    const restaurantPolicy = await Restaurant.findOne({
      _id: table.restaurant,
      isDeleted: false,
    }).select('settings.feedbackEnabled');
    if (!restaurantPolicy) return error(res, 'Restaurant not found', 404);
    if (restaurantPolicy.settings?.feedbackEnabled === false) {
      return error(res, 'Feedback is disabled for this restaurant', 403);
    }

    const numericRating = Number(systemRating);
    if (Number.isNaN(numericRating) || numericRating < 1 || numericRating > 5) {
      return error(res, 'System rating must be between 1 and 5', 400);
    }

    const itemRatings = Array.isArray(req.body.itemRatings) ? req.body.itemRatings : [];
    const reviewImages = Array.isArray(req.body.reviewImages) ? req.body.reviewImages : [];

    const feedback = await CustomerFeedback.create({
      restaurant: table.restaurant,
      table: table._id || null,
      guestId: guest.guestId,
      qrToken,
      systemRating: numericRating,
      serviceRating,
      comment: String(comment || '').slice(0, 700),
      customerName: String(customerName || 'Guest customer').slice(0, 80),
      itemRatings: itemRatings
        .filter((r) => r && r.menuItemId && r.rating)
        .map((r) => ({
          menuItem: r.menuItemId,
          rating: Math.min(5, Math.max(1, Number(r.rating))),
          comment: String(r.comment || '').slice(0, 300),
        }))
        .slice(0, 12),
      reviewImages: reviewImages.map((u) => String(u || '').trim()).filter(Boolean).slice(0, 6),
      isPublic: true,
      isActive: true,
    });

    return success(res, feedback, 'Feedback submitted', 201);
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to submit feedback', 500);
  }
});

const isGenericReviewName = (value) => {
  const text = String(value || '').trim().toLowerCase();
  return !text || ['guest', 'guest customer', 'qr customer', 'guest user'].includes(text);
};

router.get('/items/:itemId/reviews', async (req, res) => {
  try {
    const { itemId } = req.params;
    if (!/^[a-f\d]{24}$/i.test(String(itemId || ''))) {
      return error(res, 'Invalid menu item ID', 400);
    }
    const item = await MenuItem.findOne({ _id: itemId, isDeleted: false }).select('_id restaurant branchId');
    if (!item) return error(res, 'Menu item not found', 404);

    const feedbackRows = await CustomerFeedback.find({
      restaurant: item.restaurant,
      isActive: true,
      isPublic: true,
      'itemRatings.menuItem': item._id,
    })
      .select('guestId customerName createdAt itemRatings')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const guestIds = [...new Set(feedbackRows.map((row) => row.guestId).filter(Boolean))];
    const identities = guestIds.length
      ? await CustomerIdentity.find({
        restaurant: item.restaurant,
        isActive: true,
        $or: [
          { primaryGuestId: { $in: guestIds } },
          { linkedGuestIds: { $in: guestIds } },
        ],
      }).select('name primaryGuestId linkedGuestIds').lean()
      : [];
    const identityByGuestId = new Map();
    identities.forEach((identity) => {
      [identity.primaryGuestId, ...(identity.linkedGuestIds || [])].filter(Boolean).forEach((linkedGuestId) => {
        identityByGuestId.set(String(linkedGuestId), identity);
      });
    });

    const reviews = feedbackRows.flatMap((row) =>
      (row.itemRatings || [])
        .filter((rating) => String(rating.menuItem) === String(item._id))
        .map((rating) => ({
          id: `${row._id}-${rating._id || rating.menuItem}`,
          rating: Number(rating.rating || 0),
          comment: rating.comment || '',
          customerName: isGenericReviewName(row.customerName)
            ? identityByGuestId.get(String(row.guestId || ''))?.name || row.guestId || 'Guest customer'
            : row.customerName,
          guestId: row.guestId || '',
          createdAt: row.createdAt,
        })),
    );

    const total = reviews.length;
    const average = total
      ? Number((reviews.reduce((sum, row) => sum + Number(row.rating || 0), 0) / total).toFixed(1))
      : 0;
    return success(res, { average, total, reviews: reviews.slice(0, 20) }, 'Item reviews retrieved');
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to retrieve item reviews', 500);
  }
});

router.post('/items/:itemId/reviews', strictLimiter, async (req, res) => {
  try {
    const { itemId } = req.params;
    const { qrToken, guestId, rating, comment = '', customerName = 'Guest customer' } = req.body;
    if (!/^[a-f\d]{24}$/i.test(String(itemId || ''))) {
      return error(res, 'Invalid menu item ID', 400);
    }
    if (!qrToken || !guestId) return error(res, 'QR token and guest ID are required', 400);

    const numericRating = Number(rating);
    if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
      return error(res, 'Rating must be between 1 and 5', 400);
    }

    const resolved = await resolveGuest({ qrToken, guestId, guestSessionToken: readGuestSessionToken(req) });
    if (resolved.error) return error(res, resolved.error, resolved.status);
    const { guest, table } = resolved;

    const item = await MenuItem.findOne({
      _id: itemId,
      restaurant: table.restaurant,
      branchId: table.branchId || null,
      isDeleted: false,
    }).select('_id restaurant branchId');
    if (!item) return error(res, 'Menu item not found for this restaurant', 404);

    const serviceRating = numericRating >= 4 ? 'great' : numericRating >= 3 ? 'average' : 'poor';
    const cleanComment = String(comment || '').trim().slice(0, 300);
    const identity = await CustomerIdentity.findOne({
      restaurant: table.restaurant,
      isActive: true,
      $or: [{ primaryGuestId: guest.guestId }, { linkedGuestIds: guest.guestId }],
    }).select('name').lean();
    const cleanName = (
      isGenericReviewName(customerName)
        ? identity?.name || guest.guestId || 'Guest customer'
        : String(customerName || '').trim()
    ).slice(0, 80) || guest.guestId || 'Guest customer';

    let feedback = await CustomerFeedback.findOne({
      restaurant: table.restaurant,
      guestId: guest.guestId,
      isActive: true,
      'itemRatings.menuItem': item._id,
    });

    if (feedback) {
      const row = feedback.itemRatings.find((r) => String(r.menuItem) === String(item._id));
      if (row) {
        row.rating = numericRating;
        row.comment = cleanComment;
      } else {
        feedback.itemRatings.push({ menuItem: item._id, rating: numericRating, comment: cleanComment });
      }
      feedback.systemRating = numericRating;
      feedback.serviceRating = serviceRating;
      feedback.comment = cleanComment || feedback.comment;
      feedback.customerName = cleanName;
      feedback.isPublic = true;
      await feedback.save();
    } else {
      feedback = await CustomerFeedback.create({
        restaurant: table.restaurant,
        table: table._id || null,
        guestId: guest.guestId,
        qrToken,
        systemRating: numericRating,
        serviceRating,
        comment: cleanComment,
        customerName: cleanName,
        itemRatings: [{ menuItem: item._id, rating: numericRating, comment: cleanComment }],
        isPublic: true,
        isActive: true,
      });
    }

    return success(res, feedback, 'Item review submitted', 201);
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to submit item review', 500);
  }
});

router.get('/feedback/public', async (req, res) => {
  try {
    const settings = await PlatformSiteSettings.getSingleton();
    if (settings.showFeedbackOnLanding === false) {
      return success(res, [], 'Public feedback disabled');
    }

    const restaurants = await Restaurant.find({
      isActive: true,
      isDeleted: false,
    }).select('_id name logo');
    const restaurantIds = restaurants.map((restaurant) => restaurant._id);

    const feedback = await CustomerFeedback.find({
      restaurant: { $in: restaurantIds },
      isActive: true,
      isPublic: true,
      systemRating: { $gte: 4 },
    })
      .populate('restaurant', 'name logo settings.showFeedbackOnLanding')
      .sort({ createdAt: -1 })
      .limit(9);

    return success(res, feedback, 'Public feedback retrieved');
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to retrieve public feedback', 500);
  }
});

router.post('/table-request', strictLimiter, async (req, res) => {
  try {
    const { qrToken, guestId, requestType, message = '' } = req.body;
    const allowed = ['call_waiter', 'need_water', 'need_tissue', 'need_bill'];
    if (!qrToken || !guestId || !allowed.includes(requestType)) {
      return error(res, 'QR token, guest ID and a valid request type are required', 400);
    }
    const resolved = await resolveGuest({ qrToken, guestId, guestSessionToken: readGuestSessionToken(req) });
    if (resolved.error) return error(res, resolved.error, resolved.status);
    const { guest, table } = resolved;

    const doc = await GuestTableRequest.create({
      guestId: guest.guestId,
      restaurant: table.restaurant,
      table: table._id,
      requestType,
      message: String(message || '').slice(0, 300),
    });

    const payload = await createGuestTableRequestNotifications({
      doc,
      table,
      guestId: guest.guestId,
      requestType,
    });

    emitGuestTableRequest(String(table.restaurant), payload);

    return success(res, doc, 'Staff have been notified', 201);
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to send table request', 500);
  }
});

router.get('/loyalty/:guestId', async (req, res) => {
  try {
    const { guestId } = req.params;
    const { qrToken } = req.query;
    const resolved = await resolveGuest({ qrToken, guestId, guestSessionToken: readGuestSessionToken(req) });
    if (resolved.error) return error(res, resolved.error, resolved.status);
    const { guest, table } = resolved;

    const doc = await GuestLoyalty.findOne({
      guestId: guest.guestId,
      restaurant: table.restaurant,
    }).lean();

    return success(
      res,
      {
        points: doc?.points ?? 0,
        lifetimePoints: doc?.lifetimePoints ?? 0,
      },
      'Loyalty balance retrieved',
    );
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to retrieve loyalty balance', 500);
  }
});

router.post('/identity/request-otp', passwordResetLimiter, async (req, res) => {
  try {
    const { qrToken, guestId, email, purpose = 'signup' } = req.body;
    if (!qrToken || !guestId || !email) {
      return error(res, 'QR token, guest ID and email are required', 400);
    }
    const resolved = await resolveGuest({ qrToken, guestId, guestSessionToken: readGuestSessionToken(req) });
    if (resolved.error) return error(res, resolved.error, resolved.status);
    const { guest, table } = resolved;
    const emailNorm = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      return error(res, 'Enter a valid email address', 400);
    }
    const normalizedPurpose = 'signup';
    const restaurant = await Restaurant.findById(table.restaurant).select('name').lean();
    await CustomerIdentityOtp.deleteMany({
      restaurant: table.restaurant,
      guestId: guest.guestId,
      email: emailNorm,
      purpose: normalizedPurpose,
    });
    const code = generateOTP();
    await CustomerIdentityOtp.create({
      restaurant: table.restaurant,
      guestId: guest.guestId,
      email: emailNorm,
      code,
      purpose: normalizedPurpose,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    await sendCustomerIdentityOtpEmail(emailNorm, code, {
      restaurantName: restaurant?.name,
      purpose: normalizedPurpose,
    });
    return success(res, { sent: true, email: emailNorm, purpose: normalizedPurpose }, 'Verification code sent');
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to send verification code', 500);
  }
});

router.post('/identity/forgot-password', passwordResetLimiter, async (req, res) => {
  try {
    const { qrToken, guestId, email } = req.body;
    if (!qrToken || !guestId || !email) return error(res, 'QR token, guest ID and email are required', 400);
    const resolved = await resolveGuest({ qrToken, guestId, guestSessionToken: readGuestSessionToken(req) });
    if (resolved.error) return error(res, resolved.error, resolved.status);
    const { guest, table } = resolved;
    const emailNorm = String(email || '').trim().toLowerCase();
    const identity = await CustomerIdentity.findOne({ restaurant: table.restaurant, email: emailNorm, isActive: true }).lean();
    if (!identity) return error(res, 'No customer ID found for this email', 404);
    const restaurant = await Restaurant.findById(table.restaurant).select('name').lean();
    await CustomerIdentityOtp.deleteMany({ restaurant: table.restaurant, guestId: guest.guestId, email: emailNorm, purpose: 'reset' });
    const code = generateOTP();
    await CustomerIdentityOtp.create({
      restaurant: table.restaurant,
      guestId: guest.guestId,
      email: emailNorm,
      code,
      purpose: 'reset',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    await sendCustomerIdentityOtpEmail(emailNorm, code, { restaurantName: restaurant?.name, purpose: 'reset' });
    return success(res, { sent: true, email: emailNorm }, 'Password reset code sent');
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to send password reset code', 500);
  }
});

router.post('/identity/reset-password', passwordResetLimiter, async (req, res) => {
  try {
    const { qrToken, guestId, email, otp, newPassword } = req.body;
    if (!qrToken || !guestId || !email || !otp || !newPassword) {
      return error(res, 'QR token, guest ID, email, OTP and new password are required', 400);
    }
    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.valid) return error(res, passwordValidation.message, 400);
    const resolved = await resolveGuest({ qrToken, guestId, guestSessionToken: readGuestSessionToken(req) });
    if (resolved.error) return error(res, resolved.error, resolved.status);
    const { guest, table } = resolved;
    const emailNorm = String(email || '').trim().toLowerCase();
    const otpDoc = await CustomerIdentityOtp.findOne({
      restaurant: table.restaurant,
      guestId: guest.guestId,
      email: emailNorm,
      purpose: 'reset',
    }).sort({ createdAt: -1 });
    if (!otpDoc || otpDoc.code !== String(otp).trim() || otpDoc.expiresAt < new Date()) {
      return error(res, 'Invalid or expired reset code', 400);
    }
    const identity = await CustomerIdentity.findOne({ restaurant: table.restaurant, email: emailNorm, isActive: true }).select('+passwordHash');
    if (!identity) return error(res, 'No customer ID found for this email', 404);
    identity.passwordHash = await bcrypt.hash(String(newPassword), 10);
    await identity.save();
    await CustomerIdentityOtp.deleteMany({ restaurant: table.restaurant, guestId: guest.guestId, email: emailNorm, purpose: 'reset' });
    return success(res, { reset: true }, 'Password reset successfully');
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to reset password', 500);
  }
});

router.post('/identity/verify-reset-otp', passwordResetLimiter, async (req, res) => {
  try {
    const { qrToken, guestId, email, otp } = req.body;
    if (!qrToken || !guestId || !email || !otp) {
      return error(res, 'QR token, guest ID, email and OTP are required', 400);
    }
    const resolved = await resolveGuest({ qrToken, guestId, guestSessionToken: readGuestSessionToken(req) });
    if (resolved.error) return error(res, resolved.error, resolved.status);
    const { guest, table } = resolved;
    const emailNorm = String(email || '').trim().toLowerCase();
    const otpDoc = await CustomerIdentityOtp.findOne({
      restaurant: table.restaurant,
      guestId: guest.guestId,
      email: emailNorm,
      purpose: 'reset',
    }).sort({ createdAt: -1 });
    if (!otpDoc || otpDoc.code !== String(otp).trim() || otpDoc.expiresAt < new Date()) {
      return error(res, 'Invalid or expired reset code', 400);
    }
    return success(res, { verified: true, email: emailNorm }, 'Reset code verified');
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to verify reset code', 500);
  }
});

router.get('/identity/me', async (req, res) => {
  try {
    const { qrToken, guestId, customerId } = req.query;
    if (!qrToken || !guestId) return error(res, 'QR token and guest ID are required', 400);

    const resolved = await resolveGuest({ qrToken, guestId, guestSessionToken: readGuestSessionToken(req) });
    if (resolved.error) return error(res, resolved.error, resolved.status);
    const { guest, table } = resolved;

    const lookup = {
      restaurant: table.restaurant,
      isActive: true,
      $or: [
        { primaryGuestId: guest.guestId },
        { linkedGuestIds: guest.guestId },
        ...(customerId ? [{ customerId: String(customerId) }] : []),
      ],
    };
    const identity = await CustomerIdentity.findOne(lookup).lean();
    if (!identity) {
      return success(res, {
        guestId: guest.guestId,
        customerId: null,
        customer: null,
        loyalty: { points: 0, lifetimePoints: 0 },
      }, 'No customer ID linked');
    }

    const loyalty = await GuestLoyalty.findOne({
      guestId: guest.guestId,
      restaurant: table.restaurant,
    }).lean();
    const orderCount = await CustomerOrder.countDocuments({
      restaurant: table.restaurant,
      guestId: guest.guestId,
      isActive: true,
    });

    return success(res, {
      guestId: guest.guestId,
      customerId: identity.customerId,
      customer: {
        customerId: identity.customerId,
        name: identity.name,
        phone: identity.phone || '',
        email: identity.email || '',
      },
      orderCount,
      loyalty: {
        points: loyalty?.points ?? 0,
        lifetimePoints: loyalty?.lifetimePoints ?? 0,
      },
    }, 'Customer ID retrieved');
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to retrieve customer ID', 500);
  }
});

router.patch('/identity/profile', async (req, res) => {
  try {
    const { qrToken, guestId, customerId, name, phone = '', email = '' } = req.body;
    if (!qrToken || !guestId || !customerId || !name) return error(res, 'QR token, guest ID, customer ID and name are required', 400);
    const resolved = await resolveGuest({ qrToken, guestId, guestSessionToken: readGuestSessionToken(req) });
    if (resolved.error) return error(res, resolved.error, resolved.status);
    const { guest, table } = resolved;
    const identity = await CustomerIdentity.findOne({
      restaurant: table.restaurant,
      customerId,
      isActive: true,
      $or: [{ primaryGuestId: guest.guestId }, { linkedGuestIds: guest.guestId }],
    });
    if (!identity) return error(res, 'Customer ID not found for this session', 404);
    identity.name = String(name).trim().slice(0, 120);
    identity.phone = String(phone || '').trim().slice(0, 32);
    if (email) identity.email = String(email).trim().toLowerCase();
    await identity.save();
    await CustomerOrder.updateMany(
      { restaurant: table.restaurant, guestId: guest.guestId, isActive: true },
      { $set: { customerName: identity.name, customerPhone: identity.phone, customerEmail: identity.email } },
    );
    return success(res, {
      customerId: identity.customerId,
      customer: {
        customerId: identity.customerId,
        name: identity.name,
        phone: identity.phone || '',
        email: identity.email || '',
      },
    }, 'Profile updated');
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) return error(res, 'This email or phone is already in use', 409);
    return error(res, 'Failed to update profile', 500);
  }
});

router.post('/identity/change-password', async (req, res) => {
  try {
    const { qrToken, guestId, customerId, currentPassword, newPassword } = req.body;
    if (!qrToken || !guestId || !customerId || !currentPassword || !newPassword) {
      return error(res, 'QR token, guest ID, customer ID and passwords are required', 400);
    }
    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.valid) return error(res, passwordValidation.message, 400);
    const resolved = await resolveGuest({ qrToken, guestId, guestSessionToken: readGuestSessionToken(req) });
    if (resolved.error) return error(res, resolved.error, resolved.status);
    const { guest, table } = resolved;
    const identity = await CustomerIdentity.findOne({
      restaurant: table.restaurant,
      customerId,
      isActive: true,
      $or: [{ primaryGuestId: guest.guestId }, { linkedGuestIds: guest.guestId }],
    }).select('+passwordHash');
    if (!identity) return error(res, 'Customer ID not found for this session', 404);
    const matches = await bcrypt.compare(String(currentPassword), identity.passwordHash || '');
    if (!matches) return error(res, 'Current password is incorrect', 401);
    identity.passwordHash = await bcrypt.hash(String(newPassword), 10);
    await identity.save();
    return success(res, { changed: true }, 'Password changed');
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to change password', 500);
  }
});

router.post('/identity/claim', async (req, res) => {
  try {
    const { qrToken, guestId, name, phone = '', email = '', otp = '', password = '', purpose = 'signup' } = req.body;
    const normalizedPurpose = purpose === 'login' ? 'login' : 'signup';
    if (!qrToken || !guestId || !email || !password || (normalizedPurpose !== 'login' && !name)) {
      return error(res, 'QR token, guest ID, email, password and name are required', 400);
    }
    if (normalizedPurpose !== 'login') {
      const passwordValidation = validatePassword(password);
      if (!passwordValidation.valid) return error(res, passwordValidation.message, 400);
    }

    const resolved = await resolveGuest({ qrToken, guestId, guestSessionToken: readGuestSessionToken(req) });
    if (resolved.error) return error(res, resolved.error, resolved.status);
    const { guest, table } = resolved;
    const phoneNorm = String(phone || '').trim();
    const emailNorm = String(email || '').trim().toLowerCase();

    let identity = await CustomerIdentity.findOne({
      restaurant: table.restaurant,
      isActive: true,
      email: emailNorm,
    }).select('+passwordHash');

    if (normalizedPurpose === 'signup') {
      const otpDoc = await CustomerIdentityOtp.findOne({
        restaurant: table.restaurant,
        guestId: guest.guestId,
        email: emailNorm,
        purpose: 'signup',
      }).sort({ createdAt: -1 });
      if (!otpDoc || otpDoc.code !== String(otp).trim() || otpDoc.expiresAt < new Date()) {
        return error(res, 'Invalid or expired verification code', 400);
      }
    } else {
      if (!identity) return error(res, 'No customer ID found for this email. Please sign up first.', 404);
      if (!identity.passwordHash) return error(res, 'Password login is not set for this customer ID. Please sign up again.', 400);
      const matches = await bcrypt.compare(String(password), identity.passwordHash);
      if (!matches) return error(res, 'Invalid email or password', 401);
    }
    const nameNorm = String(name || identity?.name || 'Customer').trim();

    let created = false;
    if (!identity) {
      let customerId = generateCustomerId();
      for (let i = 0; i < 5; i += 1) {
        try {
          identity = await CustomerIdentity.create({
            customerId,
            restaurant: table.restaurant,
            name: nameNorm,
            phone: phoneNorm,
            email: emailNorm,
            passwordHash: await bcrypt.hash(String(password), 10),
            primaryGuestId: guest.guestId,
            linkedGuestIds: [guest.guestId],
            lastTable: table._id,
          });
          created = true;
          break;
        } catch (err) {
          if (err?.code !== 11000) throw err;
          customerId = generateCustomerId();
        }
      }
    }

    if (!identity) return error(res, 'Failed to create customer ID', 500);

    const primaryGuestId = guest.guestId;
    const linkedGuestIds = [...new Set([...(identity.linkedGuestIds || []), identity.primaryGuestId, guest.guestId].filter(Boolean))];
    const sourceGuestIds = linkedGuestIds.filter((id) => id !== primaryGuestId);

    await Promise.all([
      CustomerOrder.updateMany(
        { restaurant: table.restaurant, guestId: { $in: sourceGuestIds } },
        { $set: { guestId: primaryGuestId } },
      ),
      CustomerFeedback.updateMany(
        { restaurant: table.restaurant, guestId: { $in: sourceGuestIds } },
        { $set: { guestId: primaryGuestId, customerName: nameNorm } },
      ),
      GuestTableRequest.updateMany(
        { restaurant: table.restaurant, guestId: { $in: sourceGuestIds } },
        { $set: { guestId: primaryGuestId } },
      ),
      CreditCheckoutOtp.updateMany(
        { restaurant: table.restaurant, guestId: { $in: sourceGuestIds } },
        { $set: { guestId: primaryGuestId } },
      ),
    ]);

    const sourceCarts = await CustomerCart.find({
      restaurant: table.restaurant,
      table: table._id,
      guestId: { $in: sourceGuestIds },
    }).lean();
    if (sourceCarts.length) {
      const targetCart = await CustomerCart.findOneAndUpdate(
        { restaurant: table.restaurant, table: table._id, guestId: primaryGuestId },
        { $setOnInsert: { items: [], totalAmount: 0 } },
        { upsert: true, new: true },
      );
      sourceCarts.forEach((cart) => {
        targetCart.items.push(...(cart.items || []));
      });
      targetCart.totalAmount = targetCart.items.reduce(
        (sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0),
        0,
      );
      await targetCart.save();
      await CustomerCart.deleteMany({
        restaurant: table.restaurant,
        table: table._id,
        guestId: { $in: sourceGuestIds },
      });
    }

    const loyalty = await mergeLoyaltyIntoGuestId({
      fromGuestIds: linkedGuestIds,
      toGuestId: primaryGuestId,
      restaurantId: table.restaurant,
    });

    identity.name = nameNorm;
    if (phoneNorm) identity.phone = phoneNorm;
    if (emailNorm) identity.email = emailNorm;
    if (normalizedPurpose === 'signup') identity.passwordHash = await bcrypt.hash(String(password), 10);
    identity.primaryGuestId = primaryGuestId;
    identity.linkedGuestIds = linkedGuestIds;
    identity.lastTable = table._id;
    await identity.save();
    await CustomerIdentityOtp.deleteMany({
      restaurant: table.restaurant,
      guestId: guest.guestId,
      email: emailNorm,
    });

    const orderCount = await CustomerOrder.countDocuments({
      restaurant: table.restaurant,
      guestId: primaryGuestId,
      isActive: true,
    });

    return success(res, {
      created,
      customerId: identity.customerId,
      guestId: primaryGuestId,
      linkedGuestIds,
      orderCount,
      loyalty: {
        points: loyalty?.points ?? 0,
        lifetimePoints: loyalty?.lifetimePoints ?? 0,
      },
      customer: {
        customerId: identity.customerId,
        name: identity.name,
        phone: identity.phone || '',
        email: identity.email || '',
      },
    }, created ? 'Customer ID created and history migrated' : 'Customer ID found and history merged');
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) return error(res, 'This phone or email already belongs to another customer ID', 409);
    return error(res, 'Failed to create customer ID', 500);
  }
});

router.get('/dining-insights/:restaurantSlug', async (req, res) => {
  try {
    const { restaurantSlug } = req.params;
    const { qrToken, guestId } = req.query;
    if (!qrToken) return error(res, 'qrToken is required', 400);

    const restaurant = await Restaurant.findOne({
      slug: restaurantSlug,
      isActive: true,
      isDeleted: false,
    });
    if (!restaurant) return error(res, 'Restaurant not found', 404);

    const resolved = await resolveGuest({ qrToken, guestId, guestSessionToken: readGuestSessionToken(req) });
    if (resolved.error) return error(res, resolved.error, resolved.status);
    const { guest, table } = resolved;
    if (String(table.restaurant) !== String(restaurant._id)) {
      return error(res, 'Table does not belong to this restaurant', 400);
    }

    const menuBranch = await branchMenuItemBaseFilter(table);

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const trendingAgg = await CustomerOrder.aggregate([
      {
        $match: {
          restaurant: restaurant._id,
          branchId: menuBranch.branchId,
          isActive: true,
          status: { $ne: 'cancelled' },
          createdAt: { $gte: startOfDay },
        },
      },
      { $unwind: '$items' },
      { $group: { _id: '$items.menuItem', qty: { $sum: '$items.quantity' } } },
      { $sort: { qty: -1 } },
      { $limit: 12 },
    ]);

    const trendingIds = trendingAgg.map((t) => t._id).filter(Boolean);
    const trendingDocs = await MenuItem.find({
      _id: { $in: trendingIds },
      restaurant: menuBranch.restaurant,
      branchId: menuBranch.branchId,
    })
      .select('name image price highlightTag isBestseller')
      .lean();
    const byId = new Map(trendingDocs.map((i) => [String(i._id), i]));
    const trending = trendingAgg
      .map((t) => {
        const base = byId.get(String(t._id));
        if (!base) return null;
        return {
          ...base,
          orderCountToday: t.qty,
        };
      })
      .filter(Boolean);

    const recent = await CustomerOrder.find({
      restaurant: restaurant._id,
      branchId: menuBranch.branchId,
      isActive: true,
      status: { $ne: 'cancelled' },
    })
      .sort({ createdAt: -1 })
      .limit(80)
      .select('items.menuItem')
      .lean();

    const pairMap = new Map();
    for (const o of recent) {
      const ids = [...new Set((o.items || []).map((i) => String(i.menuItem)))];
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          const key = [ids[i], ids[j]].sort().join('|');
          pairMap.set(key, (pairMap.get(key) || 0) + 1);
        }
      }
    }
    const topPairs = [...pairMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const pairs = await Promise.all(
      topPairs.map(async ([key, count]) => {
        const [a, b] = key.split('|');
        const [itemA, itemB] = await Promise.all([
          MenuItem.findOne({
            _id: a,
            restaurant: menuBranch.restaurant,
            branchId: menuBranch.branchId,
          })
            .select('name image price')
            .lean(),
          MenuItem.findOne({
            _id: b,
            restaurant: menuBranch.restaurant,
            branchId: menuBranch.branchId,
          })
            .select('name image price')
            .lean(),
        ]);
        if (!itemA || !itemB) return null;
        return {
          count,
          itemA,
          itemB,
          caption: `Customers who ordered ${itemA.name} also liked ${itemB.name}.`,
        };
      }),
    );

    const pastOrders = await CustomerOrder.find({
      guestId: guest.guestId,
      restaurant: restaurant._id,
      branchId: menuBranch.branchId,
      isActive: true,
      status: { $ne: 'cancelled' },
    })
      .sort({ createdAt: -1 })
      .limit(6)
      .select('items orderNumber createdAt')
      .lean();

    const lastOrder = pastOrders[0];
    const orderAgain = lastOrder
      ? (lastOrder.items || []).map((li) => ({
          menuItemId: li.menuItem,
          name: li.name,
          quantity: li.quantity,
          customizations: li.customizations || [],
          addOns: li.addOns || [],
          cookingInstructions: li.cookingInstructions || '',
        }))
      : [];

    const loyalty = await GuestLoyalty.findOne({
      guestId: guest.guestId,
      restaurant: restaurant._id,
    }).lean();

    const hour = new Date().getHours();
    const daypart = hour < 11 ? 'breakfast' : hour < 15 ? 'lunch' : hour < 18 ? 'snack' : 'dinner';

    return success(
      res,
      {
        trending,
        pairs: pairs.filter(Boolean),
        orderAgain,
        lastOrderSummary: lastOrder
          ? { orderNumber: lastOrder.orderNumber, createdAt: lastOrder.createdAt }
          : null,
        loyalty: { points: loyalty?.points ?? 0, lifetimePoints: loyalty?.lifetimePoints ?? 0 },
        daypart,
        restaurantName: restaurant.name,
      },
      'Dining insights retrieved',
    );
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to load dining insights', 500);
  }
});

router.get('/order/:qrToken', async (req, res) => {
  try {
    const { qrToken } = req.params;
    
    const order = await CustomerOrder.findOne({ qrToken, isActive: true })
      .populate('restaurant', 'name logo slug')
      .populate('table', 'tableNumber qrToken');
    
    if (!order) {
      return error(res, 'Order not found', 404);
    }
    
    let estimatedCompletionTime = null;
    if (order.estimatedWaitTime && !['served', 'completed', 'cancelled'].includes(order.status)) {
      const confirmedAt = order.statusHistory.find(h => h.status === 'confirmed')?.timestamp || order.createdAt;
      estimatedCompletionTime = new Date(confirmedAt.getTime() + (order.estimatedWaitTime * 60 * 1000));
      if (order.kitchenDelayMinutes > 0) {
        estimatedCompletionTime = new Date(
          estimatedCompletionTime.getTime() + order.kitchenDelayMinutes * 60 * 1000,
        );
      }
    }
    const editMeta = getOrderEditMeta(order);
    
    return success(res, {
      orderId: order._id,
      qrToken: order.qrToken,
      orderNumber: order.orderNumber,
      guestId: order.guestId || null,
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      customerPaymentDeferred: Boolean(order.customerPaymentDeferred),
      guestPaymentPreferenceAt: order.guestPaymentPreferenceAt || null,
      guestPaymentPreferenceCash: Number(order.guestPaymentPreferenceCash || 0),
      guestPaymentPreferenceOnline: Number(order.guestPaymentPreferenceOnline || 0),
      isCreditSale: Boolean(order.isCreditSale),
      cashPaidAtCheckout: order.cashPaidAtCheckout || 0,
      onlinePaidAtCheckout: order.onlinePaidAtCheckout || 0,
      amountPaidTotal: order.amountPaidTotal || 0,
      customerName: order.customerName,
      tableNumber: order.table?.tableNumber,
      restaurantSlug: order.restaurant?.slug || null,
      tableQrToken: order.table?.qrToken || null,
      restaurant: {
        name: order.restaurant.name,
        logo: order.restaurant.logo,
        slug: order.restaurant.slug,
      },
      totalAmount: order.grandTotal,
      subtotal: order.totalAmount,
      taxAmount: order.taxAmount,
      discountAmount: order.discountAmount,
      serviceChargeAmount: order.posDetails?.serviceChargeAmount || 0,
      grandTotal: order.grandTotal,
      items: order.items,
      itemBatches: order.itemBatches || [],
      orderTime: order.createdAt,
      estimatedWaitTime: order.estimatedWaitTime,
      estimatedCompletionTime,
      actualWaitTime: order.actualWaitTime,
      statusHistory: order.statusHistory,
      kitchenDelayMinutes: order.kitchenDelayMinutes || 0,
      kitchenDelayMessage: order.kitchenDelayMessage || '',
      kitchenDelayUpdatedAt: order.kitchenDelayUpdatedAt,
      canEdit: editMeta.canEdit,
      editDeadline: editMeta.editDeadline,
      editSecondsRemaining: editMeta.editSecondsRemaining,
    }, 'Order details retrieved');
    
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to retrieve order', 500);
  }
});

router.patch('/order/:qrToken/items', async (req, res) => {
  try {
    const { qrToken } = req.params;
    const { guestId, items = [] } = req.body;

    if (!guestId) return error(res, 'Guest ID is required', 400);
    if (!Array.isArray(items) || items.length === 0) {
      return error(res, 'At least one order item is required', 400);
    }

    const order = await CustomerOrder.findOne({ qrToken, isActive: true });
    if (!order) return error(res, 'Order not found', 404);
    if (String(order.guestId || '') !== String(guestId)) {
      return error(res, 'Order does not match this guest session', 403);
    }
    if (!(await validateOrderGuestSession({ order, guestId, req }))) {
      return error(res, 'Guest session expired or invalid. Please scan the table QR again.', 403);
    }

    const editMeta = getOrderEditMeta(order);
    if (!editMeta.canEdit) {
      return error(res, 'This order can only be edited for 5 minutes before preparation starts', 400);
    }

    const table = await Table.findById(order.table);
    if (!table) return error(res, 'Order table not found', 404);
    const menuBranch = await branchMenuItemBaseFilter(table);
    const itemById = new Map((order.items || []).map((item) => [String(item._id), item]));
    const itemByMenuId = new Map((order.items || []).map((item) => [String(item.menuItem), item]));
    const requested = [];

    for (const row of items) {
      const id = row.itemId || row._id || row.menuItem || row.menuItemId;
      const existing = itemById.get(String(id)) || itemByMenuId.get(String(id));
      if (!existing) return error(res, 'One or more order items are invalid', 400);
      const quantity = Math.max(0, Math.floor(Number(row.quantity) || 0));
      if (quantity > 99) return error(res, 'Item quantity is too high', 400);
      const replacementMenuItemId = row.replacementMenuItemId || row.menuItemId || row.menuItem;
      let menuItem = null;
      if (replacementMenuItemId && String(replacementMenuItemId) !== String(existing.menuItem)) {
        menuItem = await MenuItem.findOne({
          _id: replacementMenuItemId,
          restaurant: menuBranch.restaurant,
          branchId: menuBranch.branchId,
          isDeleted: false,
          isAvailable: true,
        });
        if (!menuItem) return error(res, 'Replacement menu item is not available', 400);
      }
      requested.push({ existing, quantity, menuItem });
    }

    const seen = new Set();
    const nextItems = [];
    for (const { existing, quantity, menuItem } of requested) {
      const key = String(existing._id);
      if (seen.has(key)) continue;
      seen.add(key);
      if (quantity > 0) {
        if (menuItem) {
          existing.menuItem = menuItem._id;
          existing.name = menuItem.name;
          existing.price = menuItem.price;
          existing.specialInstructions = '';
          existing.cookingInstructions = '';
          existing.customizations = [];
          existing.addOns = [];
        }
        existing.quantity = quantity;
        existing.subtotal = roundMoney(Number(existing.price || 0) * quantity);
        nextItems.push(existing);
      }
    }

    if (nextItems.length === 0) {
      return error(res, 'Order must keep at least one item. Ask staff to cancel if needed.', 400);
    }

    order.items = nextItems;

    const menuIds = nextItems.map((item) => item.menuItem).filter(Boolean);
    const menuDocs = await MenuItem.find({ _id: { $in: menuIds } }).select('taxRate').lean();
    const taxRateById = new Map(menuDocs.map((doc) => [String(doc._id), Number(doc.taxRate || 0)]));
    const subtotal = roundMoney(nextItems.reduce((sum, item) => sum + Number(item.subtotal || 0), 0));
    const taxAmount = roundMoney(
      nextItems.reduce((sum, item) => {
        const taxRate = taxRateById.get(String(item.menuItem)) || 0;
        return sum + (Number(item.subtotal || 0) * taxRate) / 100;
      }, 0),
    );
    const restaurantDoc = await Restaurant.findById(order.restaurant).select('name settings').lean();
    const serviceChargeAmount = getServiceChargeAmount(restaurantDoc, subtotal);

    order.totalAmount = subtotal;
    order.taxAmount = taxAmount;
    order.posDetails = {
      ...(order.posDetails?.toObject ? order.posDetails.toObject() : order.posDetails || {}),
      serviceChargeAmount,
    };
    order.grandTotal = roundMoney(Math.max(0, subtotal + taxAmount + serviceChargeAmount - Number(order.discountAmount || 0)));
    order.statusHistory.push({
      status: order.status,
      timestamp: new Date(),
      note: 'Customer edited order within 5-minute review window',
    });
    if (order.itemBatches?.length) {
      order.itemBatches[0].items = nextItems;
      order.itemBatches[0].subtotal = subtotal;
      order.itemBatches[0].taxAmount = taxAmount;
      order.itemBatches[0].serviceChargeAmount = serviceChargeAmount;
      order.itemBatches[0].grandTotal = order.grandTotal;
      order.itemBatches[0].statusHistory.push({
        status: order.status,
        timestamp: new Date(),
        note: 'Customer edited order within 5-minute review window',
      });
    }

    const restaurantIdForEmit = order.restaurant;
    await order.save();
    await order.populate('restaurant', 'name logo slug');
    await order.populate('table', 'tableNumber qrToken');
    emitOrderUpdate(restaurantIdForEmit, order);

    const nextEditMeta = getOrderEditMeta(order);
    return success(
      res,
      {
        orderId: order._id,
        orderNumber: order.orderNumber,
        status: order.status,
        paymentStatus: order.paymentStatus,
        totalAmount: order.grandTotal,
        subtotal: order.totalAmount,
        taxAmount: order.taxAmount,
        discountAmount: order.discountAmount,
        serviceChargeAmount: order.posDetails?.serviceChargeAmount || 0,
        grandTotal: order.grandTotal,
        items: order.items,
        itemBatches: order.itemBatches || [],
        canEdit: nextEditMeta.canEdit,
        editDeadline: nextEditMeta.editDeadline,
        editSecondsRemaining: nextEditMeta.editSecondsRemaining,
      },
      'Order updated. Kitchen has been notified.',
    );
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to update order', 500);
  }
});

/**
 * After food is served: guest chooses pay now / house credit (defer-payment orders only).
 */
router.post('/order/:qrToken/pay', strictLimiter, async (req, res) => {
  try {
    const { qrToken } = req.params;
    const {
      guestId,
      checkoutTiming = 'pay_now',
      paymentMode: paymentModeBody,
      paymentMethod = 'cash',
      cashAmount = 0,
      onlineAmount = 0,
      creditEmail = '',
      creditOtp = '',
      customerEmail = '',
    } = req.body;

    if (!guestId) return error(res, 'Guest ID is required', 400);

    const order = await CustomerOrder.findOne({ qrToken, isActive: true });
    if (!order) return error(res, 'Order not found', 404);
    if (String(order.guestId || '') !== String(guestId)) {
      return error(res, 'Order does not match this guest session', 403);
    }
    if (!(await validateOrderGuestSession({ order, guestId, req }))) {
      return error(res, 'Guest session expired or invalid. Please scan the table QR again.', 403);
    }
    if (order.status !== 'served') {
      return error(res, 'Payment opens after your order is served', 400);
    }
    if (!order.customerPaymentDeferred) {
      return error(res, 'This order does not use pay-after-serve checkout', 400);
    }
    if (order.paymentStatus === 'paid') {
      return error(res, 'Already paid', 400);
    }
    if (order.isCreditSale) {
      return error(res, 'This order is already on a house account', 400);
    }

    const grandTotal = Math.max(0, Number(order.grandTotal || 0));
    const timing = checkoutTiming === 'credit' ? 'credit' : 'pay_now';

    let restaurantCreditCustomerRef = order.restaurantCreditCustomer;
    let isCreditSale = Boolean(order.isCreditSale);
    let paymentStatus = order.paymentStatus;
    let amountPaidTotal = Number(order.amountPaidTotal || 0);
    let normalizedMethod = order.paymentMethod;
    let cashPaidAtCheckout = Number(order.cashPaidAtCheckout || 0);
    let onlinePaidAtCheckout = Number(order.onlinePaidAtCheckout || 0);
    let guestPrefCash = 0;
    let guestPrefOnline = 0;

    if (timing === 'credit') {
      const emailNorm = String(creditEmail || customerEmail || order.customerEmail || '').trim().toLowerCase();
      const otpRaw = String(creditOtp || '').trim();
      if (!emailNorm || !otpRaw) {
        return error(res, 'Credit payment requires email and verification code', 400);
      }
      const ccust = await RestaurantCreditCustomer.findOne({
        restaurant: order.restaurant,
        branchId: order.branchId,
        email: emailNorm,
        status: 'approved',
      });
      if (!ccust) return error(res, 'No approved house account for this email', 403);
      const otpDoc = await CreditCheckoutOtp.findOne({
        restaurant: order.restaurant,
        email: emailNorm,
        guestId: String(guestId),
      }).sort({ createdAt: -1 });
      if (!otpDoc || otpDoc.code !== otpRaw || otpDoc.expiresAt < new Date()) {
        return error(res, 'Invalid or expired verification code', 400);
      }
      await CreditCheckoutOtp.deleteMany({
        restaurant: order.restaurant,
        email: emailNorm,
        guestId: String(guestId),
      });
      restaurantCreditCustomerRef = ccust._id;
      isCreditSale = true;
      paymentStatus = 'pending';
      amountPaidTotal = 0;
      normalizedMethod = 'credit';
      cashPaidAtCheckout = 0;
      onlinePaidAtCheckout = 0;
    } else {
      const rawMode = String(paymentModeBody || '').toLowerCase();
      const rawPm = String(paymentMethod || 'cash').toLowerCase();
      let mode = rawMode;
      if (mode !== 'cash' && mode !== 'online' && mode !== 'both') {
        mode = ['online', 'upi', 'card'].includes(rawPm) ? 'online' : 'cash';
      }
      const cashAmt = Math.max(0, Number(cashAmount) || 0);
      const onlineAmt = Math.max(0, Number(onlineAmount) || 0);

      if (mode === 'cash') {
        normalizedMethod = 'cash';
        guestPrefCash = 0;
        guestPrefOnline = 0;
      } else if (mode === 'online') {
        normalizedMethod = 'online';
        guestPrefCash = 0;
        guestPrefOnline = 0;
      } else if (mode === 'both') {
        normalizedMethod = 'mixed';
        const sum = cashAmt + onlineAmt;
        if (Math.abs(sum - grandTotal) > 0.02) {
          return error(res, 'Cash plus online must equal the order total', 400);
        }
        guestPrefCash = cashAmt;
        guestPrefOnline = onlineAmt;
      } else {
        return error(res, 'Invalid payment mode', 400);
      }
      paymentStatus = 'pending';
      amountPaidTotal = Number(order.amountPaidTotal || 0);
      cashPaidAtCheckout = 0;
      onlinePaidAtCheckout = 0;
    }

    order.restaurantCreditCustomer = restaurantCreditCustomerRef || null;
    order.isCreditSale = isCreditSale;
    order.cashPaidAtCheckout = cashPaidAtCheckout;
    order.onlinePaidAtCheckout = onlinePaidAtCheckout;
    order.paymentMethod = normalizedMethod;
    order.paymentStatus = paymentStatus;
    order.amountPaidTotal = amountPaidTotal;
    if (timing === 'credit') {
      order.customerPaymentDeferred = false;
      order.guestPaymentPreferenceAt = null;
      order.guestPaymentPreferenceCash = 0;
      order.guestPaymentPreferenceOnline = 0;
    } else {
      order.customerPaymentDeferred = true;
      order.guestPaymentPreferenceAt = new Date();
      order.guestPaymentPreferenceCash = guestPrefCash;
      order.guestPaymentPreferenceOnline = guestPrefOnline;
    }
    const em = String(customerEmail || creditEmail || '').trim();
    if (em) order.customerEmail = em;

    if (timing !== 'credit' && paymentStatus === 'paid' && order.status === 'served') {
      order.status = 'completed';
      if (Array.isArray(order.statusHistory)) {
        order.statusHistory.push({
          status: 'completed',
          timestamp: new Date(),
          note: 'Guest payment completed — thank you',
        });
      }
    }

    await order.save();

    if (timing !== 'credit' && paymentStatus === 'paid') {
      if (cashPaidAtCheckout > 0.01) {
        await Transaction.create({
          restaurant: order.restaurant,
          branchId: order.branchId,
          customerOrder: order._id,
          amount: roundMoney(cashPaidAtCheckout),
          paymentMethod: 'cash',
          status: 'success',
          notes: `Guest cash (after serve) for ${order.orderNumber}`,
        });
      }
      if (onlinePaidAtCheckout > 0.01) {
        await Transaction.create({
          restaurant: order.restaurant,
          branchId: order.branchId,
          customerOrder: order._id,
          amount: roundMoney(onlinePaidAtCheckout),
          paymentMethod: 'online',
          status: 'success',
          transactionId: `QR-ONLINE-${Date.now()}`,
          notes: `Guest online (after serve) for ${order.orderNumber}`,
        });
      }
      await ensureSalesReportForOrder(order);
      if (order.status === 'completed') {
        try {
          await applyRecipeDeductionForCompletedOrder(order, {
            userId: order.restaurant,
            userModel: 'Restaurant',
          });
        } catch (recipeErr) {
          console.error('recipeInventory deduction (guest pay)', recipeErr);
        }
      }
    }

    const billTo = String(customerEmail || creditEmail || order.customerEmail || '').trim();
    const rinfo = await Restaurant.findById(order.restaurant).select('name').lean();
    if (billTo) {
      try {
        const itemsForMail = (order.items || []).map((it) => ({
          name: it.name,
          quantity: it.quantity,
          price: it.price,
          subtotal: it.subtotal,
        }));
        if (isCreditSale) {
          await sendCreditBillEmail(billTo, {
            restaurantName: rinfo?.name,
            orderNumber: order.orderNumber,
            grandTotal: order.grandTotal,
            items: itemsForMail,
            isCreditSale: true,
          });
        } else if (paymentStatus === 'paid') {
          await sendOrderConfirmationEmail(billTo, order.orderNumber, itemsForMail, order.grandTotal);
          if (normalizedMethod === 'mixed') {
            await sendCreditBillEmail(billTo, {
              restaurantName: rinfo?.name,
              orderNumber: order.orderNumber,
              grandTotal: order.grandTotal,
              items: itemsForMail,
              isCreditSale: false,
            });
          }
        }
      } catch (mailErr) {
        console.error('post-serve payment email', mailErr);
      }
    }

    emitOrderUpdate(String(order.restaurant), order);
    if (timing !== 'credit' && paymentStatus === 'paid') {
      emitPaymentUpdate(String(order.restaurant), {
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
    }
    let nextAction = 'awaiting_staff_payment';
    if (isCreditSale) nextAction = 'credit_recorded';
    else if (paymentStatus === 'paid') nextAction = 'order_confirmed_paid';
    else if (paymentStatus === 'partial') nextAction = 'partial_online_balance_cash';

    const responseMessage =
      timing === 'credit'
        ? 'House account recorded'
        : timing === 'pay_now'
          ? 'Payment choice sent — staff will confirm when paid'
          : 'Payment recorded';

    return success(
      res,
      {
        orderId: order._id,
        orderNumber: order.orderNumber,
        paymentStatus: order.paymentStatus,
        paymentMethod: order.paymentMethod,
        isCreditSale: order.isCreditSale,
        cashPaidAtCheckout: order.cashPaidAtCheckout,
        onlinePaidAtCheckout: order.onlinePaidAtCheckout,
        guestPaymentPreferenceAt: order.guestPaymentPreferenceAt,
        guestPaymentPreferenceCash: order.guestPaymentPreferenceCash || 0,
        guestPaymentPreferenceOnline: order.guestPaymentPreferenceOnline || 0,
        nextAction,
      },
      responseMessage,
    );
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to save payment', 500);
  }
});

router.get('/orders/:guestId', async (req, res) => {
  try {
    const { guestId } = req.params;
    const { qrToken } = req.query;
    const resolved = await resolveGuest({ qrToken, guestId, guestSessionToken: readGuestSessionToken(req) });
    if (resolved.error) return error(res, resolved.error, resolved.status);
    const { guest, table } = resolved;

    const orders = await CustomerOrder.find({
      guestId: guest.guestId,
      restaurant: table.restaurant,
      branchId: table.branchId || null,
      table: table._id,
      isActive: true
    })
      .populate('table', 'tableNumber')
      .sort({ createdAt: -1 })
      .limit(50);

    return success(
      res,
      {
        guestId: guest.guestId,
        tableNumber: table.tableNumber,
        orders
      },
      'Customer orders retrieved'
    );
  } catch (err) {
    console.error(err);
    return error(res, 'Failed to retrieve customer orders', 500);
  }
});

module.exports = router;
