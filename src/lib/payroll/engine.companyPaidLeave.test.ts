/**
 * The first paid leave is on the company — and it has to be visible.
 *
 * Two rules are asserted together here because they are the same rule seen from
 * two sides:
 *
 *   money  — the month's paid-leave allowance absorbs the first thing it can
 *            cover, that item costs ₹0, and the total is reduced accordingly.
 *   ledger — the absorbed item STAYS on the Deductions tab, marked as company
 *            paid, and contributes nothing to any total.
 *
 * The second half is the regression: before `waived_by`, an absorbed day was a
 * ₹0 line with no reason on it, which failed the "did this cost money?" test for
 * the Deductions tab and the "was this a paid classification?" test for Days
 * Considered — so the date vanished from Payroll Result Detail entirely.
 *
 * Run:
 *   npx tsx --test src/lib/payroll/engine.companyPaidLeave.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { generatePayrollForEmployee } from './engine'
import { isSkip } from './types'
import type { EngineEmployee, EnginePeriod, EngineAttendanceRecord, EngineResult } from './types'
import type { AttendanceDayCorrection } from '../attendance/corrections'
import { toDeductionDays, toConsideredDays, isCompanyPaidLine } from './resultTabs'
import { PER_DAY_DIVISOR } from './rules'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SALARY = 26_000            // ÷ 26 = ₹1,000 per day, so the arithmetic is readable
const PER_DAY  = SALARY / PER_DAY_DIVISOR
const PER_HOUR = PER_DAY / 8.5

const employee: EngineEmployee = {
  id: 'emp-1',
  monthly_salary: SALARY,
  payroll_active: true,
  joining_date: null,
  employment_type: 'permanent',
}

// July 2026: 31 days, Sundays on 5/12/19/26 → 27 working days.
const period: EnginePeriod = { id: 'period-1', payroll_month: 7, payroll_year: 2026, status: 'draft' }

const JULY_WORKING_DAYS = [
  1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18,
  20, 21, 22, 23, 24, 25, 27, 28, 29, 30, 31,
]

function iso(day: number): string {
  return `2026-07-${String(day).padStart(2, '0')}`
}

/** IST wall clock on a July 2026 date, as the UTC instant the importer stores. */
function at(day: number, hh: number, mm: number): string {
  return new Date(Date.UTC(2026, 6, day, hh, mm - 330)).toISOString()
}

/** A full present day: in at 10:00, out at 18:30. */
function fullDay(day: number): EngineAttendanceRecord {
  return { id: `r-${day}`, attendance_date: iso(day), check_in_at: at(day, 10, 0), check_out_at: at(day, 18, 30) }
}

/** A half day: ~4 effective hours after the lunch deduction. */
function halfDay(day: number): EngineAttendanceRecord {
  return { id: `r-${day}`, attendance_date: iso(day), check_in_at: at(day, 10, 0), check_out_at: at(day, 15, 0) }
}

/** A late day: in at 10:45 — 45 min past 10:00, which rounds up to 1h. */
function lateDay(day: number): EngineAttendanceRecord {
  return { id: `r-${day}`, attendance_date: iso(day), check_in_at: at(day, 10, 45), check_out_at: at(day, 18, 30) }
}

/**
 * A month built from a set of exceptions: every other working day is a plain
 * full day, so `days_present` is high enough to earn the full paid leave.
 */
function month(exceptions: Record<number, EngineAttendanceRecord | null>): EngineAttendanceRecord[] {
  const out: EngineAttendanceRecord[] = []
  for (const d of JULY_WORKING_DAYS) {
    if (d in exceptions) {
      const rec = exceptions[d]
      if (rec) out.push(rec)          // an explicit exception record
      continue                        // null = no punches at all → absent
    }
    out.push(fullDay(d))
  }
  return out
}

function run(
  records: EngineAttendanceRecord[],
  corrections: AttendanceDayCorrection[] = [],
  overrides: Partial<EnginePeriod> = {},
): EngineResult {
  const outcome = generatePayrollForEmployee(
    employee, { ...period, ...overrides }, records, [], [], corrections,
  )
  assert.ok(!isSkip(outcome), `engine skipped: ${isSkip(outcome) ? outcome.reason : ''}`)
  return outcome as EngineResult
}

