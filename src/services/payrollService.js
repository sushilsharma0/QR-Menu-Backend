const Payroll = require('../models/restaurant/Payroll');
const Employee = require('../models/restaurant/Employee');
const TdsSettings = require('../models/restaurant/TdsSettings');

/** EPF % applied to full monthly basic salary (contract basic, not pro-rated). */
function computeEpfAmount({ basicSalary, percent }) {
  const rate = Number(percent || 0);
  const base = Math.max(0, Number(basicSalary || 0));
  if (rate <= 0 || base <= 0) return 0;
  return Number(((base * rate) / 100).toFixed(2));
}

function computeFinal({
  basicSalary,
  workingDays,
  presentDays,
  absentDays = 0,
  latePenalty = 0,
  allowance = 0,
  overtimeHours = 0,
  overtimeRate = 0,
  overtime = null,
  festivalBonus = 0,
  performanceBonus = 0,
  bonus = 0,
  incentive = 0,
  deductions = 0,
  advanceSalary = 0,
  tdsAmount = 0,
  epfAmount = 0,
}) {
  const normalizedWorkingDays = Math.max(1, Number(workingDays || 30));
  const normalizedPresentDays = Math.max(0, Math.min(normalizedWorkingDays, Number(presentDays ?? normalizedWorkingDays)));
  const normalizedAbsentDays = Math.max(0, Number(absentDays || Math.max(0, normalizedWorkingDays - normalizedPresentDays)));
  const dailyRate = Number(basicSalary || 0) / normalizedWorkingDays;
  const attendancePay = Number((dailyRate * normalizedPresentDays).toFixed(2));
  const absentDeduction = Number((dailyRate * normalizedAbsentDays).toFixed(2));
  const overtimePay = overtime == null
    ? Number((Number(overtimeHours || 0) * Number(overtimeRate || 0)).toFixed(2))
    : Number(overtime || 0);
  const totalBonus = Number(bonus || 0) + Number(festivalBonus || 0) + Number(performanceBonus || 0);
  const totalDeductions = Number(deductions || 0) + Number(latePenalty || 0);
  const gross =
    attendancePay +
    Number(allowance) +
    overtimePay +
    totalBonus +
    Number(incentive);
  const afterAdvDed = gross - totalDeductions - Number(advanceSalary);
  const final = Math.max(
    0,
    Number((afterAdvDed - Number(tdsAmount) - Number(epfAmount || 0)).toFixed(2)),
  );
  return {
    attendancePay,
    absentDeduction,
    overtimePay,
    totalBonus,
    totalDeductions,
    grossEarnings: Number(gross.toFixed(2)),
    finalSalary: final,
  };
}

function computeTdsAmount({ taxableBase, percent, enabled }) {
  if (!enabled || percent <= 0 || taxableBase <= 0) return 0;
  return Number(((taxableBase * percent) / 100).toFixed(2));
}

function daysInMonth(year, month) {
  return new Date(Number(year), Number(month), 0).getDate();
}

async function generateMonthlyPayroll({
  restaurantId,
  month,
  year,
  generatedBy,
  generatedByModel,
  defaults = {},
  employeeId: filterEmployeeId,
}) {
  const tdsSettings = await TdsSettings.getForRestaurant(restaurantId);

  const empQuery = { restaurant: restaurantId, isActive: true };
  if (filterEmployeeId) empQuery._id = filterEmployeeId;

  const employees = await Employee.find(empQuery).select(
    '_id salary allowance customTdsPercent customEpfPercent customEmployerEpfPercent panNumber',
  );

  const docs = [];
  for (const e of employees) {
    const basicSalary = Number(e.salary ?? 0);
    const workingDays = Number(defaults.workingDays ?? daysInMonth(year, month));
    const absentDays = Number(defaults.absentDays ?? 0);
    const presentDays = Number(defaults.presentDays ?? Math.max(0, workingDays - absentDays));
    const lateDays = Number(defaults.lateDays ?? 0);
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
    const rate = e.customTdsPercent != null ? Number(e.customTdsPercent) : Number(tdsSettings.defaultTdsPercent || 0);
    const tdsAmount = computeTdsAmount({
      taxableBase: statutoryBase,
      percent: rate,
      enabled: tdsSettings.enabled,
    });
    const epfRate = e.customEpfPercent != null ? Number(e.customEpfPercent) : Number(tdsSettings.defaultEpfPercent || 0);
    const epfAmount = computeEpfAmount({ basicSalary: statutoryBase, percent: epfRate });
    const employerEpfRate =
      e.customEmployerEpfPercent != null
        ? Number(e.customEmployerEpfPercent)
        : Number(tdsSettings.defaultEmployerEpfPercent || 0);
    const employerEpfAmount = computeEpfAmount({ basicSalary: statutoryBase, percent: employerEpfRate });

    const { grossEarnings, finalSalary } = computeFinal({
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

    const row = await Payroll.findOneAndUpdate(
      { restaurantId, employeeId: e._id, periodMonth: month, periodYear: year },
      {
        $set: {
          basicSalary,
          workingDays,
          presentDays,
          absentDays,
          lateDays,
          attendancePay: preliminary.attendancePay,
          absentDeduction: preliminary.absentDeduction,
          latePenalty,
          allowance,
          overtimeHours,
          overtimeRate,
          overtimePay: preliminary.overtimePay,
          overtime,
          festivalBonus,
          performanceBonus,
          bonus,
          incentive,
          deductions: preliminary.totalDeductions,
          advanceSalary,
          tdsAmount,
          tax: tdsAmount,
          epfAmount,
          employerEpfAmount,
          grossEarnings,
          finalSalary,
          generatedBy,
          generatedByModel,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    docs.push(row);
  }
  return docs;
}

module.exports = {
  computeFinal,
  computeTdsAmount,
  computeEpfAmount,
  generateMonthlyPayroll,
};
