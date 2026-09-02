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
import { DEFAULT_PAYROLL_SETTINGS, type PayrollSettings } from './settings'
import { roundRupees, sumRupees } from './money'
import { redemptionCovers, type AttendanceCreditRedemption } from '../boeCredits/attendanceRedemption'

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
 *
 * `settings` is the calculation policy — every divisor, threshold and clock time
 * the arithmetic below turns on. It defaults to DEFAULT_PAYROLL_SETTINGS, which
 * is the same constant set this module used to import directly, so a caller that
 * passes nothing gets exactly the pre-settings behaviour.
 *
 * Real generation does NOT rely on that default. It passes the settings pinned
 * to the period (payroll_periods.settings_snapshot), so regenerating a month
 * reproduces the figures it was originally run with rather than silently
 * adopting whatever an admin has changed since. See ./settingsSnapshot.
 *
 * `redemptions` is the BOE Credits coverage layer (Phase 1C): days the employee
 * has paid for with credits. A covered absent or half-day line is settled at
 * ₹0 and marked `waived_by: 'boe_credits'` with the credits spent; the day's
 * classification and every attendance count are untouched, so the payslip
 * still shows what happened and that credits paid for it. Omitting the
 * argument runs payroll with no coverage, which is what every caller did
 * before credits existed.
 */