function close(a: number, b: number, what: string) {
  assert.ok(Math.abs(a - b) < 0.005, `${what}: ${a} !== ${b}`)
}

// ─── The first paid leave ─────────────────────────────────────────────────────

describe('the first eligible paid leave is charged to the company', () => {
  test('one absent day costs nothing, and says so on the row', () => {
    const r = run(month({ 21: null }))

    assert.equal(r.paid_leave_available, 1)
    assert.equal(r.paid_leave_used, 1)
    close(r.total_deductions, 0, 'total deductions')
    close(r.net_salary, SALARY, 'net salary')

    const days = toDeductionDays(r.day_results)
    const july21 = days.find(d => d.date === '2026-07-21')
    assert.ok(july21, '21 July must still appear on the Deductions tab')
    assert.equal(july21.total_amount, 0)
    assert.equal(july21.lines.length, 1)
    assert.equal(july21.lines[0].deduction_type, 'absent')
    assert.equal(july21.lines[0].amount_deducted, 0)
    assert.ok(isCompanyPaidLine(july21.lines[0]))
    // The popup needs to be able to say what it WOULD have cost.
    close(july21.lines[0].explain!.gross_amount, PER_DAY, 'gross amount of the covered day')
  })

  test('the second absent day follows the ordinary rule', () => {
    const r = run(month({ 21: null, 22: null }))

    assert.equal(r.paid_leave_used, 1)
    close(r.total_deductions, PER_DAY, 'one absence charged, one covered')
    close(r.net_salary, SALARY - PER_DAY, 'net salary')

    const days = toDeductionDays(r.day_results)
    const charged = days.filter(d => d.total_amount > 0)
    const covered = days.filter(d => d.lines.some(isCompanyPaidLine))
    assert.equal(charged.length, 1, 'exactly one absence is charged')
    assert.equal(covered.length, 1, 'exactly one absence is covered')
    // The FIRST leave of the month is the company's. 21 July comes first, so it
    // is the covered one and 22 July is charged at the ordinary rate.
    assert.equal(covered[0].date, '2026-07-21')
    assert.equal(charged[0].date, '2026-07-22')
  })

  test('the ₹0 line adds nothing to the deduction total', () => {
    const r = run(month({ 21: null, 22: null }))
    const days = toDeductionDays(r.day_results)
    const shown = days.reduce((sum, d) => sum + d.total_amount, 0)
    close(shown, r.total_deductions, 'deduction tab rows must sum to the engine total')

    const zeroRows = days.filter(d => d.total_amount === 0)
    assert.equal(zeroRows.length, 1, 'the covered day is on the tab')
    close(shown, PER_DAY, 'and it contributed nothing')
  })

  test('a date can never be covered twice, however many absences there are', () => {
    const r = run(month({ 21: null, 22: null, 23: null, 24: null }))
    const covered = toDeductionDays(r.day_results).filter(d => d.lines.some(isCompanyPaidLine))
    assert.equal(covered.length, 1)
    assert.equal(covered[0].date, '2026-07-21', 'and it is the earliest of the four')
    assert.equal(r.paid_leave_used, 1)
    close(r.total_deductions, 3 * PER_DAY, 'three of four absences are charged')
  })

  test('two half days can be covered instead, and both stay visible at ₹0', () => {
    const r = run(month({ 21: halfDay(21), 22: halfDay(22) }))

    assert.equal(r.half_day_count, 2)
    assert.equal(r.paid_leave_used, 1)
    close(r.total_deductions, 0, 'both half days covered')

    const covered = toDeductionDays(r.day_results).filter(d => d.lines.some(isCompanyPaidLine))
    assert.equal(covered.length, 2)
    for (const d of covered) {
      assert.equal(d.total_amount, 0)
      assert.equal(d.lines[0].deduction_type, 'half_day')
      close(d.lines[0].explain!.gross_amount, PER_DAY / 2, 'gross of a covered half day')
    }
  })

  test('hourly deductions can be covered instead, and stay visible at ₹0', () => {
    // Three late days, 1h each = 3h, inside the 8.5h the allowance covers.
    const r = run(month({ 15: lateDay(15), 16: lateDay(16), 17: lateDay(17) }))

    assert.equal(r.leave_absorbed_deductions, true)
    close(r.total_deductions, 0, 'the late deductions are covered')

    const covered = toDeductionDays(r.day_results).filter(d => d.lines.some(isCompanyPaidLine))
    assert.equal(covered.length, 3)
    for (const d of covered) {
      assert.equal(d.lines[0].deduction_type, 'late_arrival')
      assert.equal(d.lines[0].amount_deducted, 0)
      close(d.lines[0].explain!.gross_amount, 1 * PER_HOUR, 'gross of a covered late arrival')
    }
  })

  test('an employee who has not earned the leave is charged in full', () => {
    // Present on 8 working days only → below the entitlement threshold.
    const present = JULY_WORKING_DAYS.slice(0, 8)
    const r = run(present.map(fullDay))

    assert.equal(r.paid_leave_available, 0)
    assert.equal(r.paid_leave_used, 0)
    const covered = toDeductionDays(r.day_results).filter(d => d.lines.some(isCompanyPaidLine))
    assert.equal(covered.length, 0, 'nothing is company-paid without an allowance')
    close(r.total_deductions, 19 * PER_DAY, 'all 19 absences are charged')
  })
})

