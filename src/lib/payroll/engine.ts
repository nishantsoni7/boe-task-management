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
  EngineDay,
  DayClassification,
  MonthlyAggregates,
  PayrollRates,
  LeaveState,
  PendingDeductionLine,
  TotalDeductions,
  PendingAdjustmentsSummary,
} from './types'
import { classifyAttendanceDay } from '../attendance/classification'
import {
  resolveEffectiveAttendance,
  waivedDeductionTypes,
  type AttendanceDayCorrection,
  type WaivableDeductionType,
} from '../attendance/corrections'

// A forced full day is paid as the standard working day; a forced half day
// mirrors the hours the half-day deduction line already uses.
const FULL_DAY_HOURS = 8.5
const HALF_DAY_HOURS = 4.25

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Generate payroll for one employee in one period.
 * All database I/O (fetching inputs, writing outputs) is handled by the caller.
 * This function is pure: given inputs, it returns a result or a skip reason.
 *
 * `corrections` is the manual override layer. Where a correction exists for a
 * date it replaces the raw biometric punches for every downstream step —
 * classification, deductions, aggregates and totals — without the raw record
 * being altered. Omitting the argument runs payroll on raw attendance alone,
 * which is what every caller did before corrections existed.
 */
export function generatePayrollForEmployee(
  employee: EngineEmployee,
  period: EnginePeriod,
  attendanceRecords: EngineAttendanceRecord[],
  holidays: EngineHoliday[],
  pendingAdjustments: EnginePendingAdjustment[],
  corrections: AttendanceDayCorrection[] = [],
): EngineOutcome {
  // Step 1 — Guard checks
  const skip = runGuards(employee, period)
  if (skip) return skip

  // Step 2 — Compute monetary rates
  const rates = computeRates(employee.monthly_salary)

  // Step 3 — Build the working-day calendar
  const calendar = buildWorkingDayCalendar(employee, period, holidays)

  // Step 4 — Classify each working day and produce per-day deduction lines
  const dayResults = classifyAttendanceDays(calendar.workingDays, attendanceRecords, rates, corrections)

  // Step 5 — Aggregate across all working days
  const aggregates = aggregateMonthlyTotals(dayResults, calendar)

  // Step 6 — Compute paid leave entitlement (based on actual days present)
  const paidLeaveAvailable = computePaidLeaveEntitlement(aggregates.days_present)

  // Step 7 + 8 — Apply paid leave absorption (all three stages)
  const leaveState = applyLeaveAbsorption(aggregates, paidLeaveAvailable)

  // Step 9 — Compute deduction amounts
  const totalDeductions = computeTotalDeductions(leaveState, rates)

  // Step 10 — Compute gross salary
  const grossSalary = computeGrossSalary(employee)

  // Step 11 — Load pending adjustment total
  const pendingAdjustmentTotal = sumPendingAdjustments(pendingAdjustments)

  // Step 12 — Compute final net salary
  const netSalary = computeNetSalary(grossSalary, totalDeductions, pendingAdjustmentTotal)

  // Step 12a — Full-absence floor (BOE rule): 0 present days → ₹0 net salary.
  // per_day_rate = salary/30 means a fully-absent employee would otherwise keep
  // salary for non-working days (e.g. 4 Sundays). This guard eliminates that residual.
  const netSalaryFinal = aggregates.days_present === 0 ? 0 : netSalary

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
    netSalary: netSalaryFinal,
    pendingAdjustments,
    paidLeaveAvailable,
    excludedDays: calendar.excludedDays,
    attendanceRecords,
    corrections,
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
  const per_day_rate = monthlySalary / 26
  const per_hour_rate = per_day_rate / 8.5
  return { per_day_rate, per_hour_rate }
}

// ─── Step 3: Working-day calendar ────────────────────────────────────────────

type ExcludedDay = {
  date: string
  reason: Extract<DayClassification, 'weekly_off' | 'holiday' | 'pre_joining'>
}

type CalendarResult = {
  workingDays: string[]           // ISO dates in scope for this employee
  fullMonthWorkingDays: number    // denominator for paid leave proration (ignores joining_date)
  // Dates the calculation deliberately skips, with the reason. Carried only so
  // the day-level view can show a weekly off as a weekly off rather than as a
  // gap — no aggregate reads this.
  excludedDays: ExcludedDay[]
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
  const excludedDays: ExcludedDay[] = []
  const nonSundayNonHoliday = allDays.filter(date => {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
    if (dow === 0)            { excludedDays.push({ date, reason: 'weekly_off' }); return false }
    if (holidaySet.has(date)) { excludedDays.push({ date, reason: 'holiday' });    return false }
    return true
  })

  const fullMonthWorkingDays = nonSundayNonHoliday.length

  // Exclude dates before joining_date. ISO date strings sort lexicographically.
  const workingDays = employee.joining_date == null
    ? nonSundayNonHoliday
    : nonSundayNonHoliday.filter(date => {
        if (date >= employee.joining_date!) return true
        excludedDays.push({ date, reason: 'pre_joining' })
        return false
      })

  return { workingDays, fullMonthWorkingDays, excludedDays }
}