export function generatePayrollForEmployee(
  employee: EngineEmployee,
  period: EnginePeriod,
  attendanceRecords: EngineAttendanceRecord[],
  holidays: EngineHoliday[],
  pendingAdjustments: EnginePendingAdjustment[],
  corrections: AttendanceDayCorrection[] = [],
  settings: PayrollSettings = DEFAULT_PAYROLL_SETTINGS,
  redemptions: AttendanceCreditRedemption[] = [],
): EngineOutcome {
  // Step 1 — Guard checks
  const skip = runGuards(employee, period)
  if (skip) return skip

  // Step 2 — Compute monetary rates
  const rates = computeRates(employee.monthly_salary, settings)

  // Step 3 — Build the working-day calendar
  const calendar = buildWorkingDayCalendar(employee, period, holidays, settings)

  // Step 4 — Classify each working day and produce per-day deduction lines
  const dayResults = classifyAttendanceDays(calendar.workingDays, attendanceRecords, rates, corrections, settings)

  // Step 5 — Aggregate across all working days
  const aggregates = aggregateMonthlyTotals(dayResults, calendar)

  // Step 6 — Compute paid leave entitlement (based on actual days present)
  const paidLeaveAvailable = computePaidLeaveEntitlement(aggregates.days_present, settings)

  // Step 7 + 8 — Apply paid leave absorption (all three stages)
  const leaveState = applyLeaveAbsorption(aggregates, paidLeaveAvailable, settings)

  // Step 9 — Build the final deduction lines, then total them.
  //
  // The order matters and is the whole of the whole-rupee rule: each line is
  // rounded to a rupee as it is built, and every total below is a sum over those
  // rounded lines. Computing a total any other way produces a payslip whose
  // printed figures do not add up to its printed total.
  const deductionLines = buildFinalDeductionLines({ dayResults, leaveState, rates, settings, redemptions })
  const totalDeductions = computeTotalDeductions(deductionLines)

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
    settings,
    deductionLines,
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

function computeRates(monthlySalary: number, s: PayrollSettings): PayrollRates {
  const per_day_rate = monthlySalary / s.per_day_divisor
  const per_hour_rate = per_day_rate / s.full_day_hours
  return { per_day_rate, per_hour_rate }
}

// ─── Deduction line builders ─────────────────────────────────────────────────
// Every line is built through one of these, so `explain` cannot be forgotten on
// one branch and present on another — the Payroll Result Detail popup reads it
// on every line it shows.

function hourlyLine(
  date: string,
  type: PendingDeductionLine['deduction_type'],
  hours: number,
  rates: PayrollRates,
  clock?: { scheduled_minutes: number; grace_end_minutes?: number; actual_minutes: number; minutes_beyond: number },
): PendingDeductionLine {
  // The hours and the rate stay precise; the LINE is where money becomes whole.
  // `gross_amount` is rounded too — it is what this rule would have cost, shown
  // to the employee when paid leave absorbs the line, so it has to be a figure
  // the payslip could actually contain.
  const amount = roundRupees(hours * rates.per_hour_rate)
  return {
    line_date: date,
    deduction_type: type,
    hours_deducted: hours,
    amount_deducted: amount,
    explain: {
      gross_amount: amount,
      units: hours,
      unit: 'hours',
      rate: rates.per_hour_rate,
      rate_basis: 'per_hour',
      ...clock,
    },
  }
}

function dayLine(
  date: string,
  type: 'absent' | 'half_day',
  rates: PayrollRates,
  s: PayrollSettings,
): PendingDeductionLine {
  const isHalf = type === 'half_day'
  // The day fraction stays precise; the line is rounded.
  const amount = roundRupees(isHalf ? rates.per_day_rate * s.half_day_fraction : rates.per_day_rate)
  return {
    line_date: date,
    deduction_type: type,
    hours_deducted: isHalf ? s.full_day_hours * s.half_day_fraction : s.full_day_hours,
    amount_deducted: amount,
    explain: {
      gross_amount: amount,
      units: isHalf ? s.half_day_fraction : 1,
      unit: 'days',
      rate: amount,
      rate_basis: isHalf ? 'half_day' : 'per_day',
    },
  }
}

/**
 * The same line, charged to the company instead of the employee.
 *
 * The amount goes to zero and the reason is recorded; `explain.gross_amount`
 * keeps what the rule would have cost, which is what makes the popup able to
 * show the allowance as a subtraction rather than as a number that simply
 * never appeared.
 */
function waivedByPaidLeave(line: PendingDeductionLine): PendingDeductionLine {
  return { ...line, amount_deducted: 0, waived_by: 'paid_leave' }
}

/**
 * The same line, paid for by the employee's BOE Credits instead of their
 * salary (Phase 1C). `explain.gross_amount` keeps what the rule charged, and
 * `credits_redeemed` says what it cost in credits, so the popup can show both.
 */
function coveredByCredits(line: PendingDeductionLine, credits: number): PendingDeductionLine {
  return { ...line, amount_deducted: 0, waived_by: 'boe_credits', credits_redeemed: credits }
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
  s: PayrollSettings,
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
    if (dow === s.weekly_off_day) { excludedDays.push({ date, reason: 'weekly_off' }); return false }
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

function computePaidLeaveEntitlement(daysPresent: number, s: PayrollSettings): number {
  // BOE rule: leave earned is based on actual days present in the month.
  // The bands come from settings, ordered highest-first — parsePayrollSettings
  // rejects any other order, because reading top-down and taking the first band
  // reached would otherwise award the wrong allowance rather than fail visibly.
  for (const tier of s.paid_leave_tiers) {
    if (daysPresent >= tier.min_days_present) return tier.leave
  }
  return 0
}

// ─── Grace period rounding ────────────────────────────────────────────────────

// Lateness / earliness is measured from the scheduled boundary (10:00 or 18:30).
// 0–15 min → 0 deduction; after that, round UP to the next 30-min block → * 0.5h.
//
// Examples (minutes from scheduled time):
//   9  → 0h   |  16 → 0.5h  |  30 → 0.5h
//  31  → 1.0h |  38 → 1.0h  |  47 → 1.0h
//  61  → 1.5h |  67 → 1.5h  |  91 → 2.0h
function roundDeductionHours(minutesFromScheduled: number, s: PayrollSettings): number {
  if (minutesFromScheduled <= s.grace_end_minutes - s.scheduled_in_minutes) return 0
  return Math.ceil(minutesFromScheduled / s.rounding_block_minutes) * s.rounding_block_hours
}

// ─── Step 4: Classify attendance days ────────────────────────────────────────

function classifyAttendanceDays(
  workingDays: string[],
  attendanceRecords: EngineAttendanceRecord[],
  rates: PayrollRates,
  corrections: AttendanceDayCorrection[],
  s: PayrollSettings,
): DayResult[] {
  const byDate = new Map(attendanceRecords.map(r => [r.attendance_date, r]))
  const correctionByDate = new Map(corrections.map(c => [c.attendance_date, c]))
  return workingDays.map(date =>
    classifySingleDay(date, byDate.get(date), rates, s, correctionByDate.get(date)),
  )
}

function classifySingleDay(
  date: string,
  record: EngineAttendanceRecord | undefined,
  rates: PayrollRates,
  s: PayrollSettings,
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
  // Kept out of `punches` deliberately: `punches` is spread onto the DayResult,
  // and provenance is an input to the deduction rules, not a fact about the day
  // that anything downstream should render.
  const classifierInput = { ...punches, direction_source: effective.direction_source }

  // A day treatment other than 'auto' settles the day outright: the admin has
  // stated the outcome, so no punch-derived deduction line is produced for it.
  // The half-day and absent deductions still follow, because those are raised
  // from the monthly aggregates in assembleResult, not from here.
  if (correction && correction.day_treatment !== 'auto') {
    const forced: Record<'full_day' | 'half_day' | 'absent', { classification: DayClassification; hours: number }> = {
      full_day: { classification: 'full_present', hours: s.full_day_hours },
      half_day: { classification: 'half_day',     hours: s.full_day_hours * s.half_day_fraction },
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
  const classified = classifyAttendanceDay(classifierInput, s)

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
  //
  // Late arrival may stack on top, but ONLY when the punch that is present has a
  // CONFIRMED direction — the file said it was an arrival (Format A), or an
  // admin did (a correction). A direction the parser inferred from the clock is
  // not a sound basis for then charging the employee for the clock.
  //
  // This is the fix for the worst case the audit found. A Format B employee
  // whose only punch was at 18:36 used to be recorded as ARRIVING at 18:36:
  // a missing punch-out (2 h) plus roughly nine hours of "lateness", so one
  // forgotten punch cost more than the whole day's pay. The parser now reads
  // that punch as a departure, and this guard makes sure that even a lone
  // MORNING punch — which is still only a guess at being an arrival — cannot
  // carry a lateness charge.
  //
  // A missing punch-IN never reaches the late-arrival branch at all: there is no
  // arrival time to measure, whatever its provenance.
  if (classified.classification === 'missing_punch') {
    const missingLines: PendingDeductionLine[] = [
      hourlyLine(date, classified.missing_punch_type!, s.missing_punch_hours, rates),
    ]

    if (
      classified.missing_punch_type === 'missing_punch_out' &&
      classified.direction_source === 'confirmed'
    ) {
      const inMin = classified.check_in_minutes!
      if (inMin > s.grace_end_minutes) {
        const lateHours = roundDeductionHours(inMin - s.scheduled_in_minutes, s)
        if (lateHours > 0) {
          missingLines.push(hourlyLine(date, 'late_arrival', lateHours, rates, {
            scheduled_minutes:  s.scheduled_in_minutes,
            grace_end_minutes:  s.grace_end_minutes,
            actual_minutes:     inMin,
            minutes_beyond:     inMin - s.scheduled_in_minutes,
          }))
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
    const inMin  = check_in_minutes!
    const outMin = check_out_minutes!

    if (inMin > s.grace_end_minutes && !isWaived('late_arrival')) {
      const lateHours = roundDeductionHours(inMin - s.scheduled_in_minutes, s)
      if (lateHours > 0) {
        deduction_lines.push(hourlyLine(date, 'late_arrival', lateHours, rates, {
          scheduled_minutes: s.scheduled_in_minutes,
          grace_end_minutes: s.grace_end_minutes,
          actual_minutes:    inMin,
          minutes_beyond:    inMin - s.scheduled_in_minutes,
        }))
      }
    }

    if (outMin < s.scheduled_out_minutes && !isWaived('early_checkout')) {
      const earlyHours = roundDeductionHours(s.scheduled_out_minutes - outMin, s)
      if (earlyHours > 0) {
        deduction_lines.push(hourlyLine(date, 'early_checkout', earlyHours, rates, {
          scheduled_minutes: s.scheduled_out_minutes,
          grace_end_minutes: s.scheduled_out_minutes - (s.grace_end_minutes - s.scheduled_in_minutes),
          actual_minutes:    outMin,
          minutes_beyond:    s.scheduled_out_minutes - outMin,
        }))
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
  s: PayrollSettings,
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
  if (paid_leave_used === 0 && paidLeaveAvailable >= 1 && remaining_half_days >= s.half_days_per_paid_leave) {
    remaining_half_days -= s.half_days_per_paid_leave
    paid_leave_used = 1
  }

  // Stage 2b: absorb one half-day with 0.5 leave (leave must not yet be used)
  if (paid_leave_used === 0 && paidLeaveAvailable === 0.5 && remaining_half_days >= 1) {
    remaining_half_days -= 1
    paid_leave_used = 0.5
  }

  // Stage 3: absorb hourly deductions (leave must not yet be used)
  if (paid_leave_used === 0) {
    const threshold = paidLeaveAvailable * s.hours_per_paid_leave
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

/**
 * The month's deductions, summed FROM the final lines.
 *
 * Not recomputed from the aggregates. The old version multiplied
 * `remaining_absent_days × per_day_rate` and so on, which agreed with the lines
 * to the last decimal only while both ran at full precision. With lines rounded
 * to whole rupees the two would disagree — the total is the one figure an
 * employee can check by adding up the column above it, so it has to BE that sum.
 *
 * Waived lines contribute their zero, which is correct: paid leave (or the
 * employee's BOE Credits) makes the day cost nothing, and the line stays
 * visible saying so.
 */
function computeTotalDeductions(lines: PendingDeductionLine[]): TotalDeductions {
  const amountsOfType = (types: readonly string[]) =>
    lines.filter(l => types.includes(l.deduction_type)).map(l => l.amount_deducted)

  const absent_deduction   = sumRupees(amountsOfType(['absent']))
  const half_day_deduction = sumRupees(amountsOfType(['half_day']))
  const hourly_deduction   = sumRupees(amountsOfType([...HOURLY_DEDUCTION_TYPES]))
  const total_deduction    = sumRupees(lines.map(l => l.amount_deducted))

  return { absent_deduction, half_day_deduction, hourly_deduction, total_deduction }
}

// ─── Step 10: Gross salary snapshot ──────────────────────────────────────────

function computeGrossSalary(employee: EngineEmployee): number {
  // A salary is already a whole rupee in every real record; rounding it states
  // that rather than assuming it, so a legacy row carrying paise cannot make the
  // payslip fail to add up.
  return roundRupees(employee.monthly_salary)
}

// ─── Step 11: Pending adjustments ────────────────────────────────────────────

/**
 * Manual adjustments, each rounded to a whole rupee before being summed.
 *
 * Same rule as the deduction lines and for the same reason: every adjustment is
 * shown to the employee as its own line with its own reason, so each must be a
 * figure that can appear on a payslip, and the total must be the sum of what is
 * printed.
 */
function sumPendingAdjustments(adjustments: EnginePendingAdjustment[]): PendingAdjustmentsSummary {
  const additionAmounts: number[] = []
  const deductionAmounts: number[] = []

  for (const adj of adjustments) {
    const amount = roundRupees(adj.amount)
    if (amount > 0) additionAmounts.push(amount)
    else if (amount < 0) deductionAmounts.push(Math.abs(amount))
  }

  const additions  = sumRupees(additionAmounts)
  const deductions = sumRupees(deductionAmounts)
  return { additions, deductions, net_adjustment: additions - deductions }
}

// ─── Step 12: Net salary ──────────────────────────────────────────────────────

/**
 * Net salary, derived from figures that are already whole rupees.
 *
 * Gross, the deduction total and the adjustment total are each whole by the time
 * they reach here, so the subtraction is exact and no rounding is introduced at
 * this step — which is the point. Rounding the NET independently is what makes a
 * total stop matching the lines above it. roundRupees is applied only to state
 * the invariant and to normalise -0.
 */
function computeNetSalary(
  grossSalary: number,
  totalDeductions: TotalDeductions,
  pendingAdjustmentTotal: PendingAdjustmentsSummary,
): number {
  const net = grossSalary - totalDeductions.total_deduction + pendingAdjustmentTotal.net_adjustment
  return Math.max(0, roundRupees(net))
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
  settings: PayrollSettings
  /** Built and rounded before the totals, which are sums over these. */
  deductionLines: PendingDeductionLine[]
}

/**
 * Days in calendar order, by DATE — never by the order they arrived.
 *
 * The working-day calendar is already built 1..N, so `dayResults` is in date
 * order and this is a no-op today. It is stated anyway because the company-paid
 * leave rule below turns on "earliest", and a rule that says "earliest" must not
 * silently depend on a caller having sorted its attendance import. ISO dates
 * sort lexicographically, so a string compare IS a chronological compare.
 */
function byChronology(days: DayResult[]): DayResult[] {
  return [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

const HOURLY_DEDUCTION_TYPES = new Set<string>([
  'late_arrival',
  'early_checkout',
  'missing_punch_in',
  'missing_punch_out',
  'short_hours',
])

/**
 * Every deduction line the month finally carries, with paid-leave absorption
 * already applied and every amount already a whole rupee.
 *
 * This used to live inside assembleResult, which meant the lines were built
 * AFTER the totals had been computed separately from the same aggregates. That
 * was survivable while everything ran at full precision, because the two
 * calculations agreed to the last decimal. It stops being survivable once lines
 * are rounded: `round(a) + round(b)` is not `round(a + b)`, so a total computed
 * in parallel drifts from the lines printed beneath it, and a payslip whose
 * figures do not add up is indistinguishable from a payroll bug.
 *
 * So the lines are now the single source, built first, and every total is a sum
 * over them.
 */
function buildFinalDeductionLines(p: {
  dayResults: DayResult[]
  leaveState: LeaveState
  rates: PayrollRates
  settings: PayrollSettings
  redemptions: AttendanceCreditRedemption[]
}): PendingDeductionLine[] {
  // BOE Credits coverage, by date. Applied AFTER paid-leave absorption and
  // only to a line that is still chargeable: the company's allowance keeps its
  // existing "earliest day" rule untouched, and credits never cover a day that
  // already costs nothing. A redemption bought as 'absent' still covers a day
  // that has since become a half day; a half-day redemption does not stretch to
  // a full absence (redemptionCovers).
  const redemptionByDate = new Map(p.redemptions.map(r => [r.attendance_date, r]))
  const settleDayLine = (line: PendingDeductionLine, type: 'absent' | 'half_day'): PendingDeductionLine => {
    const r = redemptionByDate.get(line.line_date)
    return r && redemptionCovers(r.deduction_type, type) ? coveredByCredits(line, r.credits) : line
  }

  // Hourly deduction lines (missing punch, late arrival, short hours).
  // Stage 3 of leave absorption zeroes every one of them at once.
  const hourlyLines: PendingDeductionLine[] = p.dayResults.flatMap(day =>
    day.deduction_lines.map(line =>
      p.leaveState.leave_absorbed_deductions && HOURLY_DEDUCTION_TYPES.has(line.deduction_type)
        ? waivedByPaidLeave(line)
        : line,
    ),
  )

  // Absent-day deduction lines — one per full_absent day.
  //
  // The month's allowance settles the EARLIEST eligible day and the rest are
  // charged. That direction is the business rule, not a display preference: the
  // first leave of the month is the one on the company, so an employee who is
  // absent on the 3rd and again on the 24th has the 3rd covered.
  //
  // (It used to run the other way — `i < remaining_absent_days` charged the
  // leading days and waived the trailing one — which made the LAST absence of
  // the month the company-paid one.)
  //
  // A waived line is MARKED, not merely zeroed. That mark is what keeps the day
  // on the Deductions tab: a ₹0 line with no reason attached is
  // indistinguishable from a day that had no deduction at all, and the date used
  // to vanish from the payroll detail entirely.
  const absentDays = byChronology(p.dayResults.filter(d => d.classification === 'full_absent'))
  const absorbedAbsentDays = absentDays.length - p.leaveState.remaining_absent_days
  const absentLines: PendingDeductionLine[] = absentDays.map((day, i) => {
    const line = dayLine(day.date, 'absent', p.rates, p.settings)
    return i < absorbedAbsentDays ? waivedByPaidLeave(line) : settleDayLine(line, 'absent')
  })

  // Half-day deduction lines — one per half_day, same rule, same direction.
  const halfDays = byChronology(p.dayResults.filter(d => d.classification === 'half_day'))
  const absorbedHalfDays = halfDays.length - p.leaveState.remaining_half_days
  const halfDayLines: PendingDeductionLine[] = halfDays.map((day, i) => {
    const line = dayLine(day.date, 'half_day', p.rates, p.settings)
    return i < absorbedHalfDays ? waivedByPaidLeave(line) : settleDayLine(line, 'half_day')
  })

  return [...absentLines, ...halfDayLines, ...hourlyLines]
}

function assembleResult(p: AssembleParams): EngineResult {
  const deduction_lines = p.deductionLines

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
      // Summed through sumRupees, which refuses anything that is not already a
      // whole rupee — so a day's total cannot quietly reintroduce paise.
      total_deduction_amount: sumRupees(lines.map(l => l.amount_deducted)),
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
