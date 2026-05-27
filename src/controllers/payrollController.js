const asyncHandler = require('express-async-handler');
const { success, error } = require('../utils/apiResponse');
const resolveRestaurantId = require('../middleware/restaurant/resolveRestaurantId');
const mongoose = require('mongoose');
const Payroll = require('../models/restaurant/Payroll');
const PayrollTransaction = require('../models/restaurant/PayrollTransaction');
const Expense = require('../models/restaurant/Expense');
const { notifyBudgetExceededIfNeeded } = require('../services/budgetNotifyService');
const AuditLog = require('../models/platform/AuditLog');
const TdsSettings = require('../models/restaurant/TdsSettings');
const { computeFinal, computeTdsAmount, computeEpfAmount, generateMonthlyPayroll } = require('../services/payrollService');
const notificationService = require('../services/notificationService');
const { applyCashBookDelta, expenseOutBucket, roundMoney } = require('../services/cashBookService');
const accountingSecurity = require('../services/accountingSecurityService');

function authModel(req) {
  return req.user?.scope === 'employee' ? 'Employee' : 'Restaurant';
}

function addMonths(m, y, delta) {
  let month = m + delta;
  let year = y;
  while (month > 12) {
    month -= 12;
    year += 1;
  }
  while (month < 1) {
    month += 12;
    year -= 1;
  }
  return { month, year };
}

function payrollPeriodDate(row) {
  return new Date(Number(row.periodYear), Number(row.periodMonth || 1) - 1, 1);
}

const generatePayroll = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const startMonth = Number(req.body.month || new Date().getMonth() + 1);
  const startYear = Number(req.body.year || new Date().getFullYear());
  const monthCount = Math.min(12, Math.max(1, Number(req.body.monthCount || 1)));
  const defaults = req.body.defaults || {};
  const rawEmpId = req.body.employeeId;
  const employeeId =
    rawEmpId && mongoose.Types.ObjectId.isValid(String(rawEmpId)) ? String(rawEmpId) : null;

  /** Bulk generate: block if any payroll row already exists for that English month/year (per-employee recalc still uses employeeId + upsert). */
  if (!employeeId) {
    for (let i = 0; i < monthCount; i += 1) {
      const { month, year } = addMonths(startMonth, startYear, i);
      const exists = await Payroll.findOne({
        restaurantId: rid,
        periodMonth: month,
        periodYear: year,
      })
        .select('_id')
        .lean();
      if (exists) {
        return error(
          res,
          `Payroll for ${month}/${year} is already generated. Delete unpaid rows for that period to regenerate everyone, or open an employee and use Edit pay to recalculate one person.`,
          400,
        );
      }
    }
  }

  const allDocs = [];
  const periods = [];
  for (let i = 0; i < monthCount; i++) {
    const { month, year } = addMonths(startMonth, startYear, i);
    try {
      await accountingSecurity.assertPeriodOpen({
        restaurantId: rid,
        branchId: req.branchId,
        date: new Date(year, month - 1, 1),
      });
    } catch (e) {
      return error(res, e.message, e.statusCode || 400);
    }
    periods.push({ month, year });
    const docs = await generateMonthlyPayroll({
      restaurantId: rid,
      month,
      year,
      generatedBy: req.user.id,
      generatedByModel: authModel(req),
      defaults,
      employeeId,
    });
    allDocs.push(...docs);
  }

  const pending = allDocs.filter((d) => d.paymentStatus !== 'paid').length;
  if (pending > 0) {
    const periodLabel =
      monthCount === 1
        ? `${periods[0].month}/${periods[0].year}`
        : `${periods[0].month}/${periods[0].year}–${periods[periods.length - 1].month}/${periods[periods.length - 1].year}`;
    await notificationService.sendNotification({
      recipientType: 'restaurant',
      recipientId: String(rid),
      category: 'payroll',
      type: 'payroll_pending',
      priority: 'medium',
      title: 'Payroll pending payment',
      message: `${pending} payroll record(s) for ${periodLabel} are awaiting payment.`,
      dedupeKey: `payroll-pending-${rid}-${startYear}-${startMonth}-${monthCount}`,
      actionUrl: '/notifications',
    });
  }
  return success(
    res,
    { generated: allDocs.length, payrolls: allDocs, periods, monthCount, employeeId },
    'Payroll generated',
  );
});

