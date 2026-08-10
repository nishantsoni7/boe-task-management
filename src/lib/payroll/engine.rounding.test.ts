/**
 * Whole-rupee payroll, end to end through the engine.
 *
 *   npx tsx --test src/lib/payroll/engine.rounding.test.ts
 *
 * money.test.ts proves the helper rounds correctly. This proves the ENGINE
 * applies it in the right places and, more importantly, in the right ORDER.
 *
 * The order is the entire rule. Rounding each line and then summing gives a
 * payslip an employee can add up; summing and then rounding gives a total that
 * no combination of the printed lines produces. Both look plausible in a diff
 * and only one of them is defensible when somebody queries their salary.
 *
 * The salary here is chosen so the arithmetic does NOT come out even:
 * ₹26,000 ÷ 26 = ₹1,000/day ÷ 8.5 = ₹117.6470588…/hour. Every hourly line is
 * therefore a rounding decision rather than a coincidence.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { generatePayrollForEmployee } from './engine'
import { isSkip } from './types'
import type {
  EngineEmployee,
  EnginePeriod,
  EngineAttendanceRecord,
  EnginePendingAdjustment,
  EngineResult,
} from './types'
import { DEFAULT_PAYROLL_SETTINGS, type PayrollSettings } from './settings'
import { roundRupees, isWholeRupees, sumRupees } from './money'
import { computeSettlement } from './settlement'

const SALARY   = 26_000
const PER_DAY  = SALARY / DEFAULT_PAYROLL_SETTINGS.per_day_divisor          // 1000
const PER_HOUR = PER_DAY / DEFAULT_PAYROLL_SETTINGS.full_day_hours          // 117.647058…

const EMPLOYEE: EngineEmployee = {
  id: 'emp-1',
  monthly_salary: SALARY,
  payroll_active: true,
  joining_date: null,
  employment_type: 'permanent',
}

const PERIOD: EnginePeriod = { id: 'per-1', payroll_month: 7, payroll_year: 2026, status: 'draft' }

/** An ISO timestamp for a July 2026 date at an IST wall-clock time. */
function at(day: number, h: number, m: number): string {
  const utcH = h - 5
  const utcM = m - 30
  return new Date(Date.UTC(2026, 6, day, utcH, utcM)).toISOString()
}

function iso(day: number): string {
  return `2026-07-${String(day).padStart(2, '0')}`
}

function full(day: number): EngineAttendanceRecord {
  return {
    id: `r-${day}`, attendance_date: iso(day),
    check_in_at: at(day, 10, 0), check_out_at: at(day, 18, 30),
    direction_source: 'confirmed',
  }
}

function late(day: number, h: number, m: number): EngineAttendanceRecord {
  return {
    id: `r-${day}`, attendance_date: iso(day),
    check_in_at: at(day, h, m), check_out_at: at(day, 18, 30),
    direction_source: 'confirmed',
  }
}

function run(
  records: EngineAttendanceRecord[],
  adjustments: EnginePendingAdjustment[] = [],
  settings: PayrollSettings = DEFAULT_PAYROLL_SETTINGS,
): EngineResult {
  const outcome = generatePayrollForEmployee(EMPLOYEE, PERIOD, records, [], adjustments, [], settings)
  assert.equal(isSkip(outcome), false)
  return outcome as EngineResult
}

/** Every working day of July 2026 present and on time, except the named ones. */
function monthPresentExcept(overrides: EngineAttendanceRecord[]): EngineAttendanceRecord[] {
  const overridden = new Set(overrides.map(r => r.attendance_date))
  const records: EngineAttendanceRecord[] = []
  for (let d = 1; d <= 31; d++) {
    const date = iso(d)
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) continue  // Sunday
    if (overridden.has(date)) continue
    records.push(full(d))
  }
  return [...records, ...overrides]
}

// ─── Every monetary figure is whole ───────────────────────────────────────────

