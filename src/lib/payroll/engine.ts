// Payroll Calculation Engine V1
// Implements the frozen specification: docs/PAYROLL_RULES_V1.md
// No UI, no reports, no payslips. Calculation only.

import type {
  EngineEmployee,
  EnginePeriod,
  EngineAttendanceRecord,
  EngineHoliday,
  EnginePendingAdjustment,
  EngineOutcome,
  EngineSkip,
  EngineResult,
  DayResult,
  MonthlyAggregates,
  PayrollRates,
  LeaveState,
  PendingDeductionLine,
} from './types'

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Generate payroll for one employee in one period.
 * All database I/O (fetching inputs, writing outputs) is handled by the caller.
 * This function is pure: given inputs, it returns a result or a skip reason.
 */
export function generatePayrollForEmployee(
  employee: EngineEmployee,
  period: EnginePeriod,
  attendanceRecords: EngineAttendanceRecord[],
  holidays: EngineHoliday[],
  pendingAdjustments: EnginePendingAdjustment[],
): EngineOutcome {
  // Step 1 — Guard checks
  const skip = runGuards(employee, period)
  if (skip) return skip

  // Step 2 — Compute monetary rates
  const rates = computeRates(employee.monthly_salary)

  // Step 3 — Build the working-day calendar
  const calendar = buildWorkingDayCalendar(employee, period, holidays)

  // Step 4 — Compute paid leave entitlement
  const paidLeaveAvailable = computePaidLeaveEntitlement(employee, calendar)

  // Step 5 — Classify each working day and produce per-day deduction lines
  const dayResults = classifyAttendanceDays(calendar.workingDays, attendanceRecords, rates)

  // Step 6 — Aggregate across all working days
  const aggregates = aggregateMonthlyTotals(dayResults, calendar)

  // Step 7 + 8 — Apply paid leave absorption (all three stages)
  const leaveState = applyLeaveAbsorption(aggregates, paidLeaveAvailable)

  // Step 9 — Compute deduction amounts
  const totalDeductions = computeTotalDeductions(leaveState, rates)

  // Step 10 — Compute gross salary (with proration if mid-month joiner)
  const grossSalary = computeGrossSalary(employee, period)

  // Step 11 — Load pending adjustment total
  const pendingAdjustmentTotal = sumPendingAdjustments(pendingAdjustments)

  // Step 12 — Compute final net salary
  const netSalary = computeNetSalary(grossSalary, totalDeductions, pendingAdjustmentTotal)

  // Step 13 — Assemble final result (written to DB by caller)
  return assembleResult({
    employee,
    period,
    rates,
    aggregates,
    leaveState,
    dayResults,
    grossSalary,
    totalDeductions,
    pendingAdjustmentTotal,
    netSalary,
    pendingAdjustments,
    paidLeaveAvailable,
  })
}

// ─── Step 1: Guard checks ─────────────────────────────────────────────────────

function runGuards(employee: EngineEmployee, period: EnginePeriod): EngineSkip | null {
  if (period.status === 'locked') {
    return { skipped: true, reason: 'period_locked' }
  }
  if (!employee.payroll_active) {
    return { skipped: true, reason: 'employee_inactive' }
  }
  if (employee.monthly_salary == null) {
    return { skipped: true, reason: 'no_salary_configured' }
  }
  return null
}

// ─── Step 2: Monetary rates ───────────────────────────────────────────────────

function computeRates(monthlySalary: number): PayrollRates {
  const per_day_rate = monthlySalary / 30
  const per_hour_rate = per_day_rate / 8.5
  return { per_day_rate, per_hour_rate }
}

// ─── Step 3: Working-day calendar ────────────────────────────────────────────

type CalendarResult = {
  workingDays: string[]           // ISO dates in scope for this employee
  fullMonthWorkingDays: number    // denominator for paid leave proration (ignores joining_date)
}

