/**
 * Payroll engine — manual attendance corrections.
 *
 * The scenario that motivated the feature, and the guarantees around it:
 * a corrected day is reclassified, its stale deductions disappear, the raw
 * biometric input is never touched, and the monthly totals move with it.
 *
 * July 2026: Sundays fall on 5, 12, 19, 26.
 *
 * Run:
 *   npx tsx --test src/lib/payroll/engine.corrections.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { generatePayrollForEmployee } from './engine'
import { isSkip } from './types'
import type {
  EngineEmployee,
  EnginePeriod,
  EngineAttendanceRecord,
  EngineResult,
} from './types'
import type { AttendanceDayCorrection } from '../attendance/corrections'
import { toDeductionDays, toConsideredDays } from './resultTabs'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SALARY = 30_000
const PDR    = SALARY / 26
const PHR    = PDR / 8.5

const PERIOD: EnginePeriod = { id: 'p1', payroll_month: 7, payroll_year: 2026, status: 'draft' }

const EMPLOYEE: EngineEmployee = {
  id: 'e1',
  monthly_salary: SALARY,
  payroll_active: true,
  joining_date: null,
  employment_type: 'permanent',
}

const TARGET = '2026-07-21'

/** IST wall-clock on a date → the UTC instant the import would have stored. */
function ist(date: string, hh: number, mm: number): string {
  return new Date(Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
    hh,
    mm - 330,
  )).toISOString()
}

function julyWorkingDays(): string[] {
  const out: string[] = []
  for (let d = 1; d <= 31; d++) {
    const date = `2026-07-${String(d).padStart(2, '0')}`
    if (new Date(`${date}T00:00:00Z`).getUTCDay() !== 0) out.push(date)
  }
  return out
}

/** A clean 10:00–18:30 day. */
function fullDay(date: string, i: number): EngineAttendanceRecord {
  return { id: `r${i}`, attendance_date: date, check_in_at: ist(date, 10, 0), check_out_at: ist(date, 18, 30) }
}

/**
 * The reported defect, as data — and as it is STORED IN THE DATABASE TODAY.
 *
 * The employee forgot to punch in and only punched out at 19:00. The old parser
 * filed the first available punch as the punch-in whatever the clock said, so
 * every such row already written reads as an arrival at 19:00 with no departure.
 *
 * The importer no longer creates rows like this — a lone 19:00 punch is now
 * stored as a punch-OUT (see storedAsPunchOut below, and
 * src/lib/attendance/punchParser.ts). The shape is kept here on purpose, because
 * the rows it describes are still in the table and the engine has to treat them
 * safely: with no stated provenance the direction is only a guess, so the day
 * costs the flat missing-punch charge and NOT the nine hours of "lateness" it
 * used to attract on top.
 */
function forgottenPunchIn(date: string): EngineAttendanceRecord {
  return { id: 'bad', attendance_date: date, check_in_at: ist(date, 19, 0), check_out_at: null }
}

/** The same forgotten punch as the fixed importer records it. */
function storedAsPunchOut(date: string): EngineAttendanceRecord {
  return { id: 'bad', attendance_date: date, check_in_at: null, check_out_at: ist(date, 19, 0) }
}

function attendanceWithDefect(): EngineAttendanceRecord[] {
  return julyWorkingDays().map((date, i) =>
    date === TARGET ? forgottenPunchIn(date) : fullDay(date, i),
  )
}

/** A working day with no record at all, so the month carries one absence. */
const ABSENT_DATE = '2026-07-02'

/**
 * The same month with its paid-leave allowance already spent on an absence.
 *
 * Needed by the tests that assert what the defect COSTS. The charge is now 2 h
 * rather than 11 h, which fits inside the 8.5 h a full paid-leave day absorbs —
 * so with a clean month the figure under test would read ₹0 for a reason that
 * has nothing to do with the correction. Absorption itself is asserted in
 * engine.companyPaidLeave.test.ts; here it is held out of the way.
 */
function attendanceWithSpentLeave(): EngineAttendanceRecord[] {
  return attendanceWithDefect().filter(r => r.attendance_date !== ABSENT_DATE)
}

function correction(overrides: Partial<AttendanceDayCorrection> = {}): AttendanceDayCorrection {
  return {
    attendance_date: TARGET,
    corrected_check_in_at:  ist(TARGET, 10, 0),
    corrected_check_out_at: ist(TARGET, 19, 0),
    day_treatment: 'auto',
    waive_late_arrival: false,
    waive_early_checkout: false,
    waive_missing_punch: false,
    ...overrides,
  }
}

