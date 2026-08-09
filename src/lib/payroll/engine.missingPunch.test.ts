/**
 * The missing-punch rule, end to end through the engine.
 *
 *   npx tsx --test src/lib/payroll/engine.missingPunch.test.ts
 *
 * A working day with exactly one punch costs a flat MISSING_PUNCH_HOURS and
 * STILL COUNTS AS PRESENT. It is never an absence, never a half day and never a
 * short-hours shortfall merely because the other punch is missing.
 *
 * The half of this that is new is what may stack ON TOP. A late-arrival
 * deduction is only sound when something states that the punch present was the
 * arrival — the attendance file (Format A) or an admin (a correction). Where the
 * direction was worked out from the clock alone, the lateness would be a charge
 * derived from a guess, so it is not raised. That guard is what removes the
 * worst over-deduction the audit found: a lone 18:36 punch used to be recorded
 * as an arrival and charged ~9 hours of lateness on top of the 2-hour missing
 * punch, costing more than a whole day's pay for one forgotten punch.
 *
 * These tests drive the ENGINE, so they cover the confirmed path too — which the
 * importer cannot reach yet, because attendance_records has no provenance column
 * (see the migration note in punchDirection.ts). Corrections reach it today.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { generatePayrollForEmployee } from './engine'
import { isSkip } from './types'
import type {
  EngineEmployee,
  EnginePeriod,
  EngineAttendanceRecord,
  EngineHoliday,
  EngineResult,
  PendingDeductionLine,
} from './types'
import type { AttendanceDayCorrection } from '../attendance/corrections'
import type { PunchDirectionSource } from '../attendance/punchDirection'
import { PER_DAY_DIVISOR, MISSING_PUNCH_HOURS, FULL_DAY_HOURS } from './rules'
import { toDeductionDays, toConsideredDays } from './resultTabs'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SALARY   = 26_000                       // ÷ 26 → ₹1,000/day, ÷ 8.5 → ₹117.647/hour
const PER_DAY  = SALARY / PER_DAY_DIVISOR
const PER_HOUR = PER_DAY / FULL_DAY_HOURS

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

function fullDay(day: number): EngineAttendanceRecord {
  return { id: `r-${day}`, attendance_date: iso(day), check_in_at: at(day, 10, 0), check_out_at: at(day, 18, 30) }
}

/** Only an arrival punch. */
function inOnly(day: number, hh: number, mm: number, direction: PunchDirectionSource): EngineAttendanceRecord {
  return {
    id: `r-${day}`,
    attendance_date: iso(day),
    check_in_at:  at(day, hh, mm),
    check_out_at: null,
    direction_source: direction,
  }
}

/** Only a departure punch — a row the importer could not previously produce. */
function outOnly(day: number, hh: number, mm: number, direction: PunchDirectionSource): EngineAttendanceRecord {
  return {
    id: `r-${day}`,
    attendance_date: iso(day),
    check_in_at:  null,
    check_out_at: at(day, hh, mm),
    direction_source: direction,
  }
}

/**
 * A month of ordinary full days, with the days under test swapped in.
 *
 * Enough present days (≥16) that the paid-leave allowance is a full day, which
 * is deliberate: it keeps the leave-absorption stage in play so these tests also
 * prove the missing-punch line interacts with it the way it always did.
 */
function monthWith(...records: EngineAttendanceRecord[]): EngineAttendanceRecord[] {
  const overridden = new Set(records.map(r => r.attendance_date))
  const rest = JULY_WORKING_DAYS.map(fullDay).filter(r => !overridden.has(r.attendance_date))
  return [...rest, ...records]
}

/**
 * The same month with its paid-leave allowance already spent.
 *
 * Needed by every test that asserts what a missing punch COSTS. With the
 * allowance unused, absorption stage 3 zeroes the whole month's hourly
 * deductions — 2 h is well inside the 8.5 h a full leave day covers — so the
 * charge under test would read ₹0 for a reason that has nothing to do with the
 * missing punch. Removing day 1's record creates one absence, stage 1 spends the
 * allowance on it, and hourly deductions are then charged normally.
 *
 * That interaction is asserted directly in its own describe block below; here it
 * is held constant so the missing-punch arithmetic is the only variable.
 */
function monthWithLeaveSpent(...records: EngineAttendanceRecord[]): EngineAttendanceRecord[] {
  return monthWith(...records).filter(r => r.attendance_date !== iso(1))
}