// ─── Which leave, exactly ─────────────────────────────────────────────────────
//
// The rule is chronological: the FIRST eligible leave of the payroll month is
// the company-paid one. Not the last, not the cheapest, and not whichever row
// the importer happened to write first.
//
// This block is the regression for the defect it replaced — the assembly step
// charged the leading absences and waived the trailing one, which made the LAST
// absence of the month the free one. Everything below states "earliest" from a
// different angle so no single edit can quietly flip it back.

describe('the company-paid leave is the earliest one in the month', () => {
  /** The dates the allowance covered, in the order the engine emitted them. */
  const coveredDates = (r: EngineResult) =>
    r.deduction_lines.filter(isCompanyPaidLine).map(l => l.line_date)

  test('1. a single leave in the month is the paid one', () => {
    const r = run(month({ 10: null }))
    assert.deepEqual(coveredDates(r), ['2026-07-10'])
    close(r.total_deductions, 0, 'nothing left to charge')
  })

  test('2. with three leaves, the earliest is paid and the other two are not', () => {
    // The brief's own example, moved into July: 3rd, 12th, 24th.
    const r = run(month({ 3: null, 13: null, 24: null }))

    assert.deepEqual(coveredDates(r), ['2026-07-03'], 'the 3rd is on the company')
    const charged = toDeductionDays(r.day_results)
      .filter(d => d.total_amount > 0).map(d => d.date)
    assert.deepEqual(charged, ['2026-07-13', '2026-07-24'], 'the later two are ordinary leave')
    close(r.total_deductions, 2 * PER_DAY, 'two absences at the full per-day rate')
  })

  test('3. attendance imported out of sequence still pays the earliest date', () => {
    // Same month, the records array deliberately scrambled — a real import is
    // ordered by whatever the biometric export gave, and a corrected day is
    // written later still. Chronology must come from attendance_date alone.
    const ordered  = month({ 3: null, 13: null, 24: null })
    const reversed = [...ordered].reverse()
    const shuffled = [...ordered].sort((a, b) => (a.attendance_date < b.attendance_date ? 1 : -1))

    for (const [label, records] of [['reversed', reversed], ['shuffled', shuffled]] as const) {
      const r = run(records)
      assert.deepEqual(coveredDates(r), ['2026-07-03'], `${label} import`)
      close(r.total_deductions, 2 * PER_DAY, `${label} total`)
    }
  })

  test('4. adding a later leave leaves the earlier one paid', () => {
    const before = run(month({ 3: null }))
    assert.deepEqual(coveredDates(before), ['2026-07-03'])

    // The employee is absent again on the 24th. The 3rd keeps the allowance;
    // only the new day is charged.
    const after = run(month({ 3: null, 24: null }))
    assert.deepEqual(coveredDates(after), ['2026-07-03'], 'the earlier leave keeps the allowance')
    close(after.total_deductions, PER_DAY, 'only the new absence is charged')
  })

  test('4b. and adding an EARLIER leave moves the allowance to it', () => {
    // The other direction of the same rule: it is a property of the month, not
    // a flag set on a row when the first objection-free run happened.
    const after = run(month({ 3: null, 24: null }))
    const earlierAdded = run(month({ 1: null, 3: null, 24: null }))
    assert.deepEqual(coveredDates(after), ['2026-07-03'])
    assert.deepEqual(coveredDates(earlierAdded), ['2026-07-01'])
    close(earlierAdded.total_deductions, 2 * PER_DAY, 'the 3rd and the 24th are both charged now')
  })

  test('5. the deduction charged for every subsequent leave is unchanged', () => {
    // What the later leaves cost must not have moved: each is one whole per-day
    // rate, exactly as an absence outside the allowance always was.
    const r = run(month({ 3: null, 13: null, 24: null }))
    const later = toDeductionDays(r.day_results).filter(d => d.total_amount > 0)

    assert.equal(later.length, 2)
    for (const d of later) {
      assert.equal(d.lines.length, 1)
      assert.equal(d.lines[0].deduction_type, 'absent')
      assert.equal(d.lines[0].waived_by, undefined, 'a charged day carries no waiver')
      close(d.lines[0].amount_deducted, PER_DAY, `${d.date} costs one per-day rate`)
      close(d.lines[0].explain!.gross_amount, PER_DAY, `${d.date} gross`)
    }
    close(r.net_salary, SALARY - 2 * PER_DAY, 'net salary')

    // And an employee with no allowance at all is charged for every one of
    // them, the earliest included — the rule picks a payer, it does not create
    // an exemption.
    const noAllowance = run([...JULY_WORKING_DAYS.slice(0, 8)].map(fullDay))
    assert.deepEqual(coveredDates(noAllowance), [])
  })

  test('half days follow the same direction: the earliest pair is covered', () => {
    // Three half days, a full day of allowance covering two of them. The two
    // that cost nothing must be the first two.
    const r = run(month({ 3: halfDay(3), 13: halfDay(13), 24: halfDay(24) }))

    assert.equal(r.paid_leave_used, 1)
    assert.deepEqual(coveredDates(r), ['2026-07-03', '2026-07-13'])
    close(r.total_deductions, PER_DAY / 2, 'only the last half day is charged')

    const charged = toDeductionDays(r.day_results).filter(d => d.total_amount > 0)
    assert.deepEqual(charged.map(d => d.date), ['2026-07-24'])
  })

  test('the rule is stable across regeneration', () => {
    const records = month({ 3: null, 13: null, 24: null })
    const runs = [run(records), run(records), run(records)]
    for (const r of runs) assert.deepEqual(coveredDates(r), ['2026-07-03'])
  })
})

