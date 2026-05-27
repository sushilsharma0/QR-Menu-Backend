const mongoose = require('mongoose');
const MenuItem = require('../models/restaurant/MenuItem');

const roundMoney = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const asArray = (value) => (Array.isArray(value) ? value : []);

const idString = (value) => {
  if (!value) return '';
  return String(value._id || value.id || value);
};

const cleanSelectionInput = (selection) => {
  if (!selection || typeof selection !== 'object') return null;
  const groupId = idString(selection.groupId || selection.group || selection.variationGroupId);
  const optionId = idString(selection.optionId || selection.option || selection.variationOptionId);
  if (!groupId || !optionId) return null;
  return {
    groupId,
    optionId,
    quantity: Math.max(1, Math.floor(Number(selection.quantity || 1))),
  };
};

const normalizeSelections = (rawSelections = []) => {
  const list = [];
  if (Array.isArray(rawSelections)) {
    rawSelections.forEach((selection) => {
      const clean = cleanSelectionInput(selection);
      if (clean) list.push(clean);
    });
  } else if (rawSelections && typeof rawSelections === 'object') {
    Object.entries(rawSelections).forEach(([groupId, optionValue]) => {
      asArray(Array.isArray(optionValue) ? optionValue : [optionValue]).forEach((value) => {
        const clean = cleanSelectionInput(
          typeof value === 'object'
            ? { ...value, groupId: value.groupId || groupId }
            : { groupId, optionId: value },
        );
        if (clean) list.push(clean);
      });
    });
  }

  const byPair = new Map();
  list.forEach((selection) => {
    const key = `${selection.groupId}:${selection.optionId}`;
    byPair.set(key, {
      ...selection,
      quantity: (byPair.get(key)?.quantity || 0) + selection.quantity,
    });
  });
  return [...byPair.values()];
};

const isNowInSchedule = (schedule, now = new Date(), orderType = 'qr_ordering') => {
  if (!schedule) return false;
  if (schedule.startsAt && new Date(schedule.startsAt) > now) return false;
  if (schedule.endsAt && new Date(schedule.endsAt) < now) return false;
  if (Array.isArray(schedule.daysOfWeek) && schedule.daysOfWeek.length && !schedule.daysOfWeek.includes(now.getDay())) {
    return false;
  }
  if (Array.isArray(schedule.orderTypes) && schedule.orderTypes.length && !schedule.orderTypes.includes(orderType)) {
    return false;
  }
  return true;
};

const applyDiscount = (price, discount, now = new Date()) => {
  if (!discount || discount.type === 'none' || !Number(discount.value)) return { price, discountAmount: 0 };
  if (discount.startsAt && new Date(discount.startsAt) > now) return { price, discountAmount: 0 };
  if (discount.endsAt && new Date(discount.endsAt) < now) return { price, discountAmount: 0 };
  const discountAmount =
    discount.type === 'percentage'
      ? roundMoney((price * Math.min(100, Number(discount.value))) / 100)
      : roundMoney(Math.min(price, Number(discount.value)));
  return { price: roundMoney(Math.max(0, price - discountAmount)), discountAmount };
};

const resolveOptionPrice = (option, { branchId, orderType = 'qr_ordering', now = new Date() } = {}) => {
  let price = Number(option.additionalPrice || 0);
  let discountedPrice = option.discountedPrice == null ? null : Number(option.discountedPrice);

  const branchPrice = asArray(option.branchPrices).find((row) => String(row.branchId) === String(branchId));
  if (branchPrice) {
    price = Number(branchPrice.price || 0);
    discountedPrice = branchPrice.discountedPrice == null ? discountedPrice : Number(branchPrice.discountedPrice);
  }

  const schedule = asArray(option.scheduledPrices).find((row) => isNowInSchedule(row, now, orderType));
  if (schedule) {
    if (schedule.price != null) price = Number(schedule.price);
    if (schedule.discountedPrice != null) discountedPrice = Number(schedule.discountedPrice);
  }

  let effectivePrice = discountedPrice != null && discountedPrice >= 0 ? Math.min(price, discountedPrice) : price;
  const discounted = applyDiscount(effectivePrice, option.discount, now);
  effectivePrice = discounted.price;

  return {
    price: roundMoney(Math.max(0, effectivePrice)),
    originalPrice: roundMoney(Math.max(0, price)),
    discountAmount: discounted.discountAmount,
  };
};