function run(
  attendance: EngineAttendanceRecord[],
  corrections: AttendanceDayCorrection[] = [],
): EngineResult {
  const outcome = generatePayrollForEmployee(EMPLOYEE, PERIOD, attendance, [], [], corrections)
  if (isSkip(outcome)) throw new Error(`unexpected skip: ${outcome.reason}`)
  return outcome
}

function linesOn(result: EngineResult, date: string) {
  return result.deduction_lines.filter(l => l.line_date === date)
}

function near(a: number, b: number, tol = 0.01) {
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b}`)
}

// ─── The defect, before any correction ────────────────────────────────────────

describe('the uncorrected day', () => {
  // CHANGED EXPECTATION, deliberately. This used to assert
  // ['late_arrival', 'missing_punch_out'] — 2 h for the missing punch plus 9 h
  // of lateness measured from a 19:00 "arrival" the machine never said was an
  // arrival. That 11 h on a single present day exceeded a full day's pay and was
  // the defect this change removes, so asserting it as the baseline would now be
  // asserting the bug. The late-arrival line is only raised when the direction is
  // CONFIRMED; a stored row carries no provenance, so it is not.
  test('a legacy row with one unexplained punch costs the flat missing-punch charge only', () => {
    const before = run(attendanceWithDefect())
    const types = linesOn(before, TARGET).map(l => l.deduction_type).sort()
    assert.deepEqual(types, ['missing_punch_out'])
  })

  test('the same day is still classified as a missing punch, and still present', () => {
    const before = run(attendanceWithDefect())
    assert.equal(before.day_results.find(d => d.date === TARGET)!.classification, 'missing_punch')
    assert.equal(before.days_absent, 0)
    near(before.missing_punch_hours, 2)
    near(before.late_deduction_hours, 0)
  })

  test('recorded the way the fixed importer stores it, it is a missing punch-IN', () => {
    const attendance = julyWorkingDays().map((date, i) =>
      date === TARGET ? storedAsPunchOut(date) : fullDay(date, i),
    )
    const before = run(attendance)

    assert.deepEqual(linesOn(before, TARGET).map(l => l.deduction_type), ['missing_punch_in'])
    assert.equal(before.day_results.find(d => d.date === TARGET)!.classification, 'missing_punch')
    near(before.missing_punch_hours, 2)
    near(before.late_deduction_hours, 0)
  })
})

// ─── 1 + 2 + 3 + 4: correcting the day ───────────────────────────────────────

describe('correcting a missing punch to a valid punch pair', () => {
  test('the day reclassifies from missing_punch to a present day', () => {
    const before = run(attendanceWithDefect())
    const after  = run(attendanceWithDefect(), [correction()])

    assert.equal(before.day_results.find(d => d.date === TARGET)!.classification, 'missing_punch')
    assert.equal(after.day_results.find(d => d.date === TARGET)!.classification,  'full_present')
  })

  test('the previous missing-punch deduction is gone', () => {
    const after = run(attendanceWithDefect(), [correction()])
    assert.equal(
      linesOn(after, TARGET).some(l => l.deduction_type.startsWith('missing_punch')),
      false,
    )
  })

  test('late arrival is computed from the corrected punch-in, not from the raw one', () => {
    // This test used to open by asserting 9 hours of lateness on the raw row
    // (19:00 read as an arrival). That charge is gone — see "the uncorrected
    // day" above — so what it now proves is the half that always mattered: once
    // an admin states the arrival, the late line is derived from THAT value.
    const before = run(attendanceWithDefect())
    assert.equal(linesOn(before, TARGET).some(l => l.deduction_type === 'late_arrival'), false)

    // Corrected to a 10:00 arrival, which is inside the grace period → no line.
    const onTime = run(attendanceWithDefect(), [correction()])
    assert.equal(linesOn(onTime, TARGET).some(l => l.deduction_type === 'late_arrival'), false)

    // Corrected to a genuinely late arrival → charged from the corrected time.
    const late = run(attendanceWithDefect(), [correction({
      corrected_check_in_at:  ist(TARGET, 10, 45),
      corrected_check_out_at: ist(TARGET, 18, 30),
    })])
    const lateLine = linesOn(late, TARGET).find(l => l.deduction_type === 'late_arrival')!
    near(lateLine.hours_deducted, 1)   // 45 min past 10:00 → rounds up to 1 h
  })

  test('an admin confirming the arrival restores the late-arrival charge', () => {
    // The escape hatch for the cautious default: the raw row cannot be charged
    // for lateness because nothing established it was an arrival. A correction
    // establishes it, and the 9 hours are chargeable again if that is what the
    // admin states happened.
    const confirmed = run(attendanceWithDefect(), [correction({
      corrected_check_in_at:  ist(TARGET, 19, 0),
      corrected_check_out_at: null,
    })])
    const types = linesOn(confirmed, TARGET).map(l => l.deduction_type).sort()
    assert.deepEqual(types, ['late_arrival', 'missing_punch_out'])
    near(linesOn(confirmed, TARGET).find(l => l.deduction_type === 'late_arrival')!.hours_deducted, 9)
  })

  test('both conflicting deductions are cleared by one full-day correction', () => {
    const after = run(attendanceWithDefect(), [correction({ day_treatment: 'full_day' })])
    assert.deepEqual(linesOn(after, TARGET), [])
    assert.equal(after.day_results.find(d => d.date === TARGET)!.classification, 'full_present')
  })

  test('a late-arriving correction still charges late arrival unless it is waived', () => {
    const late = correction({ corrected_check_in_at: ist(TARGET, 10, 45), corrected_check_out_at: ist(TARGET, 18, 30) })

    const charged = linesOn(run(attendanceWithDefect(), [late]), TARGET)
    assert.deepEqual(charged.map(l => l.deduction_type), ['late_arrival'])
    near(charged[0].hours_deducted, 1)   // 45 min past 10:00 → rounds up to 1h

    const waived = linesOn(run(attendanceWithDefect(), [{ ...late, waive_late_arrival: true }]), TARGET)
    assert.deepEqual(waived, [])
  })

  test('an early exit can be waived on its own', () => {
    const early = correction({ corrected_check_in_at: ist(TARGET, 10, 0), corrected_check_out_at: ist(TARGET, 17, 0) })

    const charged = linesOn(run(attendanceWithDefect(), [early]), TARGET)
    assert.deepEqual(charged.map(l => l.deduction_type), ['early_checkout'])

    const waived = linesOn(run(attendanceWithDefect(), [{ ...early, waive_early_checkout: true }]), TARGET)
    assert.deepEqual(waived, [])
  })

  test('a genuine missing punch can be exempted while staying a missing punch', () => {
    const exempt = correction({
      corrected_check_in_at: ist(TARGET, 10, 0),
      corrected_check_out_at: null,
      waive_missing_punch: true,
    })
    const after = run(attendanceWithDefect(), [exempt])
    assert.equal(after.day_results.find(d => d.date === TARGET)!.classification, 'missing_punch')
    assert.deepEqual(linesOn(after, TARGET), [])
  })
})

// ─── 6: raw data is untouched ────────────────────────────────────────────────

describe('raw biometric data', () => {
  test('the attendance records passed in are not modified by a correction', () => {
    const attendance = attendanceWithDefect()
    const snapshot = JSON.parse(JSON.stringify(attendance))
    run(attendance, [correction({ day_treatment: 'full_day' })])
    assert.deepEqual(attendance, snapshot)
  })

  test('the day view reports the machine values alongside the corrected ones', () => {
    const after = run(attendanceWithDefect(), [correction()])
    const day = after.day_results.find(d => d.date === TARGET)!
    assert.equal(day.raw_check_in_at,  ist(TARGET, 19, 0))   // what the machine said
    assert.equal(day.raw_check_out_at, null)
    assert.equal(day.check_in_at,      ist(TARGET, 10, 0))   // what payroll used
    assert.equal(day.is_corrected, true)
  })
})

// ─── 7 + 14: precedence and totals ───────────────────────────────────────────

describe('precedence and monthly totals', () => {
  test('the correction, not the raw record, drives the monthly figures', () => {
    // Uses the leave-spent month so the charge is visible in the totals rather
    // than absorbed. The hours themselves are allowance-independent.
    const before = run(attendanceWithSpentLeave())
    const after  = run(attendanceWithSpentLeave(), [correction({ day_treatment: 'full_day' })])

    // Before: the flat 2 h missing punch. The 9 h of lateness this used to
    // expect came from reading an unexplained 19:00 punch as an arrival.
    near(before.missing_punch_hours, 2)
    near(before.late_deduction_hours, 0)

    // After: nothing is charged to the date at all.
    near(after.missing_punch_hours, 0)
    near(after.late_deduction_hours, 0)
    assert.ok(after.total_deductions < before.total_deductions)
    assert.ok(after.net_salary > before.net_salary)
  })

  test('net salary moves by exactly the deduction that was removed', () => {
    // Leave absorption would otherwise mask the arithmetic. It used to be kept
    // out of the way by the sheer size of the (buggy) 11 h charge, which cleared
    // the 8.5 h absorption ceiling on its own; the honest 2 h charge does not, so
    // the allowance is spent on an absence instead.
    const before = run(attendanceWithSpentLeave())
    const after  = run(attendanceWithSpentLeave(), [correction({ day_treatment: 'full_day' })])
    near(after.net_salary - before.net_salary, 2 * PHR)
    near(before.total_deductions - after.total_deductions, 2 * PHR)
  })

  test('a day corrected to absent is deducted at the per-day rate', () => {
    const after = run(attendanceWithDefect(), [correction({ day_treatment: 'absent' })])
    assert.equal(after.day_results.find(d => d.date === TARGET)!.classification, 'full_absent')
    assert.equal(after.days_absent, 1)
    // The single absence is absorbed by the month's paid leave, so it costs
    // nothing — which is the existing leave rule doing its job, not the
    // correction failing.
    assert.equal(after.paid_leave_used, 1)
    near(linesOn(after, TARGET)[0].amount_deducted, 0)
  })

  test('a day corrected to a half day is counted and deducted as half a day', () => {
    const after = run(attendanceWithDefect(), [correction({ day_treatment: 'half_day' })])
    assert.equal(after.half_day_count, 1)
    const line = linesOn(after, TARGET).find(l => l.deduction_type === 'half_day')!
    near(line.amount_deducted, PDR / 2)
  })
})

// ─── 11 + 12 + 13: the two tabs ──────────────────────────────────────────────

describe('result tabs', () => {
  test('the Deductions tab holds only dates that cost money', () => {
    // On the leave-spent month, so the missing punch is genuinely charged. With
    // a clean month the allowance absorbs it and the date is listed at ₹0 —
    // correct, and asserted in engine.companyPaidLeave.test.ts, but not what
    // this test is about.
    const before = run(attendanceWithSpentLeave())
    const deductionDays = toDeductionDays(before.day_results)

    assert.deepEqual(deductionDays.map(d => d.date).sort(), [ABSENT_DATE, TARGET].sort())

    const target = deductionDays.find(d => d.date === TARGET)!
    assert.ok(target.total_amount > 0)
    assert.ok(target.lines.every(l => l.amount_deducted > 0))
  })

  test('the Days Considered tab holds the paid and present dates', () => {
    const before = run(attendanceWithDefect())
    const considered = toConsideredDays(before.day_results)

    // Every July date is present: 27 non-Sundays plus 4 weekly offs.
    assert.equal(considered.filter(d => d.classification === 'full_present').length, 26)
    assert.equal(considered.filter(d => d.classification === 'weekly_off').length, 4)
    assert.equal(considered.some(d => d.classification === 'full_absent'), false)
  })

  test('a corrected full-present day appears in Days Considered, flagged as corrected', () => {
    const after = run(attendanceWithDefect(), [correction({ day_treatment: 'full_day' })])
    const day = toConsideredDays(after.day_results).find(d => d.date === TARGET)!

    assert.equal(day.classification, 'full_present')
    assert.equal(day.payable_day_value, 1)
    assert.equal(day.is_corrected, true)

    // …and it is no longer in the Deductions tab at all.
    assert.equal(toDeductionDays(after.day_results).some(d => d.date === TARGET), false)
  })

  test('an absent date is a deduction, never a day considered', () => {
    const absent = attendanceWithDefect().filter(r => r.attendance_date !== TARGET)
    const result = run(absent)
    assert.equal(toConsideredDays(result.day_results).some(d => d.date === TARGET), false)
  })

  test('weekly offs are never editable, worked days always are', () => {
    const result = run(attendanceWithDefect())
    const sunday = result.day_results.find(d => d.date === '2026-07-05')!
    assert.equal(sunday.classification, 'weekly_off')
    assert.deepEqual(sunday.deduction_lines, [])
  })
})

// ─── Backwards compatibility ─────────────────────────────────────────────────

describe('no corrections supplied', () => {
  test('omitting the argument runs payroll on raw attendance alone', () => {
    const withArg    = run(attendanceWithDefect(), [])
    const withoutArg = generatePayrollForEmployee(EMPLOYEE, PERIOD, attendanceWithDefect(), [], [])
    if (isSkip(withoutArg)) throw new Error('unexpected skip')

    near(withArg.net_salary, withoutArg.net_salary)
    assert.equal(withArg.deduction_lines.length, withoutArg.deduction_lines.length)
    assert.equal(withArg.day_results.every(d => !d.is_corrected), true)
  })
})
