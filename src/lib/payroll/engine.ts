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
  TotalDeductions,
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
  const byDate = new Map(attendanceRecords.map(r => [r.attendance_date, r]))
  return workingDays.map(date => classifySingleDay(date, byDate.get(date), rates))
}

// Returns minutes-since-midnight in IST for an ISO timestamptz string.
function istMinutes(ts: string): number {
  const istMs = new Date(ts).getTime() + 330 * 60 * 1000
  const d = new Date(istMs)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

function classifySingleDay(
  date: string,
  record: EngineAttendanceRecord | undefined,
  rates: PayrollRates,
): DayResult {
  const absent: DayResult = { date, classification: 'full_absent', effective_hours_worked: 0, deduction_lines: [] }

  // No record or both punches missing → full_absent
  if (!record || (record.check_in_at == null && record.check_out_at == null)) return absent

  // Missing punch: exactly one punch present → isolated 2h deduction, no other lines
  if (record.check_in_at == null || record.check_out_at == null) {
    const type = record.check_in_at == null ? 'missing_punch_in' : 'missing_punch_out'
    return {
      date,
      classification: 'missing_punch',
      effective_hours_worked: 0,
      deduction_lines: [{
        line_date: date,
        deduction_type: type,
        hours_deducted: 2,
        amount_deducted: 2 * rates.per_hour_rate,
      }],
    }
  }

  const inMs  = new Date(record.check_in_at).getTime()
  const outMs = new Date(record.check_out_at).getTime()

  // Corrupt record: check_out before check_in → full_absent
  if (outMs <= inMs) return absent

  const rawHours = (outMs - inMs) / 3_600_000

  // Lunch deduction: subtract 1h if check_in < 14:00 AND check_out > 13:00 (IST)
  const inMin  = istMinutes(record.check_in_at)
  const outMin = istMinutes(record.check_out_at)
  const lunchDeducted = inMin < 14 * 60 && outMin > 13 * 60
  const effectiveHours = rawHours - (lunchDeducted ? 1 : 0)

  // Classify by effective hours
  let classification: DayResult['classification']
  if (effectiveHours >= 8.5) {
    classification = 'full_present'
  } else if (effectiveHours > 4) {
    classification = 'present_with_shortfall'
  } else if (effectiveHours === 4) {
    classification = 'half_day'
  } else if (effectiveHours >= 2) {
    classification = 'short_present'
  } else {
    return { ...absent }
  }

  return { date, classification, effective_hours_worked: effectiveHours, deduction_lines: [] }
}

// ─── Step 6: Monthly aggregation ─────────────────────────────────────────────

function aggregateMonthlyTotals(
  dayResults: DayResult[],
  calendar: CalendarResult,
): MonthlyAggregates {
  let days_present = 0
  let days_absent = 0
  let half_day_count = 0
  let late_deduction_hours = 0
  let short_hours_deduction = 0
  let missing_punch_hours = 0

  for (const day of dayResults) {
    switch (day.classification) {
      case 'full_present':
      case 'present_with_shortfall':
      case 'short_present':
      case 'missing_punch':
        days_present++
        break
      case 'half_day':
        days_present++
        half_day_count++
        break
      case 'full_absent':
        days_absent++
        break
    }

    for (const line of day.deduction_lines) {
      switch (line.deduction_type) {
        case 'late_arrival':
          late_deduction_hours += line.hours_deducted
          break
        case 'short_hours':
          short_hours_deduction += line.hours_deducted
          break
        case 'missing_punch_in':
        case 'missing_punch_out':
          missing_punch_hours += line.hours_deducted
          break
      }
    }
  }

  return {
    working_days_in_month: calendar.workingDays.length,
    full_month_working_days: calendar.fullMonthWorkingDays,
    days_present,
    days_absent,
    half_day_count,
    late_deduction_hours,
    short_hours_deduction,
    missing_punch_hours,
  }
}

// ─── Steps 7 + 8: Leave absorption ───────────────────────────────────────────

function applyLeaveAbsorption(
  aggregates: MonthlyAggregates,
  paidLeaveAvailable: number,
): LeaveState {
  let remaining_absent_days = aggregates.days_absent
  let remaining_half_days   = aggregates.half_day_count
  let paid_leave_used       = 0
  let leave_absorbed_deductions = false

  const total_hourly_hours =
    aggregates.late_deduction_hours +
    aggregates.short_hours_deduction +
    aggregates.missing_punch_hours

  // Stage 1: absorb one full absent day
  if (paidLeaveAvailable >= 1 && remaining_absent_days >= 1) {
    remaining_absent_days -= 1
    paid_leave_used = 1
  }

  // Stage 2: absorb two half-days (leave must not yet be used)
  if (paid_leave_used === 0 && paidLeaveAvailable >= 1 && remaining_half_days >= 2) {
    remaining_half_days -= 2
    paid_leave_used = 1
  }

  // Stage 2b: absorb one half-day with 0.5 leave (leave must not yet be used)
  if (paid_leave_used === 0 && paidLeaveAvailable === 0.5 && remaining_half_days >= 1) {
    remaining_half_days -= 1
    paid_leave_used = 0.5
  }

  // Stage 3: absorb hourly deductions (leave must not yet be used)
  if (paid_leave_used === 0) {
    const threshold = paidLeaveAvailable * 8.5
    if (total_hourly_hours > 0 && total_hourly_hours <= threshold) {
      leave_absorbed_deductions = true
      paid_leave_used = paidLeaveAvailable
    }
  }

  return {
    paid_leave_available: paidLeaveAvailable,
    paid_leave_used,
    leave_absorbed_deductions,
    remaining_absent_days,
    remaining_half_days,
    remaining_hourly_hours: leave_absorbed_deductions ? 0 : total_hourly_hours,
  }
}

// ─── Step 9: Deduction amounts ────────────────────────────────────────────────

function computeTotalDeductions(
  leaveState: LeaveState,
  rates: PayrollRates,
): TotalDeductions {
  const absent_deduction   = leaveState.remaining_absent_days  * rates.per_day_rate
  const half_day_deduction = leaveState.remaining_half_days    * (rates.per_day_rate / 2)
  const hourly_deduction   = leaveState.remaining_hourly_hours * rates.per_hour_rate
  const total_deduction    = absent_deduction + half_day_deduction + hourly_deduction
  return { absent_deduction, half_day_deduction, hourly_deduction, total_deduction }
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
  totalDeductions: TotalDeductions,
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
  totalDeductions: TotalDeductions
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
