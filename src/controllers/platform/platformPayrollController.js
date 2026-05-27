const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Platform = require('../../models/platform/Platform');
const PlatformPayroll = require('../../models/platform/PlatformPayroll');
const PlatformExpense = require('../../models/platform/PlatformExpense');
const PlatformPayrollSettings = require('../../models/platform/PlatformPayrollSettings');
const AuditLog = require('../../models/platform/AuditLog');
const { success, error } = require('../../utils/apiResponse');
const {
  generateMonthlyPlatformPayroll,
  mapRowForClient,
  PAYROLL_EMPLOYEE_SELECT,
} = require('../../services/platformPayrollService');
const { generateNextEmployeeCode } = require('../../services/platformEmployeeCodeService');
const { computeFinal, computeTdsAmount, computeEpfAmount } = require('../../services/payrollService');

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

const listPayrollEmployees = asyncHandler(async (req, res) => {
  const query = {
    role: { $in: ['admin', 'support'] },
    payrollEligible: { $ne: false },
  };
  const rows = await Platform.find(query).select(PAYROLL_EMPLOYEE_SELECT).sort({ employeeCode: 1, name: 1 });

  for (const row of rows) {
    if (!row.employeeCode) {
      row.employeeCode = await generateNextEmployeeCode();
      await row.save();
    }
  }

  return success(res, rows, 'Platform payroll employees retrieved');
});

const getPayrollEmployee = asyncHandler(async (req, res) => {
  const row = await Platform.findOne({
    _id: req.params.id,
    role: { $in: ['admin', 'support'] },
  }).select(PAYROLL_EMPLOYEE_SELECT);
  if (!row) return error(res, 'Employee not found', 404);
  return success(res, row, 'Employee retrieved');
});

const getPayrolls = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.month) filter.periodMonth = Number(req.query.month);
  if (req.query.year) filter.periodYear = Number(req.query.year);

  const rows = await PlatformPayroll.find(filter)
    .populate('platformUserId', PAYROLL_EMPLOYEE_SELECT)
    .sort({ periodYear: -1, periodMonth: -1, createdAt: -1 });

  const items = rows.map((row) => mapRowForClient(row));
  const summary = {
    totalPayrollCost: rows.reduce((s, x) => s + Number(x.finalSalary || 0), 0),
    paidSalaries: rows.filter((x) => x.paymentStatus === 'paid').length,
    pendingSalaries: rows.filter((x) => x.paymentStatus !== 'paid').length,
    totalOvertimePay: rows.reduce((s, x) => s + Number(x.overtimePay || x.overtime || 0), 0),
    totalBonus: rows.reduce(
      (s, x) => s + Number(x.festivalBonus || 0) + Number(x.performanceBonus || 0) + Number(x.bonus || 0),
      0,
    ),
    totalTds: rows.reduce((s, x) => s + Number(x.tdsAmount || x.tax || 0), 0),
    totalEpf: rows.reduce((s, x) => s + Number(x.epfAmount || 0), 0),
    totalEmployerEpf: rows.reduce((s, x) => s + Number(x.employerEpfAmount || 0), 0),
    totalPayrollOutflow: rows.reduce(
      (s, x) => s + Number(x.finalSalary || 0) + Number(x.epfAmount || 0) + Number(x.employerEpfAmount || 0),
      0,
    ),
  };
  return success(res, { items, summary }, 'Platform payroll retrieved');
});

const generatePayroll = asyncHandler(async (req, res) => {
  const startMonth = Number(req.body.month || new Date().getMonth() + 1);
  const startYear = Number(req.body.year || new Date().getFullYear());
  const monthCount = Math.min(12, Math.max(1, Number(req.body.monthCount || 1)));
  const defaults = req.body.defaults || {};
  const rawUserId = req.body.employeeId || req.body.platformUserId;
  const platformUserId =
    rawUserId && mongoose.Types.ObjectId.isValid(String(rawUserId)) ? String(rawUserId) : null;

  if (!platformUserId) {
    for (let i = 0; i < monthCount; i += 1) {
      const { month, year } = addMonths(startMonth, startYear, i);
      const exists = await PlatformPayroll.findOne({ periodMonth: month, periodYear: year }).select('_id').lean();
      if (exists) {
        return error(
          res,
          `Payroll for ${month}/${year} is already generated. Delete unpaid rows for that period to regenerate, or recalculate one employee from the editor.`,
          400,
        );
      }
    }
  }

  const allDocs = [];
  const periods = [];
  for (let i = 0; i < monthCount; i += 1) {
    const { month, year } = addMonths(startMonth, startYear, i);
    periods.push({ month, year });
    const docs = await generateMonthlyPlatformPayroll({
      month,
      year,
      generatedBy: req.user.id,
      defaults,
      platformUserId,
    });
    allDocs.push(...docs);
  }

  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'platform_payroll_generate',
    resource: 'system',
    details: { periods, generated: allDocs.length, platformUserId },
    ipAddress: req.ip,
  });

  return success(
    res,
    { generated: allDocs.length, payrolls: allDocs.map(mapRowForClient), periods, monthCount, employeeId: platformUserId },
    'Payroll generated',
  );
});