function run(
  records: EngineAttendanceRecord[],
  corrections: AttendanceDayCorrection[] = [],
  holidays: EngineHoliday[] = [],
): EngineResult {
  const outcome = generatePayrollForEmployee(employee, period, records, holidays, [], corrections)
  assert.equal(isSkip(outcome), false, 'the engine must not skip this employee')
  return outcome as EngineResult
}

function linesOn(result: EngineResult, day: number): PendingDeductionLine[] {
  return result.deduction_lines.filter(l => l.line_date === iso(day))
}

function typesOn(result: EngineResult, day: number): string[] {
  return linesOn(result, day).map(l => l.deduction_type).sort()
}

function classificationOn(result: EngineResult, day: number): string | undefined {
  return result.day_results.find(d => d.date === iso(day))?.classification
}

function amountOn(result: EngineResult, day: number): number {
  return linesOn(result, day).reduce((sum, l) => sum + l.amount_deducted, 0)
}

const missingPunchCost = MISSING_PUNCH_HOURS * PER_HOUR

// ─── Confirmed direction ──────────────────────────────────────────────────────

describe('confirmed direction — the file or an admin said which punch it is', () => {
  test('13. IN-only, on time → missing_punch_out, exactly MISSING_PUNCH_HOURS', () => {
    const r = run(monthWithLeaveSpent(inOnly(7, 10, 0, 'confirmed')))

    assert.equal(classificationOn(r, 7), 'missing_punch')
    assert.deepEqual(typesOn(r, 7), ['missing_punch_out'])
    assert.equal(linesOn(r, 7)[0].hours_deducted, MISSING_PUNCH_HOURS)
    assert.ok(Math.abs(amountOn(r, 7) - missingPunchCost) < 0.005)
  })

  test('14. OUT-only → missing_punch_in, exactly MISSING_PUNCH_HOURS', () => {
    const r = run(monthWithLeaveSpent(outOnly(8, 18, 30, 'confirmed')))

    assert.equal(classificationOn(r, 8), 'missing_punch')
    assert.deepEqual(typesOn(r, 8), ['missing_punch_in'])
    assert.equal(linesOn(r, 8)[0].hours_deducted, MISSING_PUNCH_HOURS)
    assert.ok(Math.abs(amountOn(r, 8) - missingPunchCost) < 0.005)
  })

  test('17. confirmed LATE arrival with a missing punch-out → both lines', () => {
    // In at 11:30 is 90 minutes past 10:00 → ceil(90/30) × 0.5 h = 1.5 h late.
    const r = run(monthWithLeaveSpent(inOnly(9, 11, 30, 'confirmed')))

    assert.deepEqual(typesOn(r, 9), ['late_arrival', 'missing_punch_out'])
    const late = linesOn(r, 9).find(l => l.deduction_type === 'late_arrival')!
    assert.equal(late.hours_deducted, 1.5)
    assert.ok(Math.abs(amountOn(r, 9) - (MISSING_PUNCH_HOURS + 1.5) * PER_HOUR) < 0.005)
  })

  test('a confirmed IN inside the grace period carries no late line', () => {
    const r = run(monthWithLeaveSpent(inOnly(10, 10, 15, 'confirmed')))
    assert.deepEqual(typesOn(r, 10), ['missing_punch_out'])
  })

  test('18. a missing punch-IN never produces a late-arrival line, however late', () => {
    // There is no arrival time to measure. Even a confirmed 19:00 departure —
    // the value that used to be misfiled as an arrival and charged ~9 hours —
    // must produce the flat missing-punch line and nothing else.
    for (const direction of ['confirmed', 'inferred'] as const) {
      const r = run(monthWithLeaveSpent(outOnly(11, 19, 0, direction)))
      assert.deepEqual(typesOn(r, 11), ['missing_punch_in'], direction)
      assert.ok(Math.abs(amountOn(r, 11) - missingPunchCost) < 0.005, direction)
    }
  })

  test('no early-departure line is raised for a missing punch either way', () => {
    const r = run(monthWithLeaveSpent(outOnly(13, 15, 0, 'confirmed')))
    assert.deepEqual(typesOn(r, 13), ['missing_punch_in'])
  })
})

// ─── Inferred direction ───────────────────────────────────────────────────────

