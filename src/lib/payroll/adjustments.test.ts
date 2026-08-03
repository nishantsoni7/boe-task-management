/**
 * Manual payroll adjustments — storage shape → engine shape.
 *
 * Regression cover for the sign defect: `payroll_pending_adjustments.amount` is
 * stored positive with the direction in `adjustment_type`, but the generation
 * path read `amount` raw, so a manual DEDUCTION increased net salary. These
 * tests pin the conversion and then prove the effect end-to-end through the
 * engine, including across an attendance-correction recalculation.
 *
 * Run:
 *   npx tsx --test src/lib/payroll/adjustments.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { toSignedAdjustment, toSignedAdjustments, type StoredAdjustment } from './adjustments'
import { generatePayrollForEmployee } from './engine'
import { isSkip } from './types'
import type {
  EngineEmployee,
  EnginePeriod,
  EngineAttendanceRecord,
  EngineResult,
  EnginePendingAdjustment,
} from './types'
import type { AttendanceDayCorrection } from '../attendance/corrections'

// ─── Conversion ───────────────────────────────────────────────────────────────

function stored(overrides: Partial<StoredAdjustment> = {}): StoredAdjustment {
  return { id: 'a1', adjustment_type: 'addition', amount: 1000, description: 'May shortfall', ...overrides }
}

describe('toSignedAdjustment', () => {
  test('an addition stays positive', () => {
    assert.equal(toSignedAdjustment(stored()).amount, 1000)
  })

  test('a deduction becomes negative', () => {
    // The defect in one line: this used to come back as +1000.
    assert.equal(toSignedAdjustment(stored({ adjustment_type: 'deduction' })).amount, -1000)
  })

  test('the stored sign cannot contradict the type', () => {
    // A stray negative amount on a deduction row must still deduct, not add.
    assert.equal(toSignedAdjustment(stored({ adjustment_type: 'deduction', amount: -1000 })).amount, -1000)
    assert.equal(toSignedAdjustment(stored({ adjustment_type: 'addition',  amount: -1000 })).amount,  1000)
  })

  test('a missing type is treated as an addition, matching the column default', () => {
    assert.equal(toSignedAdjustment(stored({ adjustment_type: null })).amount, 1000)
  })

  test('id and description are carried through, with a null description as empty', () => {
    const converted = toSignedAdjustment(stored({ id: 'x9', description: null }))
    assert.equal(converted.id, 'x9')
    assert.equal(converted.description, '')
  })

  test('no rounding is applied — the engine sums at full precision', () => {
    assert.equal(toSignedAdjustment(stored({ amount: 1234.567 })).amount, 1234.567)
    assert.equal(toSignedAdjustment(stored({ adjustment_type: 'deduction', amount: 0.005 })).amount, -0.005)
  })

  test('a batch converts row by row', () => {
    const converted = toSignedAdjustments([
      stored({ id: 'add', adjustment_type: 'addition',  amount: 1000 }),
      stored({ id: 'ded', adjustment_type: 'deduction', amount: 400 }),
    ])
    assert.deepEqual(converted.map(a => a.amount), [1000, -400])
  })
})

// ─── Effect on payroll ────────────────────────────────────────────────────────

const SALARY = 30_000
const PERIOD: EnginePeriod = { id: 'p1', payroll_month: 7, payroll_year: 2026, status: 'draft' }
const EMPLOYEE: EngineEmployee = {
  id: 'e1', monthly_salary: SALARY, payroll_active: true, joining_date: null, employment_type: 'permanent',
}
const TARGET = '2026-07-21'

function ist(date: string, hh: number, mm: number): string {
  return new Date(Date.UTC(
    Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hh, mm - 330,
  )).toISOString()
}

/** A clean month: every non-Sunday worked 10:00–18:30, so deductions are zero. */
function cleanMonth(): EngineAttendanceRecord[] {
  const out: EngineAttendanceRecord[] = []
  for (let d = 1; d <= 31; d++) {
    const date = `2026-07-${String(d).padStart(2, '0')}`
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) continue
    out.push({ id: `r${d}`, attendance_date: date, check_in_at: ist(date, 10, 0), check_out_at: ist(date, 18, 30) })
  }
  return out
}

/** The same month with a forgotten punch-in on the target date. */
function monthWithDefect(): EngineAttendanceRecord[] {
  return cleanMonth().map(r =>
    r.attendance_date === TARGET
      ? { ...r, check_in_at: ist(TARGET, 19, 0), check_out_at: null }
      : r,
  )
}

