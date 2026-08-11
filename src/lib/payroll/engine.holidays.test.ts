/**
 * What an unregistered public holiday actually costs an employee.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * `payroll_holidays` is empty in production. The structural audit inferred from
 * that alone that "public holidays are charged as absences", which is an
 * inference about a calendar, not a proven statement about a payslip. This test
 * settles it through the real engine.
 *
 * The mechanism is in buildWorkingDayCalendar: a date not in `holidays` stays in
 * the working-day list, and a day the office was closed has no punches, so it
 * classifies as `full_absent`. Whether that reaches the employee's pay depends
 * on the paid-leave allowance, which is exactly the part an empty-table
 * observation cannot tell you.
 *
 * Run:
 *   npx tsx --test src/lib/payroll/engine.holidays.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { generatePayrollForEmployee } from './engine'
import { isSkip } from './types'
import type {
  EngineEmployee, EnginePeriod, EngineAttendanceRecord, EngineHoliday, EngineResult,
} from './types'
import { PER_DAY_DIVISOR, PAID_LEAVE_TIERS } from './rules'
import { roundRupees } from './money'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SALARY  = 26_000                    // ÷ 26 = ₹1,000 a day, so the sums read cleanly
const PER_DAY = SALARY / PER_DAY_DIVISOR

const employee: EngineEmployee = {
  id: 'emp-1',
  monthly_salary: SALARY,
  payroll_active: true,
  joining_date: null,
  employment_type: 'permanent',
}

// August 2026. 15 August is Independence Day — a real public holiday, and the
// kind of date that would be missing from an empty payroll_holidays table.
const period: EnginePeriod = { id: 'p-1', payroll_month: 8, payroll_year: 2026, status: 'draft' }
const HOLIDAY = '2026-08-15'

const iso = (day: number) => `2026-08-${String(day).padStart(2, '0')}`

/** IST wall clock on an August 2026 date, as the UTC instant the importer stores. */
const at = (day: number, hh: number, mm: number) =>
  new Date(Date.UTC(2026, 7, day, hh, mm - 330)).toISOString()

/** A full, on-time day: in before the grace end, out after the scheduled close. */
const fullDay = (day: number): EngineAttendanceRecord => ({
  id: `att-${day}`,
  attendance_date: iso(day),
  check_in_at: at(day, 10, 0),
  check_out_at: at(day, 18, 30),
  direction_source: 'confirmed',
})

/** Every non-Sunday date in August 2026. */
function workingDates(): number[] {
  const out: number[] = []
  for (let d = 1; d <= 31; d++) {
    if (new Date(`${iso(d)}T00:00:00Z`).getUTCDay() !== 0) out.push(d)
  }
  return out
}

function run(records: EngineAttendanceRecord[], holidays: EngineHoliday[]): EngineResult {
  const outcome = generatePayrollForEmployee(employee, period, records, holidays, [])
  assert.equal(isSkip(outcome), false, 'engine skipped the employee')
  return outcome as EngineResult
}

const REGISTERED: EngineHoliday[] = [{ holiday_date: HOLIDAY }]
const NOT_REGISTERED: EngineHoliday[] = []   // production today

// ─── The finding ──────────────────────────────────────────────────────────────

describe('an unregistered public holiday', () => {
  // Present every working day except the holiday, when the office was shut.
  const attended = workingDates().filter(d => iso(d) !== HOLIDAY).map(fullDay)

  test('is treated as a working day when it is not in payroll_holidays', () => {
    const withHoliday    = run(attended, REGISTERED)
    const withoutHoliday = run(attended, NOT_REGISTERED)

    assert.equal(
      withoutHoliday.working_days_in_month - withHoliday.working_days_in_month, 1,
      'the unregistered holiday must add a working day',
    )
    // …and with no punches on it, that day is an absence.
    assert.equal(withHoliday.days_absent, 0, 'registered: the day is excluded entirely')
    assert.equal(withoutHoliday.days_absent, 1, 'unregistered: the day becomes an absence')
  })

  test('but the month’s paid leave ABSORBS it, so a single holiday costs nothing', () => {
    // This is the part an empty-table observation cannot tell you, and it is
    // where the audit's original wording was too strong.
    const withoutHoliday = run(attended, NOT_REGISTERED)

    assert.ok(
      withoutHoliday.days_present >= PAID_LEAVE_TIERS[0]!.min_days_present,
      'the employee attends enough days to earn a full paid leave',
    )
    assert.equal(withoutHoliday.paid_leave_used, 1, 'the allowance is spent on the absence')
    assert.equal(
      withoutHoliday.total_deductions, 0,
      'a single unregistered holiday is absorbed and costs the employee nothing',
    )
  })

  test('the cost lands only once the allowance is already spent', () => {
    // A real absence earlier in the month takes the allowance. The holiday is
    // then the SECOND absence, and nothing is left to cover it.
    const withRealAbsence = attended.filter(r => r.attendance_date !== iso(3))

    const registered   = run(withRealAbsence, REGISTERED)
    const unregistered = run(withRealAbsence, NOT_REGISTERED)

    assert.equal(registered.days_absent, 1, 'only the genuine absence')
    assert.equal(unregistered.days_absent, 2, 'the genuine absence and the holiday')

    // The allowance covers the EARLIEST absence (3 Aug) in both runs, so the
    // difference between them is exactly one uncovered day's pay.
    const cost = unregistered.total_deductions - registered.total_deductions
    assert.equal(cost, roundRupees(PER_DAY),
      `an unregistered holiday costs one day's pay once the allowance is spent`)
    assert.equal(registered.total_deductions, 0, 'the genuine absence is company-paid')
    assert.equal(unregistered.total_deductions, roundRupees(PER_DAY))
  })

  test('and every additional unregistered holiday is charged in full', () => {
    // Two closures in one month — 15 August and a second company holiday.
    const SECOND = '2026-08-20'
    const attendedTwo = workingDates()
      .filter(d => iso(d) !== HOLIDAY && iso(d) !== SECOND)
      .map(fullDay)

    const registered = run(attendedTwo, [{ holiday_date: HOLIDAY }, { holiday_date: SECOND }])
    const neither    = run(attendedTwo, NOT_REGISTERED)

    assert.equal(registered.total_deductions, 0, 'both registered: nothing is charged')
    // Two absences, one absorbed by the allowance, one charged.
    assert.equal(neither.days_absent, 2)
    assert.equal(neither.total_deductions, roundRupees(PER_DAY),
      'the second unregistered closure is charged in full')
  })
})

// ─── What this means for the risk register ────────────────────────────────────

describe('the salary effect, stated precisely', () => {
  test('the exposure is real but conditional, not automatic', () => {
    const attended = workingDates().filter(d => iso(d) !== HOLIDAY).map(fullDay)
    const perfectMonth = run(attended, NOT_REGISTERED)

    // Claim A — the original audit wording ("charged as absences") is TOO STRONG
    // for an employee with an otherwise clean month.
    assert.equal(perfectMonth.total_deductions, 0)

    // Claim B — the risk is that the holiday CONSUMES the paid-leave allowance,
    // so the employee's own next absence is no longer covered. That is a real
    // loss of an entitlement even when this month's total is ₹0.
    assert.equal(perfectMonth.paid_leave_available, PAID_LEAVE_TIERS[0]!.leave)
    assert.equal(perfectMonth.paid_leave_used, 1, 'the entitlement is silently consumed')

    const withHoliday = run(attended, REGISTERED)
    assert.equal(withHoliday.paid_leave_used, 0, 'registered: the entitlement is preserved')
  })
})