// ─── Idempotence ──────────────────────────────────────────────────────────────

describe('the allowance cannot be consumed twice', () => {
  test('regenerating the same month produces the identical result', () => {
    const records = month({ 21: null, 22: null })
    const first  = run(records)
    const second = run(records)
    const third  = run(records)

    for (const r of [second, third]) {
      close(r.total_deductions, first.total_deductions, 'total deductions')
      close(r.net_salary, first.net_salary, 'net salary')
      assert.equal(r.paid_leave_used, first.paid_leave_used)
      assert.equal(r.deduction_lines.length, first.deduction_lines.length)
    }

    // Not merely equal totals — the same lines, covered in the same places.
    const covered = (r: EngineResult) =>
      r.deduction_lines.filter(isCompanyPaidLine).map(l => l.line_date).sort()
    assert.deepEqual(covered(second), covered(first))
    assert.deepEqual(covered(third), covered(first))
  })

  test('the allowance is recomputed from attendance, never carried in state', () => {
    // A different month shape gets a different answer from the same engine,
    // which is only possible because nothing is remembered between runs.
    const generous = run(month({ 21: null }))
    const lean     = run(JULY_WORKING_DAYS.slice(0, 8).map(fullDay))
    assert.equal(generous.paid_leave_available, 1)
    assert.equal(lean.paid_leave_available, 0)
  })

  test('correcting a date does not spend the allowance a second time', () => {
    const records = month({ 21: null, 22: null })

    const before = run(records)
    close(before.total_deductions, PER_DAY, 'one absence charged before the correction')

    // The admin restates 21 July as a worked day. 22 July is now the only
    // absence left, and the allowance covers it — once.
    const correction: AttendanceDayCorrection = {
      attendance_date: '2026-07-21',
      corrected_check_in_at:  at(21, 10, 0),
      corrected_check_out_at: at(21, 18, 30),
      day_treatment: 'auto',
      waive_late_arrival: false,
      waive_early_checkout: false,
      waive_missing_punch: false,
    }

    const after = run(records, [correction])
    assert.equal(after.paid_leave_used, 1, 'still exactly one leave used')
    close(after.total_deductions, 0, 'the single remaining absence is covered')

    const covered = after.deduction_lines.filter(isCompanyPaidLine)
    assert.equal(covered.length, 1, 'one covered line, not two')
    assert.equal(covered[0].line_date, '2026-07-22')

    // And running it again after the correction changes nothing.
    const afterAgain = run(records, [correction])
    close(afterAgain.total_deductions, after.total_deductions, 'regeneration after correction')
    assert.equal(afterAgain.paid_leave_used, 1)
  })

  test('a correction that forces a day absent still only spends one leave', () => {
    const correction: AttendanceDayCorrection = {
      attendance_date: '2026-07-21',
      corrected_check_in_at: null,
      corrected_check_out_at: null,
      day_treatment: 'absent',
      waive_late_arrival: false,
      waive_early_checkout: false,
      waive_missing_punch: false,
    }
    const r = run(month({ 22: null }), [correction])

    assert.equal(r.days_absent, 2)
    assert.equal(r.paid_leave_used, 1)
    close(r.total_deductions, PER_DAY, 'one of the two absences is charged')
    assert.equal(r.deduction_lines.filter(isCompanyPaidLine).length, 1)
  })
})