const payPayroll = asyncHandler(async (req, res) => {
  const row = await PlatformPayroll.findById(req.params.id).populate(
    'platformUserId',
    'name employeeCode department designation',
  );
  if (!row) return error(res, 'Payroll not found', 404);
  if (row.paymentStatus === 'paid') return error(res, 'Payroll already paid', 400);

  row.paymentStatus = 'paid';
  row.paymentDate = new Date();
  row.paidBy = req.user.id;
  await row.save();

  const emp = row.platformUserId;
  const netPay = Number(row.finalSalary || 0);
  const employeeEpf = Number(row.epfAmount || 0);
  const employerEpf = Number(row.employerEpfAmount || 0);
  const totalOutflow = netPay + employeeEpf + employerEpf;
  const payMethod = ['cash', 'card', 'bank_transfer', 'wallet', 'upi', 'other'].includes(req.body?.method)
    ? req.body.method
    : 'bank_transfer';
  const periodLabel = `${row.periodMonth}/${row.periodYear}`;
  const empLabel = emp?.employeeCode ? `${emp.employeeCode} — ${emp.name}` : emp?.name || 'Staff';

  let expenseDoc = await PlatformExpense.findOne({ sourcePayrollId: row._id, isDeleted: false });
  if (!expenseDoc) {
    expenseDoc = await PlatformExpense.create({
      title: `Payroll — ${empLabel} (${periodLabel})`,
      amount: totalOutflow,
      category: 'staff_salary',
      paymentMethod: payMethod,
      description: `Net ${netPay.toFixed(2)}; employee EPF ${employeeEpf.toFixed(2)}; employer EPF ${employerEpf.toFixed(2)}.`,
      notes: `source=platform_payroll payrollId=${row._id}`,
      paymentStatus: 'paid',
      expenseDate: row.paymentDate,
      addedBy: req.user.id,
      sourcePayrollId: row._id,
    });
  }

  await AuditLog.create({
    user: req.user.id,
    userModel: 'Platform',
    action: 'platform_payroll_paid',
    resource: 'system',
    details: {
      payrollId: row._id,
      netPay,
      employeeEpf,
      employerEpf,
      expenseId: expenseDoc._id,
    },
    ipAddress: req.ip,
  });

  return success(
    res,
    { ...mapRowForClient(row), expenseId: expenseDoc._id },
    'Salary marked as paid and expense recorded',
  );
});

const deletePayroll = asyncHandler(async (req, res) => {
  const row = await PlatformPayroll.findById(req.params.id);
  if (!row) return error(res, 'Payroll not found', 404);
  if (row.paymentStatus === 'paid') return error(res, 'Paid payroll cannot be deleted', 400);
  await row.deleteOne();
  return success(res, null, 'Payroll deleted');
});