describe('no paise reaches a stored figure', () => {
  const r = run(monthPresentExcept([late(7, 10, 45), late(8, 11, 30), late(9, 10, 20)]))

  test('every deduction line amount is a whole rupee', () => {
    assert.ok(r.deduction_lines.length > 0, 'the fixture must produce lines')
    for (const line of r.deduction_lines) {
      assert.ok(
        isWholeRupees(line.amount_deducted),
        `${line.line_date}/${line.deduction_type} = ${line.amount_deducted}`,
      )
    }
  })

  test('every explain.gross_amount is a whole rupee', () => {
    for (const line of r.deduction_lines) {
      assert.ok(isWholeRupees(line.explain!.gross_amount), `${line.line_date} gross`)
    }
  })

  test('every summary money figure is a whole rupee', () => {
    for (const [label, value] of Object.entries({
      gross_salary: r.gross_salary,
      total_deductions: r.total_deductions,
      pending_adjustment_total: r.pending_adjustment_total,
      net_salary: r.net_salary,
    })) {
      assert.ok(isWholeRupees(value), `${label} = ${value}`)
    }
  })

  test('every per-day total is a whole rupee', () => {
    for (const day of r.day_results) {
      assert.ok(isWholeRupees(day.total_deduction_amount), `${day.date} = ${day.total_deduction_amount}`)
    }
  })

  test('non-monetary quantities stay PRECISE — hours are not rounded to rupees', () => {
    // The rule is about money. Rounding hours would change what is being
    // charged, not just how it is written down.
    const halfHourLine = r.deduction_lines.find(l => l.hours_deducted === 0.5)
    assert.ok(halfHourLine, 'expected at least one half-hour deduction in the fixture')
    assert.equal(halfHourLine.hours_deducted, 0.5)
    // And the rate behind the line is still the unrounded per-hour figure.
    assert.equal(halfHourLine.explain!.rate, PER_HOUR)
    assert.ok(!Number.isInteger(PER_HOUR), 'the fixture rate must be fractional to prove this')
  })
})

// ─── The total is the sum of the lines ────────────────────────────────────────

describe('displayed totals equal the sum of displayed lines', () => {
  test('total_deductions is exactly the sum of the line amounts', () => {
    const r = run(monthPresentExcept([late(7, 10, 45), late(8, 11, 30), late(9, 10, 20)]))
    assert.equal(r.total_deductions, sumRupees(r.deduction_lines.map(l => l.amount_deducted)))
  })

  test('it holds with absences and half days mixed in', () => {
    const r = run(monthPresentExcept([late(7, 11, 30)]).filter(rec => rec.attendance_date !== iso(9)))
    assert.equal(r.total_deductions, sumRupees(r.deduction_lines.map(l => l.amount_deducted)))
  })

  test('each day total is the sum of that day’s lines', () => {
    const r = run(monthPresentExcept([late(7, 11, 30)]))
    for (const day of r.day_results) {
      assert.equal(
        day.total_deduction_amount,
        sumRupees(day.deduction_lines.map(l => l.amount_deducted)),
        day.date,
      )
    }
  })

  test('net salary is derived from the rounded figures, not re-rounded independently', () => {
    const r = run(monthPresentExcept([late(7, 10, 45)]), [
      { id: 'a1', amount: 800,  description: 'Reimbursement' },
      { id: 'a2', amount: -500, description: 'Advance recovery' },
    ])
    assert.equal(
      r.net_salary,
      Math.max(0, r.gross_salary - r.total_deductions + r.pending_adjustment_total),
    )
  })

  test('the rounding of a SUM would have differed — so the order genuinely matters', () => {
    // 10:45 is 45 minutes past a 10:00 start → ceil(45/30) = 2 blocks = 1.0h.
    // Three 1.0h lines: each is round(117.647) = 118, summing to 354.
    // Rounding the sum instead gives round(352.94) = 353. The one-rupee gap is
    // the defect this rule removes, and it is asserted rather than assumed so
    // the fixture cannot quietly stop exercising it.
    //
    // July 10 is dropped so the month's paid leave is spent absorbing that
    // absence. Without it the allowance covers the 1.5h of lateness instead
    // (stage 3), every late line is zeroed, and this test would pass on 0 === 0
    // while proving nothing.
    const r = run(
      monthPresentExcept([late(7, 10, 45), late(8, 10, 45), late(9, 10, 45)])
        .filter(rec => rec.attendance_date !== iso(10)),
    )
    const lateLines = r.deduction_lines.filter(l => l.deduction_type === 'late_arrival')
    assert.ok(lateLines.every(l => l.waived_by == null), 'the late lines must actually be charged')
    assert.equal(lateLines.length, 3)

    const sumOfRounded = sumRupees(lateLines.map(l => l.amount_deducted))
    const roundedSum   = roundRupees(lateLines.reduce((s, l) => s + l.hours_deducted * PER_HOUR, 0))
    assert.equal(sumOfRounded, 354)
    assert.equal(roundedSum, 353)
    assert.notEqual(sumOfRounded, roundedSum)
  })
})

// ─── Adjustments ──────────────────────────────────────────────────────────────