const getPayrolls = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const filter = { restaurantId: rid };
  if (req.query.month) filter.periodMonth = Number(req.query.month);
  if (req.query.year) filter.periodYear = Number(req.query.year);
  const rows = await Payroll.find(filter)
    .populate(
      'employeeId',
      'name role department designation panNumber bankName bankAccountNumber salary allowance',
    )
    .sort({ periodYear: -1, periodMonth: -1, createdAt: -1 });
  const transactions = await PayrollTransaction.find({
    restaurantId: rid,
    payrollId: { $in: rows.map((x) => x._id) },
  }).sort({ paidAt: -1 });
  const txByPayroll = new Map();
  for (const tx of transactions) {
    const key = String(tx.payrollId);
    if (!txByPayroll.has(key)) txByPayroll.set(key, []);
    txByPayroll.get(key).push(tx);
  }
  const items = rows.map((row) => {
    const obj = row.toObject();
    obj.transactions = txByPayroll.get(String(row._id)) || [];
    return obj;
  });
  const summary = {
    totalPayrollCost: rows.reduce((s, x) => s + Number(x.finalSalary || 0), 0),
    paidSalaries: rows.filter((x) => x.paymentStatus === 'paid').length,
    pendingSalaries: rows.filter((x) => x.paymentStatus !== 'paid').length,
    totalOvertimePay: rows.reduce((s, x) => s + Number(x.overtimePay || x.overtime || 0), 0),
    totalBonus: rows.reduce((s, x) => s + Number(x.festivalBonus || 0) + Number(x.performanceBonus || 0) + Number(x.bonus || 0), 0),
    totalTds: rows.reduce((s, x) => s + Number(x.tdsAmount || x.tax || 0), 0),
    totalEpf: rows.reduce((s, x) => s + Number(x.epfAmount || 0), 0),
    totalEmployerEpf: rows.reduce((s, x) => s + Number(x.employerEpfAmount || 0), 0),
    /** Total company cash exposure when paying salaries + remitting both EPF shares (net + employee EPF + employer EPF). */
    totalPayrollOutflow: rows.reduce(
      (s, x) =>
        s +
        Number(x.finalSalary || 0) +
        Number(x.epfAmount || 0) +
        Number(x.employerEpfAmount || 0),
      0,
    ),
  };
  return success(res, { items, summary }, 'Payrolls retrieved');
});