const updatePayroll = asyncHandler(async (req, res) => {
  const row = await PlatformPayroll.findById(req.params.id).populate(
    'platformUserId',
    'customTdsPercent customEpfPercent customEmployerEpfPercent',
  );
  if (!row) return error(res, 'Payroll not found', 404);
  if (row.paymentStatus === 'paid') return error(res, 'Paid payroll cannot be edited', 400);

  const settings = await PlatformPayrollSettings.getSettings();
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

  const emp = row.platformUserId;
  const preliminary = computeFinal({ ...next, tdsAmount: 0, epfAmount: 0 });
  const rate = emp?.customTdsPercent != null ? Number(emp.customTdsPercent) : Number(settings.defaultTdsPercent || 0);
  const statutoryBase = Math.max(0, Number(next.basicSalary || 0));
  const tdsAmount = computeTdsAmount({ taxableBase: statutoryBase, percent: rate, enabled: settings.enabled });
  const epfRate = emp?.customEpfPercent != null ? Number(emp.customEpfPercent) : Number(settings.defaultEpfPercent || 0);
  const epfAmount = computeEpfAmount({ basicSalary: statutoryBase, percent: epfRate });
  const employerEpfRate =
    emp?.customEmployerEpfPercent != null
      ? Number(emp.customEmployerEpfPercent)
      : Number(settings.defaultEmployerEpfPercent || 0);
  const employerEpfAmount = computeEpfAmount({ basicSalary: statutoryBase, percent: employerEpfRate });
  const calculated = computeFinal({ ...next, tdsAmount, epfAmount });

  Object.assign(row, {
    ...next,
    attendancePay: preliminary.attendancePay,
    absentDeduction: preliminary.absentDeduction,
    overtimePay: preliminary.overtimePay,
    overtime: preliminary.overtimePay,
    deductions: calculated.totalDeductions,
    tdsAmount,
    tax: tdsAmount,
    epfAmount,
    employerEpfAmount,
    grossEarnings: calculated.grossEarnings,
    finalSalary: calculated.finalSalary,
  });
  await row.save();
  await row.populate('platformUserId', PAYROLL_EMPLOYEE_SELECT);
  return success(res, mapRowForClient(row), 'Payroll updated');
});

const getPayrollEmployeeSummary = asyncHandler(async (req, res) => {
  const year = Number(req.query.year || new Date().getFullYear());
  let monthFrom = Number(req.query.monthFrom ?? 1);
  let monthTo = Number(req.query.monthTo ?? 12);
  if (monthFrom > monthTo) [monthFrom, monthTo] = [monthTo, monthFrom];

  const rawEmp = req.query.employeeId;
  const match = { periodYear: year, periodMonth: { $gte: monthFrom, $lte: monthTo } };
  if (rawEmp && mongoose.Types.ObjectId.isValid(String(rawEmp))) {
    match.platformUserId = new mongoose.Types.ObjectId(String(rawEmp));
  }

  const employees = await PlatformPayroll.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$platformUserId',
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
        from: 'platforms',
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
        employeeCode: { $ifNull: ['$employee.employeeCode', ''] },
        name: { $ifNull: ['$employee.name', 'Unknown'] },
        panNumber: { $ifNull: ['$employee.panNumber', ''] },
        department: { $ifNull: ['$employee.department', ''] },
        designation: { $ifNull: ['$employee.designation', ''] },
        ytdTdsWithheld: { $round: ['$ytdTdsWithheld', 2] },
        totalNetSalaryPaid: { $round: ['$totalNetSalaryPaid', 2] },
        totalNetSalaryPending: { $round: ['$totalNetSalaryPending', 2] },
        ytdEmployeeEpf: { $round: ['$ytdEmployeeEpf', 2] },
        ytdEmployerEpf: { $round: ['$ytdEmployerEpf', 2] },
        payrollMonths: 1,
      },
    },
  ]);

  return success(res, { year, monthFrom, monthTo, employees }, 'Employee payroll summary retrieved');
});

const getPayrollSettings = asyncHandler(async (req, res) => {
  const doc = await PlatformPayrollSettings.getSettings();
  return success(res, doc, 'Payroll settings retrieved');
});

const updatePayrollSettings = asyncHandler(async (req, res) => {
  const doc = await PlatformPayrollSettings.getSettings();
  if (req.body.defaultTdsPercent !== undefined) doc.defaultTdsPercent = Number(req.body.defaultTdsPercent);
  if (req.body.defaultEpfPercent !== undefined) doc.defaultEpfPercent = Number(req.body.defaultEpfPercent);
  if (req.body.defaultEmployerEpfPercent !== undefined) {
    doc.defaultEmployerEpfPercent = Number(req.body.defaultEmployerEpfPercent);
  }
  if (req.body.enabled !== undefined) doc.enabled = Boolean(req.body.enabled);
  await doc.save();
  return success(res, doc, 'Payroll settings updated');
});

module.exports = {
  listPayrollEmployees,
  getPayrollEmployee,
  getPayrolls,
  generatePayroll,
  payPayroll,
  deletePayroll,
  updatePayroll,
  getPayrollEmployeeSummary,
  getPayrollSettings,
  updatePayrollSettings,
};