const resolveBasePrice = (menuItem, { branchId, orderType = 'qr_ordering', now = new Date() } = {}) => {
  let price = Number(menuItem.price || 0);
  const pricing = menuItem.variationPricing || {};

  const branchPrice = asArray(pricing.branchPrices).find((row) => String(row.branchId) === String(branchId));
  if (branchPrice) price = Number(branchPrice.price || price);

  const schedule = asArray(pricing.scheduledPrices).find((row) => isNowInSchedule(row, now, orderType));
  if (schedule?.price != null) price = Number(schedule.price);

  if (orderType === 'takeaway') price += Number(pricing.takeawayAdjustment || 0);
  if (orderType === 'delivery') price += Number(pricing.deliveryAdjustment || 0);
  if (orderType === 'dine_in') price += Number(pricing.dineInAdjustment || 0);

  const discounted = applyDiscount(price, pricing.discount, now);
  return {
    price: roundMoney(Math.max(0, discounted.price)),
    discountAmount: discounted.discountAmount,
  };
};

const getActiveVariationGroups = (menuItem) =>
  asArray(menuItem.variationGroups)
    .filter((group) => group && group.isActive !== false)
    .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));

const isTierPricingGroup = (group) => {
  if (!group) return false;
  if (group.pricingMode === 'tier') return true;
  if (group.pricingMode === 'additive') return false;
  const type = String(group.type || '').toLowerCase();
  return (
    (group.selectionType || 'single') === 'single' &&
    group.isRequired === true &&
    ['portion', 'size', 'volume', 'pieces'].includes(type)
  );
};