// ─── The tabs ─────────────────────────────────────────────────────────────────

describe('no working day falls out of both tabs', () => {
  test('every calendar day of the month lands somewhere', () => {
    const r = run(month({ 21: null, 15: halfDay(15), 16: lateDay(16) }))
    const inDeductions = new Set(toDeductionDays(r.day_results).map(d => d.date))
    const inConsidered = new Set(toConsideredDays(r.day_results).map(d => d.date))

    const orphans = r.day_results
      .filter(d => !inDeductions.has(d.date) && !inConsidered.has(d.date))
      .map(d => `${d.date} (${d.classification})`)

    assert.deepEqual(orphans, [], 'dates in neither tab')
    assert.equal(r.day_results.length, 31, 'all 31 July dates are present')
  })

  test('a covered day is not double-counted into Days Considered', () => {
    const r = run(month({ 21: null }))
    const considered = toConsideredDays(r.day_results)
    assert.equal(considered.find(d => d.date === '2026-07-21'), undefined)
    const payable = considered.reduce((s, d) => s + d.payable_day_value, 0)
    assert.equal(payable, 26, 'the covered absence adds no payable day')
  })

  test('a locked period still refuses to calculate, so the view runs it as draft', () => {
    const outcome = generatePayrollForEmployee(
      employee, { ...period, status: 'locked' }, month({ 21: null }), [], [], [],
    )
    assert.ok(isSkip(outcome))
    assert.equal(isSkip(outcome) && outcome.reason, 'period_locked')
  })
})