function buildWorkingDayCalendar(
  employee: EngineEmployee,
  period: EnginePeriod,
  holidays: EngineHoliday[],
): CalendarResult {
  const { payroll_month, payroll_year } = period
  const holidaySet = new Set(holidays.map(h => h.holiday_date))

  // Build all YYYY-MM-DD strings for the month.
  // Date.UTC(year, month, 0) gives the last day of the previous month,
  // so using payroll_month (1-based) here gives last day of the target month.
  const daysInMonth = new Date(Date.UTC(payroll_year, payroll_month, 0)).getUTCDate()
  const mm = String(payroll_month).padStart(2, '0')

  const allDays: string[] = []
  for (let d = 1; d <= daysInMonth; d++) {
    allDays.push(`${payroll_year}-${mm}-${String(d).padStart(2, '0')}`)
  }

  // Exclude Sundays (UTC day-of-week = 0) and holidays.
  // UTC construction is correct here because dates are date-only values —
  // day-of-week is the same in IST and UTC for any given calendar date.
  const nonSundayNonHoliday = allDays.filter(date => {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
    return dow !== 0 && !holidaySet.has(date)
  })

  const fullMonthWorkingDays = nonSundayNonHoliday.length

  // Exclude dates before joining_date. ISO date strings sort lexicographically.
  const workingDays = employee.joining_date == null
    ? nonSundayNonHoliday
    : nonSundayNonHoliday.filter(date => date >= employee.joining_date!)

  return { workingDays, fullMonthWorkingDays }
}

// ─── Step 4: Paid leave entitlement ──────────────────────────────────────────

function computePaidLeaveEntitlement(
  employee: EngineEmployee,
  calendar: CalendarResult,
): number {
  // No joining_date means the employee was present the full month.
  if (employee.joining_date == null) return 1

  const ratio = calendar.workingDays.length / calendar.fullMonthWorkingDays
  // Round to nearest 0.5: multiply by 2, round, divide by 2.
  // Result is clamped to [0, 1] by the ratio itself (workingDays ≤ fullMonthWorkingDays).
  return Math.round(ratio * 2) / 2
}

// ─── Step 5: Classify attendance days ────────────────────────────────────────

function classifyAttendanceDays(
  workingDays: string[],
  attendanceRecords: EngineAttendanceRecord[],
  rates: PayrollRates,
): DayResult[] {
  // TODO: build a Map<date, EngineAttendanceRecord> from attendanceRecords for O(1) lookup
  // TODO: for each working day, call classifySingleDay()
  // TODO: collect and return all DayResults
  throw new Error('classifyAttendanceDays: not implemented')
}

function classifySingleDay(
  date: string,
  record: EngineAttendanceRecord | undefined,
  rates: PayrollRates,
): DayResult {
  // TODO: no record or both punches null → full_absent
  // TODO: one punch null → missing_punch (isolated: only missing_punch_in or missing_punch_out line, 2h fixed, no other deductions)
  // TODO: compute effective_hours_worked (subtract 1h lunch if straddles 1–2 PM window, in IST)
  // TODO: classify by effective hours:
  //   < 2h           → full_absent
  //   ≥ 2h and < 4h  → short_present
  //   = 4h exactly   → half_day
  //   > 4h and < 8.5 → present_with_shortfall
  //   ≥ 8.5          → full_present
  // TODO: compute late_arrival deduction (only on present days, only when check_in_at > 10:15 IST)
  // TODO: compute early_checkout deduction (only on present days, only when check_out_at < 18:30 IST)
  // TODO: compute short_hours deduction for short_present and present_with_shortfall
  // NOTE: late/early/short_hours are NOT computed on missing_punch days
  // NOTE: corrupt record (check_out before check_in) → treat as full_absent
  throw new Error('classifySingleDay: not implemented')
}

// ─── Step 6: Monthly aggregation ─────────────────────────────────────────────