const validateVariationSelections = (menuItem, rawSelections = [], context = {}) => {
  const groups = getActiveVariationGroups(menuItem);
  const selections = normalizeSelections(rawSelections);
  const selectionsByGroup = new Map();
  selections.forEach((selection) => {
    const rows = selectionsByGroup.get(selection.groupId) || [];
    rows.push(selection);
    selectionsByGroup.set(selection.groupId, rows);
  });

  const selectedVariationSnapshots = [];
  const errors = [];
  const allSelectedIds = new Set();
  let variationPrice = 0;
  let addOnPrice = 0;
  let tierBasePrice = null;
  let optionDiscountAmount = 0;
  let preparationTimeModifier = 0;

  groups.forEach((group) => {
    const groupId = idString(group);
    const groupSelections = selectionsByGroup.get(groupId) || [];
    const minSelection = Number(group.minSelection ?? (group.isRequired ? 1 : 0));
    const maxSelection = Number(group.maxSelection || (group.selectionType === 'single' ? 1 : 999));
    const activeOptions = asArray(group.options).filter((option) => option && option.isAvailable !== false);
    const optionMap = new Map(activeOptions.map((option) => [idString(option), option]));

    if (group.isRequired && groupSelections.length < Math.max(1, minSelection)) {
      errors.push(`${group.name} is required`);
      return;
    }
    if (groupSelections.length < minSelection) errors.push(`${group.name} requires at least ${minSelection} selection(s)`);
    if (group.selectionType === 'single' && groupSelections.length > 1) errors.push(`${group.name} allows only one selection`);
    if (maxSelection > 0 && groupSelections.length > maxSelection) errors.push(`${group.name} allows at most ${maxSelection} selection(s)`);

    groupSelections.forEach((selection) => {
      const option = optionMap.get(selection.optionId);
      if (!option) {
        errors.push(`Invalid or unavailable option in ${group.name}`);
        return;
      }
      const quantityAllowed = group.selectionType === 'quantity' || group.allowQuantity || option.maxQuantity > 1;
      const quantity = quantityAllowed ? selection.quantity : 1;
      if (option.minQuantity && quantity < Number(option.minQuantity)) errors.push(`${option.name} requires at least ${option.minQuantity}`);
      if (option.maxQuantity && quantity > Number(option.maxQuantity)) errors.push(`${option.name} allows at most ${option.maxQuantity}`);
      if (option.trackInventory && option.stockQuantity != null && Number(option.stockQuantity) < quantity) {
        errors.push(`${option.name} is out of stock`);
      }

      allSelectedIds.add(idString(option));
      const priceInfo = resolveOptionPrice(option, context);
      const totalPrice = roundMoney(priceInfo.price * quantity);
      const isAddOn = ['addon', 'topping'].includes(group.type) || group.selectionType === 'multiple' || group.selectionType === 'quantity';
      const isTier = isTierPricingGroup(group);

      selectedVariationSnapshots.push({
        groupId: group._id,
        groupName: group.name,
        groupType: group.type,
        selectionType: group.selectionType,
        optionId: option._id,
        optionName: option.name,
        sku: option.sku || '',
        quantity,
        unitPrice: priceInfo.price,
        totalPrice,
        discountedPrice: option.discountedPrice == null ? null : Number(option.discountedPrice),
        taxRate: option.taxRate == null ? null : Number(option.taxRate),
        calories: option.calories == null ? null : Number(option.calories),
        image: option.image || '',
        preparationTimeModifier: Number(option.preparationTimeModifier || 0),
        isAddOn,
        pricingMode: isTier ? 'tier' : 'additive',
      });
      if (isAddOn) addOnPrice += totalPrice;
      else if (isTier) tierBasePrice = roundMoney((tierBasePrice || 0) + totalPrice);
      else variationPrice += totalPrice;
      optionDiscountAmount += roundMoney(priceInfo.discountAmount * quantity);
      preparationTimeModifier += Number(option.preparationTimeModifier || 0) * quantity;
    });
  });

  groups.forEach((group) => {
    asArray(group.incompatibleOptionPairs).forEach((pair) => {
      if (allSelectedIds.has(String(pair.optionA)) && allSelectedIds.has(String(pair.optionB))) {
        errors.push(pair.reason || `Invalid ${group.name} option combination`);
      }
    });
  });

  return {
    valid: errors.length === 0,
    errors,
    selectedVariations: selectedVariationSnapshots,
    variationPrice: roundMoney(variationPrice),
    addOnPrice: roundMoney(addOnPrice),
    tierBasePrice: tierBasePrice == null ? null : roundMoney(tierBasePrice),
    optionDiscountAmount: roundMoney(optionDiscountAmount),
    preparationTimeModifier,
  };
};

const calculateMenuItemPrice = (menuItem, rawSelections = [], options = {}) => {
  const base = resolveBasePrice(menuItem, options);
  const validation = validateVariationSelections(menuItem, rawSelections, options);
  const corePrice = validation.tierBasePrice != null ? validation.tierBasePrice : base.price;
  const unitBeforeTax = roundMoney(corePrice + validation.variationPrice + validation.addOnPrice);
  const discountAmount = roundMoney(base.discountAmount + validation.optionDiscountAmount);
  const taxRate = Number(menuItem.taxRate || 0);
  const taxAmount = roundMoney((unitBeforeTax * taxRate) / 100);
  return {
    ...validation,
    basePrice: base.price,
    discountAmount,
    taxRate,
    taxAmount,
    unitPrice: unitBeforeTax,
    lineSubtotal: unitBeforeTax,
    lineTotal: roundMoney(unitBeforeTax + taxAmount),
  };
};