function run(
  attendance: EngineAttendanceRecord[],
  adjustments: EnginePendingAdjustment[],
  corrections: AttendanceDayCorrection[] = [],
): EngineResult {
  const outcome = generatePayrollForEmployee(EMPLOYEE, PERIOD, attendance, [], adjustments, corrections)
  if (isSkip(outcome)) throw new Error(`unexpected skip: ${outcome.reason}`)
  return outcome
}

function near(a: number, b: number, tol = 0.01) {
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b}`)
}

describe('adjustments applied to payroll', () => {
  test('a ₹1,000 addition increases net salary by exactly ₹1,000', () => {
    const none = run(cleanMonth(), [])
    const withAddition = run(cleanMonth(), toSignedAdjustments([stored({ amount: 1000 })]))
    near(withAddition.net_salary - none.net_salary, 1000)
    near(withAddition.pending_adjustment_total, 1000)
  })

  test('a ₹1,000 deduction reduces net salary by exactly ₹1,000', () => {
    const none = run(cleanMonth(), [])
    const withDeduction = run(cleanMonth(), toSignedAdjustments([
      stored({ adjustment_type: 'deduction', amount: 1000 }),
    ]))
    near(none.net_salary - withDeduction.net_salary, 1000)
    near(withDeduction.pending_adjustment_total, -1000)
  })

  test('the raw-amount reading is what made a deduction pay more', () => {
    // Guards the regression directly: converted vs. the old unconverted read.
    const rows = [stored({ adjustment_type: 'deduction', amount: 1000 })]
    const converted   = run(cleanMonth(), toSignedAdjustments(rows))
    const unconverted = run(cleanMonth(), rows.map(r => ({ id: r.id, amount: r.amount, description: '' })))
    near(unconverted.net_salary - converted.net_salary, 2000)
    assert.ok(converted.net_salary < unconverted.net_salary)
  })

  test('a mixed addition and deduction nets out correctly', () => {
    const none = run(cleanMonth(), [])
    const mixed = run(cleanMonth(), toSignedAdjustments([
      stored({ id: 'a', adjustment_type: 'addition',  amount: 2500 }),
      stored({ id: 'b', adjustment_type: 'deduction', amount: 1000 }),
      stored({ id: 'c', adjustment_type: 'deduction', amount: 500 }),
    ]))
    near(mixed.pending_adjustment_total, 1000)
    near(mixed.net_salary - none.net_salary, 1000)
  })

  test('net salary never goes below zero, however large the deduction', () => {
    const huge = run(cleanMonth(), toSignedAdjustments([
      stored({ adjustment_type: 'deduction', amount: 500_000 }),
    ]))
    assert.equal(huge.net_salary, 0)
  })
})

// ─── The two fixes together ───────────────────────────────────────────────────

describe('attendance correction recalculation with a pending deduction', () => {
  const deduction = toSignedAdjustments([stored({ adjustment_type: 'deduction', amount: 1000 })])

  const correction: AttendanceDayCorrection = {
    attendance_date: TARGET,
    corrected_check_in_at:  ist(TARGET, 10, 0),
    corrected_check_out_at: ist(TARGET, 18, 30),
    day_treatment: 'full_day',
    waive_late_arrival: false,
    waive_early_checkout: false,
    waive_missing_punch: false,
  }

  test('a correction does not reverse a pending deduction', () => {
    const after = run(monthWithDefect(), deduction, [correction])
    // Still a deduction after recalculation — not flipped into a credit.
    near(after.pending_adjustment_total, -1000)
    assert.ok(after.pending_adjustment_total < 0)
  })

  test('the recalculated net salary is gross − attendance deductions − the adjustment', () => {
    const corrected = run(monthWithDefect(), deduction, [correction])
    // The correction clears the whole date, so the month is clean again.
    near(corrected.total_deductions, 0)
    near(corrected.net_salary, SALARY - 1000)
  })

  test('the correction still removes the attendance deductions it is meant to', () => {
    const before = run(monthWithDefect(), deduction)
    const after  = run(monthWithDefect(), deduction, [correction])
    assert.ok(before.total_deductions > 0)
    near(after.total_deductions, 0)
    assert.ok(after.net_salary > before.net_salary)
  })

  test('an addition survives a recalculation as an addition', () => {
    const addition = toSignedAdjustments([stored({ adjustment_type: 'addition', amount: 1000 })])
    const after = run(monthWithDefect(), addition, [correction])
    near(after.pending_adjustment_total, 1000)
    near(after.net_salary, SALARY + 1000)
  })
})