describe('inferred direction — the clock was the only signal', () => {
  test('15. inferred morning punch → missing_punch_out, 2 h, and nothing else', () => {
    // 11:30 IS late against a 10:00 start, and a CONFIRMED punch would be charged
    // for it (test 17 above). Inferred, it must not be: the lateness would rest
    // entirely on having guessed the punch was an arrival.
    const r = run(monthWithLeaveSpent(inOnly(14, 11, 30, 'inferred')))

    assert.equal(classificationOn(r, 14), 'missing_punch')
    assert.deepEqual(typesOn(r, 14), ['missing_punch_out'])
    assert.ok(Math.abs(amountOn(r, 14) - missingPunchCost) < 0.005)
  })

  test('16. inferred evening punch → missing_punch_in, 2 h, and nothing else', () => {
    const r = run(monthWithLeaveSpent(outOnly(15, 18, 36, 'inferred')))

    assert.equal(classificationOn(r, 15), 'missing_punch')
    assert.deepEqual(typesOn(r, 15), ['missing_punch_in'])
    assert.ok(Math.abs(amountOn(r, 15) - missingPunchCost) < 0.005)
  })

  test('a raw record with no provenance at all is treated as inferred', () => {
    // This is what every stored attendance row looks like today, and the default
    // has to be the cautious one.
    const r = run(monthWithLeaveSpent({
      id: 'r-16', attendance_date: iso(16), check_in_at: at(16, 11, 30), check_out_at: null,
    }))
    assert.deepEqual(typesOn(r, 16), ['missing_punch_out'])
  })

  test('the old 18:36 catastrophe costs 2 h, not most of a day', () => {
    // Before: stored as an arrival at 18:36 → 2 h missing punch + ceil(516/30) ×
    // 0.5 = 9 h late = 11 h, against a full day of 8.5 h. One punch cost more
    // than the day was worth.
    const r = run(monthWithLeaveSpent(outOnly(17, 18, 36, 'inferred')))
    const total = amountOn(r, 17)

    assert.ok(Math.abs(total - missingPunchCost) < 0.005)
    assert.ok(total < PER_DAY, 'a present day must never cost more than a day of pay')
    assert.ok(total < 11 * PER_HOUR, 'the stacked lateness must be gone')
  })
})

// ─── The day is still a present day ───────────────────────────────────────────

describe('a missing punch is a PRESENT day', () => {
  test('it counts toward days_present and never toward absence or half days', () => {
    const r = run(monthWith(inOnly(7, 10, 0, 'inferred'), outOnly(8, 18, 30, 'inferred')))

    assert.equal(r.days_present, JULY_WORKING_DAYS.length)
    assert.equal(r.days_absent, 0)
    assert.equal(r.half_day_count, 0)
  })

  test('no absent or half_day line is ever raised for it', () => {
    const r = run(monthWith(outOnly(8, 18, 30, 'inferred')))
    const types = r.deduction_lines.map(l => l.deduction_type)
    assert.equal(types.includes('absent'), false)
    assert.equal(types.includes('half_day'), false)
    assert.equal(types.includes('short_hours'), false)
  })

  test('it appears on BOTH result tabs — deducted, and counted as a full payable day', () => {
    const r = run(monthWith(outOnly(8, 18, 30, 'inferred')))

    const deducted = toDeductionDays(r.day_results).find(d => d.date === iso(8))
    assert.ok(deducted, 'the day must be explainable on the Deductions tab')
    assert.deepEqual(deducted.lines.map(l => l.deduction_type), ['missing_punch_in'])

    const considered = toConsideredDays(r.day_results).find(d => d.date === iso(8))
    assert.ok(considered, 'the day must be counted on Days Considered')
    assert.equal(considered.payable_day_value, 1)
  })

  test('the hours land in missing_punch_hours, not in the late or short-hours buckets', () => {
    const r = run(monthWith(inOnly(7, 11, 30, 'inferred')))
    assert.equal(r.missing_punch_hours, MISSING_PUNCH_HOURS)
    assert.equal(r.late_deduction_hours, 0)
    assert.equal(r.short_hours_deduction, 0)
  })

  test('21. no punches at all is still an absence, unchanged', () => {
    const withoutDay7 = monthWith().filter(rec => rec.attendance_date !== iso(7))
    const r = run(withoutDay7)

    assert.equal(classificationOn(r, 7), 'full_absent')
    assert.equal(r.days_absent, 1)
    assert.equal(r.days_present, JULY_WORKING_DAYS.length - 1)
    assert.equal(typesOn(r, 7).includes('missing_punch_in'), false)
    assert.equal(typesOn(r, 7).includes('missing_punch_out'), false)
  })
})