const buildOrderLineFromMenuItem = (menuItem, item = {}, options = {}) => {
  const quantity = Math.max(1, Math.floor(Number(item.quantity || 1)));
  const selectedVariationsRaw = item.selectedVariations || item.variations || [];
  const pricing = calculateMenuItemPrice(menuItem, selectedVariationsRaw, options);
  if (!pricing.valid) {
    const err = new Error(pricing.errors.join(', '));
    err.statusCode = 400;
    throw err;
  }

  const customizations = asArray(item.customizations).map((c) => ({
    name: c.name || c.group,
    value: c.value,
  })).filter((c) => c.name && c.value);
  const addOns = asArray(item.addOns);
  const cookingInstructions = String(item.cookingInstructions || '').slice(0, 500);
  const fulfillmentMode = String(item.fulfillmentMode || '').trim() === 'parcel' ? 'parcel' : 'dine_in';
  const variationNotes = pricing.selectedVariations.map((v) => `${v.groupName}: ${v.optionName}${v.quantity > 1 ? ` x${v.quantity}` : ''}`);
  const noteParts = [];
  if (fulfillmentMode === 'parcel') noteParts.push('Fulfillment: Parcel');
  if (item.note || item.specialInstructions) noteParts.push(String(item.note || item.specialInstructions));
  if (cookingInstructions) noteParts.push(`Kitchen: ${cookingInstructions}`);
  customizations.forEach((c) => noteParts.push(`${c.name}: ${c.value}`));
  if (addOns.length) noteParts.push(`Add-ons: ${addOns.join(', ')}`);
  if (variationNotes.length) noteParts.push(`Variations: ${variationNotes.join(', ')}`);

  const subtotal = roundMoney(pricing.unitPrice * quantity);
  const taxAmount = roundMoney(pricing.taxAmount * quantity);

  return {
    menuItem: menuItem._id,
    name: menuItem.name,
    price: pricing.unitPrice,
    quantity,
    fulfillmentMode,
    specialInstructions: noteParts.join(' | ').slice(0, 1200),
    cookingInstructions,
    customizations,
    addOns,
    selectedVariations: pricing.selectedVariations,
    priceSnapshot: {
      basePrice: pricing.basePrice,
      variationPrice: pricing.variationPrice,
      addOnPrice: pricing.addOnPrice,
      discountAmount: pricing.discountAmount,
      taxRate: pricing.taxRate,
      taxAmount: pricing.taxAmount,
      unitPrice: pricing.unitPrice,
      lineSubtotal: subtotal,
      lineTotal: roundMoney(subtotal + taxAmount),
    },
    subtotal,
    taxAmount,
    preparationTimeModifier: pricing.preparationTimeModifier,
  };
};

const decrementVariationStockForOrderItems = async (orderItems = []) => {
  const updatesByItem = new Map();
  orderItems.forEach((line) => {
    const menuItemId = idString(line.menuItem);
    if (!menuItemId) return;
    asArray(line.selectedVariations).forEach((variation) => {
      if (!variation.optionId) return;
      const key = `${menuItemId}:${variation.optionId}`;
      updatesByItem.set(key, {
        menuItemId,
        optionId: idString(variation.optionId),
        quantity: (updatesByItem.get(key)?.quantity || 0) + Number(variation.quantity || 1) * Number(line.quantity || 1),
      });
    });
  });

  for (const row of updatesByItem.values()) {
    const optionObjectId = mongoose.Types.ObjectId.isValid(row.optionId)
      ? new mongoose.Types.ObjectId(row.optionId)
      : row.optionId;
    await MenuItem.updateOne(
      {
        _id: row.menuItemId,
        'variationGroups.options._id': optionObjectId,
        'variationGroups.options.trackInventory': true,
      },
      {
        $inc: { 'variationGroups.$[].options.$[option].stockQuantity': -row.quantity },
      },
      { arrayFilters: [{ 'option._id': optionObjectId, 'option.trackInventory': true }] },
    );
    await MenuItem.updateOne(
      {
        _id: row.menuItemId,
        'variationGroups.options._id': optionObjectId,
        'variationGroups.options.trackInventory': true,
        'variationGroups.options.stockQuantity': { $lte: 0 },
      },
      { $set: { 'variationGroups.$[].options.$[option].isAvailable': false, 'variationGroups.$[].options.$[option].stockQuantity': 0 } },
      { arrayFilters: [{ 'option._id': optionObjectId, 'option.trackInventory': true, 'option.stockQuantity': { $lte: 0 } }] },
    );
  }
};

module.exports = {
  isTierPricingGroup,
  roundMoney,
  normalizeSelections,
  validateVariationSelections,
  calculateMenuItemPrice,
  buildOrderLineFromMenuItem,
  decrementVariationStockForOrderItems,
};