function aggregateMonthlyTotals(
  dayResults: DayResult[],
  calendar: CalendarResult,
): MonthlyAggregates {
  // TODO: sum across all DayResults:
  //   days_present (full_present + present_with_shortfall + short_present + missing_punch)
  //   days_absent  (full_absent)
  //   half_day_count
  //   late_deduction_hours
  //   short_hours_deduction
  //   missing_punch_hours
  // TODO: working_days_in_month = calendar.workingDays.length
  // TODO: full_month_working_days = calendar.fullMonthWorkingDays
  throw new Error('aggregateMonthlyTotals: not implemented')
}

// ─── Steps 7 + 8: Leave absorption ───────────────────────────────────────────

function applyLeaveAbsorption(
  aggregates: MonthlyAggregates,
  paidLeaveAvailable: number,
): LeaveState {
  // TODO Stage 1: absorb one full absent day (only if paidLeaveAvailable >= 1)
  // TODO Stage 2: absorb two half-days (only if paidLeaveAvailable >= 1 and leave unused)
  // TODO Stage 2b: absorb one half-day (only if paidLeaveAvailable = 0.5 and leave unused)
  // TODO Stage 3: absorb hourly deductions if total_hourly_hours <= (paidLeaveAvailable × 8.5) and leave unused
  //   set leave_absorbed_deductions = true, remaining_hourly_hours = 0
  // Each stage is skipped if leave was already consumed by a prior stage
  throw new Error('applyLeaveAbsorption: not implemented')
}

// ─── Step 9: Deduction amounts ────────────────────────────────────────────────

function computeTotalDeductions(
  leaveState: LeaveState,
  rates: PayrollRates,
): number {
  // TODO: absent_deduction     = leaveState.remaining_absent_days × rates.per_day_rate
  // TODO: half_day_deduction   = leaveState.remaining_half_days × (rates.per_day_rate / 2)
  // TODO: hourly_deduction     = leaveState.remaining_hourly_hours × rates.per_hour_rate
  // TODO: return sum of all three
  throw new Error('computeTotalDeductions: not implemented')
}

// ─── Step 10: Gross salary with proration ────────────────────────────────────

function computeGrossSalary(
  employee: EngineEmployee,
  period: EnginePeriod,
): number {
  // TODO: if joining_date is null or falls before this month → gross = monthly_salary (no proration)
  // TODO: if joining_date falls within this payroll month:
  //   eligible_payable_days = calendar days from joining_date to last day of month (inclusive)
  //   gross = monthly_salary / 30 × eligible_payable_days
  // NOTE: divisor is always 30 (not working days) per the frozen spec
  throw new Error('computeGrossSalary: not implemented')
}

// ─── Step 11: Pending adjustments ────────────────────────────────────────────

function sumPendingAdjustments(adjustments: EnginePendingAdjustment[]): number {
  // TODO: return sum of all adjustment.amount values
  // positive = credit, negative = deduction
  throw new Error('sumPendingAdjustments: not implemented')
}

// ─── Step 12: Net salary ──────────────────────────────────────────────────────

function computeNetSalary(
  grossSalary: number,
  totalDeductions: number,
  pendingAdjustmentTotal: number,
): number {
  // TODO: return grossSalary - totalDeductions + pendingAdjustmentTotal
  throw new Error('computeNetSalary: not implemented')
}

// ─── Step 13: Assemble engine result ─────────────────────────────────────────

type AssembleParams = {
  employee: EngineEmployee
  period: EnginePeriod
  rates: PayrollRates
  aggregates: MonthlyAggregates
  leaveState: LeaveState
  dayResults: DayResult[]
  grossSalary: number
  totalDeductions: number
  pendingAdjustmentTotal: number
  netSalary: number
  pendingAdjustments: EnginePendingAdjustment[]
  paidLeaveAvailable: number
}

function assembleResult(p: AssembleParams): EngineResult {
  // TODO: collect all deduction_lines from p.dayResults into a flat array
  // TODO: zero out amount_deducted on hourly lines if leaveState.leave_absorbed_deductions = true
  // TODO: map p.pendingAdjustments to applied_adjustment_ids
  // TODO: set generated_at = new Date().toISOString()
  // TODO: populate all EngineResult fields from the assembled params
  throw new Error('assembleResult: not implemented')
}