// ─── Non-working days ─────────────────────────────────────────────────────────

describe('22. a single punch on a non-working day costs nothing', () => {
  test('Sunday', () => {
    // 5 July 2026 is a Sunday.
    const r = run([...monthWith(), outOnly(5, 18, 30, 'inferred')])

    assert.equal(classificationOn(r, 5), 'weekly_off')
    assert.deepEqual(typesOn(r, 5), [])
    assert.equal(r.days_present, JULY_WORKING_DAYS.length)
  })

  test('company holiday', () => {
    const holidays: EngineHoliday[] = [{ holiday_date: iso(14) }]
    const r = run(monthWith(inOnly(14, 11, 45, 'confirmed')), [], holidays)

    assert.equal(classificationOn(r, 14), 'holiday')
    assert.deepEqual(typesOn(r, 14), [])
  })

  test('a date before the joining date', () => {
    const joiner: EngineEmployee = { ...employee, joining_date: iso(15) }
    const outcome = generatePayrollForEmployee(
      joiner, period, monthWith(outOnly(7, 18, 0, 'inferred')), [], [], [],
    )
    assert.equal(isSkip(outcome), false)
    const r = outcome as EngineResult
    assert.equal(classificationOn(r, 7), 'pre_joining')
    assert.deepEqual(typesOn(r, 7), [])
  })
})

// ─── Admin corrections ────────────────────────────────────────────────────────

function correction(day: number, over: Partial<AttendanceDayCorrection> = {}): AttendanceDayCorrection {
  return {
    attendance_date: iso(day),
    corrected_check_in_at:  null,
    corrected_check_out_at: null,
    day_treatment: 'auto',
    waive_late_arrival: false,
    waive_early_checkout: false,
    waive_missing_punch: false,
    ...over,
  }
}

describe('admin corrections still govern the day', () => {
  test('19. Waive Missing Punch removes the charge for BOTH missing-punch types', () => {
    const waive = { waive_missing_punch: true }

    const inMissing = run(
      monthWith(outOnly(8, 18, 30, 'inferred')),
      [correction(8, { corrected_check_out_at: at(8, 18, 30), ...waive })],
    )
    assert.deepEqual(typesOn(inMissing, 8), [])
    assert.equal(amountOn(inMissing, 8), 0)
    assert.equal(classificationOn(inMissing, 8), 'missing_punch', 'the day is still a missing punch, just not charged')

    const outMissing = run(
      monthWith(inOnly(9, 10, 0, 'confirmed')),
      [correction(9, { corrected_check_in_at: at(9, 10, 0), ...waive })],
    )
    assert.deepEqual(typesOn(outMissing, 9), [])
    assert.equal(amountOn(outMissing, 9), 0)
  })

  test('waiving the missing punch on a confirmed LATE day leaves the late line standing', () => {
    const r = run(
      monthWith(inOnly(9, 11, 30, 'confirmed')),
      [correction(9, { corrected_check_in_at: at(9, 11, 30), waive_missing_punch: true })],
    )
    assert.deepEqual(typesOn(r, 9), ['late_arrival'])
  })

  test('20. supplying the missing punch removes the missing-punch line entirely', () => {
    const before = run(monthWithLeaveSpent(inOnly(9, 10, 0, 'confirmed')))
    assert.deepEqual(typesOn(before, 9), ['missing_punch_out'])

    const after = run(
      monthWithLeaveSpent(inOnly(9, 10, 0, 'confirmed')),
      [correction(9, {
        corrected_check_in_at:  at(9, 10, 0),
        corrected_check_out_at: at(9, 18, 30),
      })],
    )

    assert.equal(classificationOn(after, 9), 'full_present')
    assert.deepEqual(typesOn(after, 9), [])
    assert.equal(amountOn(after, 9), 0)
    assert.equal(after.missing_punch_hours, 0)
    assert.ok(after.net_salary > before.net_salary, 'correcting the day must give the money back')
  })

  test('an admin correction makes the direction CONFIRMED, so a real late arrival is charged', () => {
    // The escape hatch for the cautious default: an inferred morning punch is not
    // charged for lateness, but once an admin states it WAS the arrival, it is.
    const inferred = run(monthWith(inOnly(9, 11, 30, 'inferred')))
    assert.deepEqual(typesOn(inferred, 9), ['missing_punch_out'])

    const confirmed = run(
      monthWith(inOnly(9, 11, 30, 'inferred')),
      [correction(9, { corrected_check_in_at: at(9, 11, 30) })],
    )
    assert.deepEqual(typesOn(confirmed, 9), ['late_arrival', 'missing_punch_out'])
  })

  test('an admin correction can restate a mis-read direction', () => {
    // A lone 13:30 punch is inferred as an arrival. If it was really a departure,
    // the admin says so and the day becomes a missing punch-IN.
    const raw = run(monthWith(inOnly(9, 13, 30, 'inferred')))
    assert.deepEqual(typesOn(raw, 9), ['missing_punch_out'])

    const fixed = run(
      monthWith(inOnly(9, 13, 30, 'inferred')),
      [correction(9, { corrected_check_out_at: at(9, 13, 30) })],
    )
    assert.deepEqual(typesOn(fixed, 9), ['missing_punch_in'])
  })

  test('a forced day treatment still overrides the missing punch entirely', () => {
    for (const [treatment, expected] of [
      ['full_day', 'full_present'],
      ['half_day', 'half_day'],
      ['absent',   'full_absent'],
    ] as const) {
      const r = run(
        monthWith(outOnly(8, 18, 30, 'inferred')),
        [correction(8, { day_treatment: treatment, corrected_check_out_at: at(8, 18, 30) })],
      )
      assert.equal(classificationOn(r, 8), expected, treatment)
      assert.equal(
        typesOn(r, 8).includes('missing_punch_in'), false,
        `${treatment} must not leave a missing-punch line behind`,
      )
    }
  })

  test('the raw punches stay readable next to the corrected ones', () => {
    const r = run(
      monthWith(outOnly(8, 18, 30, 'inferred')),
      [correction(8, {
        corrected_check_in_at:  at(8, 10, 0),
        corrected_check_out_at: at(8, 18, 30),
      })],
    )
    const day = r.day_results.find(d => d.date === iso(8))!
    assert.equal(day.is_corrected, true)
    assert.equal(day.raw_check_in_at, null, 'the machine had no punch-in and still has none')
    assert.equal(day.raw_check_out_at, at(8, 18, 30))
    assert.equal(day.check_in_at, at(8, 10, 0))
  })
})

