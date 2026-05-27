const Platform = require('../models/platform/Platform');
const PlatformPayroll = require('../models/platform/PlatformPayroll');
const PlatformPayrollSettings = require('../models/platform/PlatformPayrollSettings');
const { computeFinal, computeTdsAmount, computeEpfAmount } = require('./payrollService');

function daysInMonth(year, month) {
  return new Date(Number(year), Number(month), 0).getDate();
}

const PAYROLL_EMPLOYEE_SELECT =
  'name email employeeCode department designation salary allowance panNumber bankName bankAccountNumber bankBranch customTdsPercent customEpfPercent customEmployerEpfPercent isActive payrollEligible joiningDate phone';

async function generateMonthlyPlatformPayroll({
  month,
  year,
  generatedBy,
  defaults = {},
  platformUserId: filterUserId,
}) {
  const settings = await PlatformPayrollSettings.getSettings();
  const empQuery = {
    role: { $in: ['admin', 'support'] },
    isActive: true,
    payrollEligible: { $ne: false },
  };
  if (filterUserId) empQuery._id = filterUserId;

  const employees = await Platform.find(empQuery).select(PAYROLL_EMPLOYEE_SELECT);
  const docs = [];

  for (const e of employees) {
    const basicSalary = Number(e.salary ?? 0);
    const workingDays = Number(defaults.workingDays ?? daysInMonth(year, month));
    const absentDays = Number(defaults.absentDays ?? 0);
    const presentDays = Number(defaults.presentDays ?? Math.max(0, workingDays - absentDays));
    const latePenalty = Number(defaults.latePenalty ?? defaults.latePenalties ?? 0);
    const allowance = Object.prototype.hasOwnProperty.call(defaults, 'allowance')
      ? Number(defaults.allowance || 0)
      : Number(e.allowance ?? 0);
    const overtimeHours = Number(defaults.overtimeHours ?? 0);
    const overtimeRate = Number(defaults.overtimeRate ?? 0);
    const overtime = defaults.overtime === undefined ? null : Number(defaults.overtime ?? 0);
    const festivalBonus = Number(defaults.festivalBonus ?? 0);
    const performanceBonus = Number(defaults.performanceBonus ?? 0);
    const bonus = Number(defaults.bonus ?? 0);
    const incentive = Number(defaults.incentive ?? 0);
    const deductions = Number(defaults.deductions ?? 0);
    const advanceSalary = Number(defaults.advanceSalary ?? 0);

    const preliminary = computeFinal({
      basicSalary,
      workingDays,
      presentDays,
      absentDays,
      latePenalty,
      allowance,
      overtimeHours,
      overtimeRate,
      overtime,
      festivalBonus,
      performanceBonus,
      bonus,
      incentive,
      deductions,
      advanceSalary,
      tdsAmount: 0,
      epfAmount: 0,
    });

    const statutoryBase = Math.max(0, basicSalary);
    const rate = e.customTdsPercent != null ? Number(e.customTdsPercent) : Number(settings.defaultTdsPercent || 0);
    const tdsAmount = computeTdsAmount({
      taxableBase: statutoryBase,
      percent: rate,
      enabled: settings.enabled,
    });
    const epfRate = e.customEpfPercent != null ? Number(e.customEpfPercent) : Number(settings.defaultEpfPercent || 0);
    const epfAmount = computeEpfAmount({ basicSalary: statutoryBase, percent: epfRate });
    const employerEpfRate =
      e.customEmployerEpfPercent != null
        ? Number(e.customEmployerEpfPercent)
        : Number(settings.defaultEmployerEpfPercent || 0);
    const employerEpfAmount = computeEpfAmount({ basicSalary: statutoryBase, percent: employerEpfRate });

    const calculated = computeFinal({
      basicSalary,
      workingDays,
      presentDays,
      absentDays,
      latePenalty,
      allowance,
      overtimeHours,
      overtimeRate,
      overtime,
      festivalBonus,
      performanceBonus,
      bonus,
      incentive,
      deductions,
      advanceSalary,
      tdsAmount,
      epfAmount,
    });

    const row = await PlatformPayroll.findOneAndUpdate(
      { platformUserId: e._id, periodMonth: month, periodYear: year },
      {
        $set: {
          basicSalary,
          workingDays,
          presentDays,
          absentDays,
          lateDays: Number(defaults.lateDays ?? 0),
          attendancePay: preliminary.attendancePay,
          absentDeduction: preliminary.absentDeduction,
          latePenalty,
          allowance,
          overtimeHours,
          overtimeRate,
          overtimePay: preliminary.overtimePay,
          overtime: preliminary.overtimePay,
          festivalBonus,
          performanceBonus,
          bonus,
          incentive,
          deductions: calculated.totalDeductions,
          advanceSalary,
          tdsAmount,
          tax: tdsAmount,
          epfAmount,
          employerEpfAmount,
          grossEarnings: calculated.grossEarnings,
          finalSalary: calculated.finalSalary,
          generatedBy,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    docs.push(row);
  }
  return docs;
}

function mapRowForClient(row) {
  const obj = row.toObject ? row.toObject() : { ...row };
  if (obj.platformUserId) {
    obj.employeeId = obj.platformUserId;
  }
  return obj;
}

module.exports = {
  generateMonthlyPlatformPayroll,
  mapRowForClient,
  PAYROLL_EMPLOYEE_SELECT,
  daysInMonth,
};
