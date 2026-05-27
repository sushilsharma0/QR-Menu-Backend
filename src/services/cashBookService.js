const mongoose = require('mongoose');
const Restaurant = require('../models/restaurant/Restaurant');

function roundMoney(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

/** Expense.paymentMethod → which physical balance moves */
function expenseOutBucket(paymentMethod) {
  const m = String(paymentMethod || 'cash').toLowerCase();
  if (m === 'cash') return 'cash';
  if (['bank_transfer', 'card', 'upi', 'wallet'].includes(m)) return 'bank';
  return 'cash';
}

function purchaseOutBucket(paymentSource) {
  return String(paymentSource || 'cash').toLowerCase() === 'bank' ? 'bank' : 'cash';
}

function purchasePaidAmount(doc) {
  return roundMoney(Number(doc.totalCost || 0) + Number(doc.taxAmount || 0));
}

function expensePaidAmount(doc) {
  return roundMoney(Number(doc.amount || 0));
}

/** Negative delta = money left the business (paid supplier / expense). */
async function applyCashBookDelta(restaurantId, { cashDelta = 0, bankDelta = 0 }) {
  const c = roundMoney(cashDelta);
  const b = roundMoney(bankDelta);
  if (c === 0 && b === 0) return;
  await Restaurant.updateOne(
    { _id: new mongoose.Types.ObjectId(String(restaurantId)) },
    { $inc: { 'settings.cashBalance': c, 'settings.bankBalance': b } },
  );
}

function purchaseDeltas(doc) {
  if (String(doc.paymentStatus || '') !== 'paid') return { cash: 0, bank: 0 };
  const amt = purchasePaidAmount(doc);
  if (amt <= 0) return { cash: 0, bank: 0 };
  const bucket = purchaseOutBucket(doc.paymentSource);
  return bucket === 'bank' ? { cash: 0, bank: -amt } : { cash: -amt, bank: 0 };
}

function expenseDeltas(doc) {
  if (String(doc.paymentStatus || '') !== 'paid') return { cash: 0, bank: 0 };
  if (doc.sourcePayrollId || doc.sourceInventoryLogId) return { cash: 0, bank: 0 };
  const amt = expensePaidAmount(doc);
  if (amt <= 0) return { cash: 0, bank: 0 };
  const bucket = expenseOutBucket(doc.paymentMethod);
  return bucket === 'bank' ? { cash: 0, bank: -amt } : { cash: -amt, bank: 0 };
}

async function applyPurchaseCreate(restaurantId, purchaseDoc) {
  const { cash, bank } = purchaseDeltas(purchaseDoc);
  await applyCashBookDelta(restaurantId, { cashDelta: cash, bankDelta: bank });
}

async function applyPurchaseReplace(restaurantId, beforeDoc, afterDoc) {
  const prev = purchaseDeltas(beforeDoc);
  const next = purchaseDeltas(afterDoc);
  await applyCashBookDelta(restaurantId, {
    cashDelta: roundMoney(-prev.cash + next.cash),
    bankDelta: roundMoney(-prev.bank + next.bank),
  });
}

async function applyPurchaseDelete(restaurantId, purchaseDoc) {
  const { cash, bank } = purchaseDeltas(purchaseDoc);
  await applyCashBookDelta(restaurantId, { cashDelta: -cash, bankDelta: -bank });
}

async function applyExpenseCreate(restaurantId, expenseDoc) {
  const { cash, bank } = expenseDeltas(expenseDoc);
  await applyCashBookDelta(restaurantId, { cashDelta: cash, bankDelta: bank });
}

async function applyExpenseReplace(restaurantId, beforeDoc, afterDoc) {
  const prev = expenseDeltas(beforeDoc);
  const next = expenseDeltas(afterDoc);
  await applyCashBookDelta(restaurantId, {
    cashDelta: roundMoney(-prev.cash + next.cash),
    bankDelta: roundMoney(-prev.bank + next.bank),
  });
}

async function applyExpenseSoftDelete(restaurantId, expenseDoc) {
  const { cash, bank } = expenseDeltas(expenseDoc);
  await applyCashBookDelta(restaurantId, { cashDelta: -cash, bankDelta: -bank });
}

module.exports = {
  roundMoney,
  expenseOutBucket,
  purchaseOutBucket,
  purchasePaidAmount,
  expensePaidAmount,
  applyCashBookDelta,
  applyPurchaseCreate,
  applyPurchaseReplace,
  applyPurchaseDelete,
  applyExpenseCreate,
  applyExpenseReplace,
  applyExpenseSoftDelete,
};