const getPayrollEmployeeSummary = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const year = Number(req.query.year || new Date().getFullYear());
  let monthFrom = Number(req.query.monthFrom ?? 1);
  let monthTo = Number(req.query.monthTo ?? 12);
  if (Number.isNaN(monthFrom) || monthFrom < 1) monthFrom = 1;
  if (monthFrom > 12) monthFrom = 12;
  if (Number.isNaN(monthTo) || monthTo < 1) monthTo = 12;
  if (monthTo > 12) monthTo = 12;
  if (monthFrom > monthTo) {
    const t = monthFrom;
    monthFrom = monthTo;
    monthTo = t;
  }

  const rawEmp = req.query.employeeId;
  const employeeFilter =
    rawEmp && mongoose.Types.ObjectId.isValid(String(rawEmp))
      ? { employeeId: new mongoose.Types.ObjectId(String(rawEmp)) }
      : {};

  const restaurantId = new mongoose.Types.ObjectId(String(rid));
  const periodMatch = {
    restaurantId,
    periodYear: year,
    periodMonth: { $gte: monthFrom, $lte: monthTo },
    ...employeeFilter,
  };

  const employees = await Payroll.aggregate([
    { $match: periodMatch },
    {
      $group: {
        _id: '$employeeId',
        ytdTdsWithheld: { $sum: { $ifNull: ['$tdsAmount', 0] } },
        totalNetSalaryPaid: {
          $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, { $ifNull: ['$finalSalary', 0] }, 0] },
        },
        totalNetSalaryPending: {
          $sum: { $cond: [{ $ne: ['$paymentStatus', 'paid'] }, { $ifNull: ['$finalSalary', 0] }, 0] },
        },
        ytdEmployeeEpf: { $sum: { $ifNull: ['$epfAmount', 0] } },
        ytdEmployerEpf: { $sum: { $ifNull: ['$employerEpfAmount', 0] } },
        payrollMonths: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: 'employees',
        localField: '_id',
        foreignField: '_id',
        as: 'employee',
      },
    },
    { $unwind: { path: '$employee', preserveNullAndEmptyArrays: true } },
    { $sort: { 'employee.name': 1 } },
    {
      $project: {
        _id: 0,
        employeeId: '$_id',
        name: { $ifNull: ['$employee.name', 'Unknown'] },
        panNumber: { $ifNull: ['$employee.panNumber', ''] },
        department: { $ifNull: ['$employee.department', ''] },
        ytdTdsWithheld: { $round: ['$ytdTdsWithheld', 2] },
        totalNetSalaryPaid: { $round: ['$totalNetSalaryPaid', 2] },
        totalNetSalaryPending: { $round: ['$totalNetSalaryPending', 2] },
        ytdEmployeeEpf: { $round: ['$ytdEmployeeEpf', 2] },
        ytdEmployerEpf: { $round: ['$ytdEmployerEpf', 2] },
        epfCombined: { $round: [{ $add: ['$ytdEmployeeEpf', '$ytdEmployerEpf'] }, 2] },
        payrollMonths: 1,
      },
    },
  ]);

  const totals = employees.reduce(
    (acc, r) => ({
      ytdTdsWithheld: acc.ytdTdsWithheld + Number(r.ytdTdsWithheld || 0),
      totalNetSalaryPaid: acc.totalNetSalaryPaid + Number(r.totalNetSalaryPaid || 0),
      totalNetSalaryPending: acc.totalNetSalaryPending + Number(r.totalNetSalaryPending || 0),
      ytdEmployeeEpf: acc.ytdEmployeeEpf + Number(r.ytdEmployeeEpf || 0),
      ytdEmployerEpf: acc.ytdEmployerEpf + Number(r.ytdEmployerEpf || 0),
    }),
    {
      ytdTdsWithheld: 0,
      totalNetSalaryPaid: 0,
      totalNetSalaryPending: 0,
      ytdEmployeeEpf: 0,
      ytdEmployerEpf: 0,
    },
  );
  totals.epfCombined = Number((totals.ytdEmployeeEpf + totals.ytdEmployerEpf).toFixed(2));
  totals.ytdTdsWithheld = Number(totals.ytdTdsWithheld.toFixed(2));
  totals.totalNetSalaryPaid = Number(totals.totalNetSalaryPaid.toFixed(2));
  totals.totalNetSalaryPending = Number(totals.totalNetSalaryPending.toFixed(2));
  totals.ytdEmployeeEpf = Number(totals.ytdEmployeeEpf.toFixed(2));
  totals.ytdEmployerEpf = Number(totals.ytdEmployerEpf.toFixed(2));

  const monthlyRows = await Payroll.aggregate([
    { $match: periodMatch },
    {
      $lookup: {
        from: 'employees',
        localField: 'employeeId',
        foreignField: '_id',
        as: 'emp',
      },
    },
    { $unwind: { path: '$emp', preserveNullAndEmptyArrays: true } },
    { $sort: { periodYear: -1, periodMonth: -1, 'emp.name': 1 } },
    {
      $project: {
        _id: 0,
        payrollId: '$_id',
        employeeId: 1,
        employeeName: { $ifNull: ['$emp.name', '—'] },
        department: { $ifNull: ['$emp.department', ''] },
        periodYear: 1,
        periodMonth: 1,
        paymentStatus: 1,
        netSalary: { $round: [{ $ifNull: ['$finalSalary', 0] }, 2] },
        tds: { $round: [{ $ifNull: ['$tdsAmount', 0] }, 2] },
        epfEmployee: { $round: [{ $ifNull: ['$epfAmount', 0] }, 2] },
        epfEmployer: { $round: [{ $ifNull: ['$employerEpfAmount', 0] }, 2] },
        epfTotal: {
          $round: [
            { $add: [{ $ifNull: ['$epfAmount', 0] }, { $ifNull: ['$employerEpfAmount', 0] }] },
            2,
          ],
        },
        cashOutflow: {
          $round: [
            {
              $add: [
                { $ifNull: ['$finalSalary', 0] },
                { $ifNull: ['$epfAmount', 0] },
                { $ifNull: ['$employerEpfAmount', 0] },
              ],
            },
            2,
          ],
        },
      },
    },
  ]);

  return success(
    res,
    {
      year,
      monthFrom,
      monthTo,
      employeeId: rawEmp && mongoose.Types.ObjectId.isValid(String(rawEmp)) ? String(rawEmp) : null,
      employees,
      monthlyRows,
      totals,
    },
    'Payroll employee summary',
  );
});

const deletePayroll = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const row = await Payroll.findOne({ _id: req.params.id, restaurantId: rid });
  if (!row) return error(res, 'Payroll not found', 404);
  try {
    await accountingSecurity.assertPeriodOpen({ restaurantId: rid, branchId: req.branchId, date: payrollPeriodDate(row) });
  } catch (e) {
    return error(res, e.message, e.statusCode || 400);
  }
  if (row.paymentStatus === 'paid') {
    return error(res, 'Paid payroll cannot be deleted. Records are locked after payment.', 400);
  }
  const txCount = await PayrollTransaction.countDocuments({ payrollId: row._id });
  if (txCount > 0) {
    return error(res, 'Cannot delete payroll that has payment transactions', 400);
  }
  await Payroll.deleteOne({ _id: row._id });
  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'payroll_delete',
    resource: 'system',
    details: {
      payrollId: row._id,
      periodMonth: row.periodMonth,
      periodYear: row.periodYear,
      employeeId: row.employeeId,
    },
    ipAddress: req.ip,
  });
  return success(res, null, 'Payroll deleted');
});

