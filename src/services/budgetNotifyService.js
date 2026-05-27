const mongoose = require('mongoose');
const Budget = require('../models/restaurant/Budget');
const Expense = require('../models/restaurant/Expense');
const notificationService = require('./notificationService');

function asObjectId(v) {
  return new mongoose.Types.ObjectId(String(v));
}

async function notifyBudgetExceededIfNeeded(restaurantId, expenseDoc) {
  try {
    const rid = String(restaurantId);
    const d = new Date(expenseDoc.expenseDate);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const budget = await Budget.findOne({ restaurantId: rid, periodType: 'monthly', year, month });
    if (!budget) return;
    const line = budget.lines.find((l) => l.category === expenseDoc.category);
    if (!line) return;
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 0, 23, 59, 59, 999);
    const [agg] = await Expense.aggregate([
      {
        $match: {
          restaurantId: asObjectId(rid),
          isDeleted: false,
          category: expenseDoc.category,
          expenseDate: { $gte: start, $lte: end },
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const spent = Number(agg?.total || 0);
    if (spent <= line.amount) return;
    await notificationService.sendNotification({
      recipientType: 'restaurant',
      recipientId: rid,
      category: 'finance',
      type: 'budget_exceeded',
      priority: 'high',
      title: 'Budget exceeded',
      message: `${expenseDoc.category} spending Rs. ${spent.toFixed(0)} exceeds budget Rs. ${line.amount}.`,
      dedupeKey: `budget-${rid}-${year}-${month}-${expenseDoc.category}`,
      actionUrl: '/notifications',
    });
  } catch (e) {
    console.error('notifyBudgetExceededIfNeeded', e);
  }
}

module.exports = { notifyBudgetExceededIfNeeded };