// ─── Step 6: Paid leave entitlement ──────────────────────────────────────────

function computePaidLeaveEntitlement(daysPresent: number): number {
  // BOE rule: leave earned is based on actual days present in the month.
  if (daysPresent <= 10) return 0
  if (daysPresent <= 15) return 0.5
  return 1
}

// ─── Grace period rounding ────────────────────────────────────────────────────

// Lateness / earliness is measured from the scheduled boundary (10:00 or 18:30).
// 0–15 min → 0 deduction; after that, round UP to the next 30-min block → * 0.5h.
//
// Examples (minutes from scheduled time):
//   9  → 0h   |  16 → 0.5h  |  30 → 0.5h
//  31  → 1.0h |  38 → 1.0h  |  47 → 1.0h
//  61  → 1.5h |  67 → 1.5h  |  91 → 2.0h
function roundDeductionHours(minutesFromScheduled: number): number {
  if (minutesFromScheduled <= 15) return 0
  return Math.ceil(minutesFromScheduled / 30) * 0.5
}

// ─── Step 4: Classify attendance days ────────────────────────────────────────

function classifyAttendanceDays(
  workingDays: string[],
  attendanceRecords: EngineAttendanceRecord[],
  rates: PayrollRates,
  corrections: AttendanceDayCorrection[],
): DayResult[] {
  const byDate = new Map(attendanceRecords.map(r => [r.attendance_date, r]))
  const correctionByDate = new Map(corrections.map(c => [c.attendance_date, c]))
  return workingDays.map(date =>
    classifySingleDay(date, byDate.get(date), rates, correctionByDate.get(date)),
  )
}

function classifySingleDay(
  date: string,
  record: EngineAttendanceRecord | undefined,
  rates: PayrollRates,
  correction?: AttendanceDayCorrection,
): DayResult {
  // The raw record is kept alongside the effective one so the day-level view
  // can show the admin what the machine said next to what payroll used.
  const provenance = {
    raw_check_in_at:  record?.check_in_at  ?? null,
    raw_check_out_at: record?.check_out_at ?? null,
    is_corrected:     correction != null,
  }

  const effective = resolveEffectiveAttendance(record, correction)
  const punches = { check_in_at: effective.check_in_at, check_out_at: effective.check_out_at }

  // A day treatment other than 'auto' settles the day outright: the admin has
  // stated the outcome, so no punch-derived deduction line is produced for it.
  // The half-day and absent deductions still follow, because those are raised
  // from the monthly aggregates in assembleResult, not from here.
  if (correction && correction.day_treatment !== 'auto') {
    const forced: Record<'full_day' | 'half_day' | 'absent', { classification: DayClassification; hours: number }> = {
      full_day: { classification: 'full_present', hours: FULL_DAY_HOURS },
      half_day: { classification: 'half_day',     hours: HALF_DAY_HOURS },
      absent:   { classification: 'full_absent',  hours: 0 },
    }
    const { classification, hours } = forced[correction.day_treatment]
    return {
      date,
      classification,
      effective_hours_worked: hours,
      deduction_lines: [],
      ...punches,
      ...provenance,
    }
  }

  const waivedTypes = waivedDeductionTypes(correction)
  const isWaived = (type: string) => waivedTypes.has(type as WaivableDeductionType)
  const classified = classifyAttendanceDay(punches)

  if (classified.classification === 'full_absent') {
    return {
      date,
      classification: 'full_absent',
      effective_hours_worked: 0,
      deduction_lines: [],
      ...punches,
      ...provenance,
    }
  }

  // Missing punch: exactly one punch present → 2h fixed deduction.
  // When punch-out is missing but punch-in exists, also apply late arrival if applicable.
  if (classified.classification === 'missing_punch') {
    const missingLines: PendingDeductionLine[] = [{
      line_date: date,
      deduction_type: classified.missing_punch_type!,
      hours_deducted: 2,
      amount_deducted: 2 * rates.per_hour_rate,
    }]

    if (classified.missing_punch_type === 'missing_punch_out') {
      const inMin = classified.check_in_minutes!
      const SCHEDULED_IN  = 10 * 60       // 10:00 IST
      const LATE_THRESHOLD = 10 * 60 + 15 // 10:15 IST — grace period end
      if (inMin > LATE_THRESHOLD) {
        const lateHours = roundDeductionHours(inMin - SCHEDULED_IN)
        if (lateHours > 0) {
          missingLines.push({
            line_date: date,
            deduction_type: 'late_arrival',
            hours_deducted: lateHours,
            amount_deducted: lateHours * rates.per_hour_rate,
          })
        }
      }
    }

    return {
      date,
      classification: 'missing_punch',
      effective_hours_worked: 0,
      deduction_lines: missingLines.filter(l => !isWaived(l.deduction_type)),
      ...punches,
      ...provenance,
    }
  }

  const { classification, effective_hours_worked, on_office_timing, check_in_minutes, check_out_minutes } = classified

  // Late arrival / early departure deductions — only for near-full-day presence.
  // Skipped when the office-timing override applies, and skipped for half-day / short-present
  // classifications (those carry their own deduction via the half-day mechanism).
  const deduction_lines: PendingDeductionLine[] = []
  const isNearFullDay = classification === 'full_present' || classification === 'present_with_shortfall'
  if (!on_office_timing && isNearFullDay) {
    const SCHEDULED_IN   = 10 * 60       // 10:00 IST — scheduled start
    const LATE_THRESHOLD = 10 * 60 + 15  // 10:15 IST — grace period end
    const SCHEDULED_OUT  = 18 * 60 + 30  // 18:30 IST — scheduled end / early-checkout boundary
    const inMin  = check_in_minutes!
    const outMin = check_out_minutes!

    if (inMin > LATE_THRESHOLD && !isWaived('late_arrival')) {
      const lateHours = roundDeductionHours(inMin - SCHEDULED_IN)
      if (lateHours > 0) {
        deduction_lines.push({
          line_date: date,
          deduction_type: 'late_arrival',
          hours_deducted: lateHours,
          amount_deducted: lateHours * rates.per_hour_rate,
        })
      }
    }

    if (outMin < SCHEDULED_OUT && !isWaived('early_checkout')) {
      const earlyHours = roundDeductionHours(SCHEDULED_OUT - outMin)
      if (earlyHours > 0) {
        deduction_lines.push({
          line_date: date,
          deduction_type: 'early_checkout',
          hours_deducted: earlyHours,
          amount_deducted: earlyHours * rates.per_hour_rate,
        })
      }
    }
  }

  return {
    date,
    classification,
    effective_hours_worked,
    deduction_lines,
    ...punches,
    ...provenance,
  }
}