const updatePayroll = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const row = await Payroll.findOne({ _id: req.params.id, restaurantId: rid }).populate(
    'employeeId',
    'customTdsPercent customEpfPercent customEmployerEpfPercent',
  );
  if (!row) return error(res, 'Payroll not found', 404);
  if (row.paymentStatus === 'paid') return error(res, 'Paid payroll cannot be edited', 400);
  try {
    await accountingSecurity.assertPeriodOpen({ restaurantId: rid, branchId: req.branchId, date: payrollPeriodDate(row) });
  } catch (e) {
    return error(res, e.message, e.statusCode || 400);
  }

  const editable = [
    'workingDays',
    'presentDays',
    'absentDays',
    'lateDays',
    'latePenalty',
    'allowance',
    'overtimeHours',
    'overtimeRate',
    'festivalBonus',
    'performanceBonus',
    'bonus',
    'incentive',
    'deductions',
    'advanceSalary',
  ];
  const next = {};
  for (const key of editable) {
    next[key] = req.body[key] !== undefined ? Number(req.body[key] || 0) : Number(row[key] || 0);
  }
  next.basicSalary = req.body.basicSalary !== undefined ? Number(req.body.basicSalary || 0) : Number(row.basicSalary || 0);

  const preliminary = computeFinal({ ...next, tdsAmount: 0, epfAmount: 0 });
  const tdsSettings = await TdsSettings.getForRestaurant(rid);
  const rate = row.employeeId?.customTdsPercent != null
    ? Number(row.employeeId.customTdsPercent)
    : Number(tdsSettings.defaultTdsPercent || 0);
  const statutoryBase = Math.max(0, Number(next.basicSalary || 0));
  const tdsAmount = computeTdsAmount({
    taxableBase: statutoryBase,
    percent: rate,
    enabled: tdsSettings.enabled,
  });
  const epfRate = row.employeeId?.customEpfPercent != null
    ? Number(row.employeeId.customEpfPercent)
    : Number(tdsSettings.defaultEpfPercent || 0);
  const epfAmount = computeEpfAmount({ basicSalary: statutoryBase, percent: epfRate });
  const employerEpfRate = row.employeeId?.customEmployerEpfPercent != null
    ? Number(row.employeeId.customEmployerEpfPercent)
    : Number(tdsSettings.defaultEmployerEpfPercent || 0);
  const employerEpfAmount = computeEpfAmount({ basicSalary: statutoryBase, percent: employerEpfRate });
  const calculated = computeFinal({ ...next, tdsAmount, epfAmount });
  let approvalDoc;
  try {
    approvalDoc = await accountingSecurity.createApproval(req, {
      action: 'payroll',
      resourceType: 'payroll',
      resourceId: row._id,
      approval: req.body.approval || req.body.managerApproval || {},
      metadata: {
        employeeId: row.employeeId?._id || row.employeeId,
        periodMonth: row.periodMonth,
        periodYear: row.periodYear,
        finalSalaryBefore: row.finalSalary,
        finalSalaryAfter: calculated.finalSalary,
      },
    });
  } catch (e) {
    return error(res, e.message, e.statusCode || 403);
  }

  Object.assign(row, {
    ...next,
    attendancePay: calculated.attendancePay,
    absentDeduction: calculated.absentDeduction,
    overtimePay: calculated.overtimePay,
    overtime: calculated.overtimePay,
    deductions: calculated.totalDeductions,
    tdsAmount,
    tax: tdsAmount,
    epfAmount,
    employerEpfAmount,
    grossEarnings: calculated.grossEarnings,
    finalSalary: calculated.finalSalary,
    approval: approvalDoc._id,
  });
  await row.save();
  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'payroll_update',
    resource: 'system',
    details: {
      restaurantId: String(rid),
      branchId: req.branchId || null,
      payrollId: row._id,
      employeeId: row.employeeId?._id || row.employeeId,
      finalSalary: row.finalSalary,
      changedFields: Object.keys(req.body || {}).filter((key) => editable.includes(key) || key === 'basicSalary'),
    },
    ipAddress: req.ip,
  });
  return success(res, row, 'Payroll updated');
});