// ─── Paid leave ───────────────────────────────────────────────────────────────

describe('company-paid leave still absorbs a missing punch the way it did', () => {
  test('a lone missing-punch charge inside the allowance is waived to ₹0 but stays visible', () => {
    const r = run(monthWith(inOnly(7, 10, 0, 'inferred')))

    // 2 h is well inside the 8.5 h a full paid-leave day can absorb.
    assert.equal(r.leave_absorbed_deductions, true)
    assert.equal(amountOn(r, 7), 0)

    const line = linesOn(r, 7)[0]
    assert.equal(line.deduction_type, 'missing_punch_out')
    assert.equal(line.waived_by, 'paid_leave')
    assert.ok(line.explain, 'a waived line still explains itself')
    assert.equal(line.explain.gross_amount > 0, true, 'what it would have cost is preserved')

    const deducted = toDeductionDays(r.day_results).find(d => d.date === iso(7))
    assert.ok(deducted, 'a company-paid day must not vanish from the Deductions tab')
  })

  test('an absence is absorbed ahead of missing-punch hours, as before', () => {
    const withoutDay7 = monthWith(inOnly(8, 10, 0, 'inferred'))
      .filter(rec => rec.attendance_date !== iso(7))
    const r = run(withoutDay7)

    assert.equal(r.days_absent, 1)
    assert.equal(amountOn(r, 7), 0, 'the absence is the company-paid item')
    assert.equal(r.leave_absorbed_deductions, false)
    assert.ok(amountOn(r, 8) > 0, 'the missing punch is then charged normally')
  })
})

// ─── Locking ──────────────────────────────────────────────────────────────────

describe('a locked period is untouched by any of this', () => {
  test('the engine refuses to calculate at all', () => {
    const locked: EnginePeriod = { ...period, status: 'locked' }
    const outcome = generatePayrollForEmployee(
      employee, locked, monthWith(outOnly(8, 18, 30, 'inferred')), [], [], [],
    )
    assert.equal(isSkip(outcome), true)
    if (!isSkip(outcome)) return
    assert.equal(outcome.reason, 'period_locked')
  })
})