// ─── Step 5: Monthly aggregation ─────────────────────────────────────────────

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
        case 'early_checkout':
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

// ─── Step 10: Gross salary snapshot ──────────────────────────────────────────

function computeGrossSalary(employee: EngineEmployee): number {
  return employee.monthly_salary
}

// ─── Step 11: Pending adjustments ────────────────────────────────────────────

function sumPendingAdjustments(adjustments: EnginePendingAdjustment[]): PendingAdjustmentsSummary {
  let additions = 0
  let deductions = 0

  for (const adj of adjustments) {
    if (adj.amount > 0) {
      additions += adj.amount
    } else if (adj.amount < 0) {
      deductions += Math.abs(adj.amount)
    }
  }

  return { additions, deductions, net_adjustment: additions - deductions }
}

// ─── Step 12: Net salary ──────────────────────────────────────────────────────

function computeNetSalary(
  grossSalary: number,
  totalDeductions: TotalDeductions,
  pendingAdjustmentTotal: PendingAdjustmentsSummary,
): number {
  return Math.max(0, grossSalary - totalDeductions.total_deduction + pendingAdjustmentTotal.net_adjustment)
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
  pendingAdjustmentTotal: PendingAdjustmentsSummary
  netSalary: number
  pendingAdjustments: EnginePendingAdjustment[]
  paidLeaveAvailable: number
  excludedDays: ExcludedDay[]
  attendanceRecords: EngineAttendanceRecord[]
  corrections: AttendanceDayCorrection[]
}

const HOURLY_DEDUCTION_TYPES = new Set<string>([
  'late_arrival',
  'early_checkout',
  'missing_punch_in',
  'missing_punch_out',
  'short_hours',
])