const payPayroll = asyncHandler(async (req, res) => {
  const rid = resolveRestaurantId(req);
  if (!rid) return error(res, 'Unable to resolve restaurant', 403);
  const row = await Payroll.findOne({ _id: req.params.id, restaurantId: rid }).populate(
    'employeeId',
    'name',
  );
  if (!row) return error(res, 'Payroll not found', 404);
  if (row.paymentStatus === 'paid') return error(res, 'Payroll already paid', 400);
  try {
    await accountingSecurity.assertPeriodOpen({ restaurantId: rid, branchId: req.branchId, date: payrollPeriodDate(row) });
  } catch (e) {
    return error(res, e.message, e.statusCode || 400);
  }
  let approvalDoc;
  try {
    approvalDoc = await accountingSecurity.createApproval(req, {
      action: 'payroll',
      resourceType: 'payroll_payment',
      resourceId: row._id,
      approval: req.body.approval || req.body.managerApproval || {},
      metadata: {
        employeeId: row.employeeId?._id || row.employeeId,
        periodMonth: row.periodMonth,
        periodYear: row.periodYear,
        finalSalary: row.finalSalary,
      },
    });
  } catch (e) {
    return error(res, e.message, e.statusCode || 403);
  }

  row.paymentStatus = 'paid';
  row.paymentDate = new Date();
  row.paidBy = req.user.id;
  row.paidByModel = authModel(req);
  row.approval = approvalDoc._id;
  row.lockedAt = new Date();
  await row.save();

  const netPay = Number(row.finalSalary || 0);
  const employeeEpf = Number(row.epfAmount || 0);
  const employerEpf = Number(row.employerEpfAmount || 0);
  const totalPayrollOutflow = netPay + employeeEpf + employerEpf;

  const txn = await PayrollTransaction.create({
    restaurantId: rid,
    payrollId: row._id,
    amount: netPay,
    employeeEpfAmount: employeeEpf,
    employerEpfAmount: employerEpf,
    method: req.body.method || 'bank_transfer',
    referenceId: req.body.referenceId || '',
    note: req.body.note || '',
    paidBy: req.user.id,
    paidByModel: authModel(req),
  });

  const payMethod = req.body.method || 'bank_transfer';
  const empName = row.employeeId?.name || 'Employee';
  const periodLabel = `${row.periodMonth}/${row.periodYear}`;
  let expenseDoc = await Expense.findOne({ sourcePayrollId: row._id, restaurantId: rid, isDeleted: false });
  let payrollExpenseCreated = false;
  if (!expenseDoc) {
    expenseDoc = await Expense.create({
      restaurantId: rid,
      branchId: req.branchId,
      title: `Payroll — ${empName} (${periodLabel})`,
      amount: totalPayrollOutflow,
      category: 'staff_salary',
      paymentMethod: ['cash', 'card', 'bank_transfer', 'wallet', 'upi', 'other'].includes(payMethod)
        ? payMethod
        : 'bank_transfer',
      description: `Net ${netPay.toFixed(2)}; employee EPF ${employeeEpf.toFixed(2)}; employer EPF ${employerEpf.toFixed(2)}. Total ${totalPayrollOutflow.toFixed(2)} for ${periodLabel}.`,
      notes: `source=payroll paySalary employee=${row.employeeId?._id || row.employeeId} net=${netPay} employeeEpf=${employeeEpf} employerEpf=${employerEpf}`,
      paymentStatus: 'paid',
      expenseDate: row.paymentDate,
      addedBy: req.user.id,
      addedByModel: authModel(req),
      sourcePayrollId: row._id,
    });
    payrollExpenseCreated = true;
    setImmediate(() => notifyBudgetExceededIfNeeded(rid, expenseDoc));
  }

  if (payrollExpenseCreated) {
    const amt = roundMoney(totalPayrollOutflow);
    const bucket = expenseOutBucket(payMethod);
    await applyCashBookDelta(rid, bucket === 'bank' ? { bankDelta: -amt } : { cashDelta: -amt });
  }

  await AuditLog.create({
    user: req.user.id,
    userModel: authModel(req),
    action: 'payroll_paid',
    resource: 'system',
    details: {
      payrollId: row._id,
      netPay,
      employeeEpf,
      employerEpf,
      totalOutflow: totalPayrollOutflow,
      expenseId: expenseDoc?._id,
    },
    ipAddress: req.ip,
  });

  return success(res, { payroll: row, transaction: txn, expense: expenseDoc }, 'Payroll marked as paid');
});

module.exports = {
  generatePayroll,
  getPayrolls,
  getPayrollEmployeeSummary,
  updatePayroll,
  payPayroll,
  deletePayroll,
};