describe('adjustments round per line before aggregation', () => {
  test('each adjustment is rounded, then summed', () => {
    const r = run(monthPresentExcept([]), [
      { id: 'a1', amount: 100.4,  description: 'Incentive' },
      { id: 'a2', amount: 100.4,  description: 'Bonus' },
      { id: 'a3', amount: -50.6,  description: 'Advance recovery' },
    ])
    // round(100.4)=100 twice, round(-50.6)=-51 → 200 − 51 = 149.
    // Rounding the raw sum (150.2) would have given 150.
    assert.equal(r.pending_adjustment_total, 149)
  })

  test('a negative adjustment rounds away from zero, like every other line', () => {
    const r = run(monthPresentExcept([]), [{ id: 'a1', amount: -10.5, description: 'Recovery' }])
    assert.equal(r.pending_adjustment_total, -11)
  })

  test('zero-value adjustments contribute nothing and break nothing', () => {
    const r = run(monthPresentExcept([]), [{ id: 'a1', amount: 0, description: 'Noted' }])
    assert.equal(r.pending_adjustment_total, 0)
    assert.ok(isWholeRupees(r.net_salary))
  })
})

// ─── Waived lines ─────────────────────────────────────────────────────────────

describe('waived and zero deductions', () => {
  test('a paid-leave covered line is exactly 0, and still whole', () => {
    const r = run(monthPresentExcept([]).filter(rec => rec.attendance_date !== iso(7)))
    const waived = r.deduction_lines.filter(l => l.waived_by === 'paid_leave')
    assert.ok(waived.length > 0, 'the fixture must produce a covered line')
    for (const line of waived) {
      assert.equal(line.amount_deducted, 0)
      assert.ok(isWholeRupees(line.explain!.gross_amount), 'and it still reports what it would have cost')
    }
  })
})

// ─── Determinism and recalculation ────────────────────────────────────────────

describe('recalculation uses the same rounding', () => {
  test('running twice produces identical figures', () => {
    const records = monthPresentExcept([late(7, 10, 45), late(8, 11, 30)])
    const a = run(records)
    const b = run(records)
    assert.equal(a.total_deductions, b.total_deductions)
    assert.equal(a.net_salary, b.net_salary)
    assert.deepEqual(
      a.deduction_lines.map(l => l.amount_deducted),
      b.deduction_lines.map(l => l.amount_deducted),
    )
  })

  test('a recalculation under a period’s own snapshot reproduces its figures', () => {
    const records = monthPresentExcept([late(7, 10, 45)])
    const original = run(records, [], DEFAULT_PAYROLL_SETTINGS)
    const rerun    = run(records, [], { ...DEFAULT_PAYROLL_SETTINGS })
    assert.equal(rerun.total_deductions, original.total_deductions)
    assert.equal(rerun.net_salary, original.net_salary)
  })
})

// ─── History is not restated ──────────────────────────────────────────────────

describe('existing payroll is not rewritten by the rounding rule', () => {
  test('settlement passes a legacy row through with its paise intact', () => {
    // A month generated BEFORE the whole-rupee rule stored fractional figures.
    // Reading it must not restate it: its stored deduction LINES are unrounded
    // too, so a rounded total would stop matching the column printed above it.
    // The month is self-consistent in its own terms and stays that way.
    const legacy = computeSettlement(
      {
        gross_salary: 26_500,
        total_deductions: 2_578.05,
        pending_adjustment_total: 300,
        days_present: 20,
      },
      { carry_forward_amount: 2_000, amount_paid: 24_000 },
    )
    assert.equal(legacy.attendance_deductions, 2_578.05)
    assert.equal(legacy.salary_after_attendance, 26_500 - 2_578.05)
    // The arithmetic still reconciles exactly, which is what "unchanged" means.
    assert.equal(
      legacy.salary_payable,
      legacy.salary_after_attendance + legacy.net_adjustments,
    )
  })

  test('settlement on a NEW result is whole throughout, for free', () => {
    const r = run(monthPresentExcept([late(7, 10, 45)]))
    const s = computeSettlement(
      {
        gross_salary: r.gross_salary,
        total_deductions: r.total_deductions,
        pending_adjustment_total: r.pending_adjustment_total,
        days_present: r.days_present,
      },
      { carry_forward_amount: 0, amount_paid: null },
    )
    for (const [label, value] of Object.entries({
      gross_salary: s.gross_salary,
      attendance_deductions: s.attendance_deductions,
      salary_after_attendance: s.salary_after_attendance,
      net_adjustments: s.net_adjustments,
      salary_payable: s.salary_payable,
    })) {
      assert.ok(isWholeRupees(value), `${label} = ${value}`)
    }
    // No rounding call was needed in settlement to achieve that — it inherits
    // whole rupees from the engine, which is the design.
    assert.equal(s.closing_balance, null, 'and an unrecorded payment still has no balance')
  })
})