function assembleResult(p: AssembleParams): EngineResult {
  // Hourly deduction lines (missing punch, late arrival, short hours)
  const hourlyLines: PendingDeductionLine[] = p.dayResults.flatMap(day =>
    day.deduction_lines.map(line => {
      if (p.leaveState.leave_absorbed_deductions && HOURLY_DEDUCTION_TYPES.has(line.deduction_type)) {
        return { ...line, amount_deducted: 0 }
      }
      return line
    }),
  )

  // Absent-day deduction lines — one per full_absent day.
  // The first `remaining_absent_days` carry the monetary deduction; absorbed days get amount=0.
  const absentDays = p.dayResults.filter(d => d.classification === 'full_absent')
  const absentLines: PendingDeductionLine[] = absentDays.map((day, i) => ({
    line_date: day.date,
    deduction_type: 'absent',
    hours_deducted: 8.5,
    amount_deducted: i < p.leaveState.remaining_absent_days ? p.rates.per_day_rate : 0,
  }))

  // Half-day deduction lines — one per half_day.
  // The first `remaining_half_days` carry the monetary deduction; absorbed ones get amount=0.
  const halfDays = p.dayResults.filter(d => d.classification === 'half_day')
  const halfDayLines: PendingDeductionLine[] = halfDays.map((day, i) => ({
    line_date: day.date,
    deduction_type: 'half_day',
    hours_deducted: 4.25,
    amount_deducted: i < p.leaveState.remaining_half_days ? p.rates.per_day_rate / 2 : 0,
  }))

  const deduction_lines: PendingDeductionLine[] = [...absentLines, ...halfDayLines, ...hourlyLines]

  return {
    day_results: buildDayResults(p, deduction_lines),
    payroll_period_id:        p.period.id,
    employee_id:              p.employee.id,

    monthly_salary:           p.employee.monthly_salary,
    gross_salary:             p.grossSalary,

    working_days_in_month:    p.aggregates.working_days_in_month,
    days_present:             p.aggregates.days_present,
    days_absent:              p.aggregates.days_absent,
    days_on_leave:            p.leaveState.paid_leave_used,
    half_day_count:           p.aggregates.half_day_count,
    paid_leave_available:     p.leaveState.paid_leave_available,
    paid_leave_used:          p.leaveState.paid_leave_used,

    late_deduction_hours:     p.aggregates.late_deduction_hours,
    short_hours_deduction:    p.aggregates.short_hours_deduction,
    missing_punch_hours:      p.aggregates.missing_punch_hours,

    leave_absorbed_deductions: p.leaveState.leave_absorbed_deductions,

    total_deductions:         p.totalDeductions.total_deduction,
    pending_adjustment_total: p.pendingAdjustmentTotal.net_adjustment,
    net_salary:               p.netSalary,

    deduction_lines,
    applied_adjustment_ids:   p.pendingAdjustments.map(adj => adj.id),
    generated_at:             new Date().toISOString(),
  }
}

// ─── Day-level view ───────────────────────────────────────────────────────────

/**
 * Every calendar day of the period, in date order, with the deduction lines
 * that finally landed on it.
 *
 * The lines are regrouped from the assembled `deduction_lines` rather than from
 * each day's own lines, so what a date shows and what the payroll ledger holds
 * cannot drift apart: absent and half-day lines are raised during assembly, and
 * leave absorption zeroes amounts there too.
 */
function buildDayResults(p: AssembleParams, finalLines: PendingDeductionLine[]): EngineDay[] {
  const linesByDate = new Map<string, PendingDeductionLine[]>()
  for (const line of finalLines) {
    const existing = linesByDate.get(line.line_date)
    if (existing) existing.push(line)
    else linesByDate.set(line.line_date, [line])
  }

  const rawByDate        = new Map(p.attendanceRecords.map(r => [r.attendance_date, r]))
  const correctionByDate = new Map(p.corrections.map(c => [c.attendance_date, c]))

  const workedDays: EngineDay[] = p.dayResults.map(day => {
    const lines = linesByDate.get(day.date) ?? []
    return {
      ...day,
      deduction_lines: lines,
      total_deduction_amount: lines.reduce((sum, l) => sum + l.amount_deducted, 0),
    }
  })

  // Sundays, company holidays and pre-joining dates carry no calculation, but
  // they are still part of what the month was made of.
  const excluded: EngineDay[] = p.excludedDays.map(({ date, reason }) => {
    const raw        = rawByDate.get(date)
    const correction = correctionByDate.get(date)
    const effective  = resolveEffectiveAttendance(raw, correction)
    return {
      date,
      classification: reason,
      effective_hours_worked: 0,
      deduction_lines: [],
      total_deduction_amount: 0,
      check_in_at:      effective.check_in_at,
      check_out_at:     effective.check_out_at,
      raw_check_in_at:  raw?.check_in_at  ?? null,
      raw_check_out_at: raw?.check_out_at ?? null,
      is_corrected:     correction != null,
    }
  })

  return [...workedDays, ...excluded].sort((a, b) => a.date.localeCompare(b.date))
}
