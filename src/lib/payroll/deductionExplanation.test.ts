/**
 * The deduction popup's copy and figures.
 *
 * The rule this file exists to enforce: the explanation must never contain a
 * number the engine did not produce. So the tests run the REAL engine, take its
 * lines, and assert that what the popup would display reconciles to the payroll
 * result — rather than hand-building a line and checking the prose against
 * itself.
 *
 * Run:
 *   npx tsx --test src/lib/payroll/deductionExplanation.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { generatePayrollForEmployee } from './engine'
import { isSkip } from './types'
import type { EngineEmployee, EnginePeriod, EngineAttendanceRecord, EngineResult } from './types'
import type { AttendanceDayCorrection } from '../attendance/corrections'
import { toDeductionDays } from './resultTabs'
import {
  explainLine,
  explainDay,
  dayDeductionTotal,
  deductionTitle,
  duration,
  clockLabel,
  money,
} from './deductionExplanation'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SALARY = 26_000
const employee: EngineEmployee = {
  id: 'emp-1', monthly_salary: SALARY, payroll_active: true,
  joining_date: null, employment_type: 'permanent',
}
const period: EnginePeriod = { id: 'p', payroll_month: 7, payroll_year: 2026, status: 'draft' }

const JULY_WORKING_DAYS = [
  1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18,
  20, 21, 22, 23, 24, 25, 27, 28, 29, 30, 31,
]

const iso = (d: number) => `2026-07-${String(d).padStart(2, '0')}`
const at  = (d: number, hh: number, mm: number) => new Date(Date.UTC(2026, 6, d, hh, mm - 330)).toISOString()

const rec = (
  d: number,
  inT: [number, number] | null,
  outT: [number, number] | null,
  // Whether the IN/OUT split is known or was guessed from the clock. Only
  // matters for single-punch days, where it decides whether a late-arrival line
  // may stack on the missing punch. See src/lib/attendance/punchDirection.ts.
  direction: 'confirmed' | 'inferred' = 'inferred',
): EngineAttendanceRecord => ({
  id: `r-${d}`,
  attendance_date: iso(d),
  check_in_at:  inT  ? at(d, inT[0],  inT[1])  : null,
  check_out_at: outT ? at(d, outT[0], outT[1]) : null,
  direction_source: direction,
})

const fullDay = (d: number) => rec(d, [10, 0], [18, 30])

function month(exceptions: Record<number, EngineAttendanceRecord | null>): EngineAttendanceRecord[] {
  const out: EngineAttendanceRecord[] = []
  for (const d of JULY_WORKING_DAYS) {
    if (d in exceptions) { const r = exceptions[d]; if (r) out.push(r); continue }
    out.push(fullDay(d))
  }
  return out
}

function run(records: EngineAttendanceRecord[], corrections: AttendanceDayCorrection[] = []): EngineResult {
  const o = generatePayrollForEmployee(employee, period, records, [], [], corrections)
  assert.ok(!isSkip(o))
  return o as EngineResult
}

function dayOf(r: EngineResult, date: string) {
  const day = toDeductionDays(r.day_results).find(d => d.date === date)
  assert.ok(day, `no deduction row for ${date}`)
  return day
}

/** The strong row is the popup's bottom line: the amount actually deducted. */
function deductionRow(item: ReturnType<typeof explainLine>) {
  const row = item.calculation.find(r => r.strong)
  assert.ok(row, 'every explanation ends in a deduction row')
  return row
}

// ─── Formatting primitives ────────────────────────────────────────────────────

describe('formatting', () => {
  test('durations read as an admin would say them', () => {
    assert.equal(duration(2), '2h')
    assert.equal(duration(1.5), '1h 30m')
    assert.equal(duration(0.5), '30m')
    assert.equal(duration(8.5), '8h 30m')
  })

  test('IST minutes become a 12-hour clock', () => {
    assert.equal(clockLabel(600), '10:00 AM')
    assert.equal(clockLabel(645), '10:45 AM')
    assert.equal(clockLabel(1110), '6:30 PM')
    assert.equal(clockLabel(0), '12:00 AM')
    assert.equal(clockLabel(720), '12:00 PM')
  })

  test('money is Indian-grouped to two decimals', () => {
    assert.equal(money(1000), '₹1,000.00')
    assert.equal(money(0), '₹0.00')
    assert.equal(money(117.647), '₹117.65')
  })
})

// ─── Each rule ────────────────────────────────────────────────────────────────

// Most fixtures below include one absent day. That is deliberate: without it the
// month's paid leave absorbs the hourly deductions (stage 3) and every line comes
// out company-paid, which is a different test. The absence spends the allowance
// at stage 1, so the hourly rules are charged and can be checked on their own.
describe('every deduction type explains itself from engine values', () => {
  test('late arrival: the clock, the grace period and the rounding', () => {
    const r = run(month({ 15: rec(15, [10, 45], [18, 30]), 21: null }))
    const day = dayOf(r, '2026-07-15')
    const [item] = explainDay(day.lines)

    assert.equal(item.title, 'Late Arrival')
    assert.match(item.rule, /45 min past 10:00 AM/)
    assert.match(item.rule, /first 15 minutes are free/)
    assert.match(item.rule, /rounds up to 1h/)
    assert.equal(deductionRow(item).value, money(day.lines[0].amount_deducted))
    assert.equal(item.amount, day.total_amount)
    assert.equal(item.companyPaid, false)
  })

  test('early departure: measured back from the end of the day', () => {
    const r = run(month({ 15: rec(15, [10, 0], [17, 30]), 21: null }))
    const day = dayOf(r, '2026-07-15')
    const item = explainDay(day.lines).find(x => x.title === 'Early Departure')
    assert.ok(item)
    assert.match(item.rule, /before 6:30 PM/)
    assert.equal(deductionRow(item).value, money(item.amount))
  })

  test('missing punch-out: a flat two hours, and the late arrival with it', () => {
    // In at 10:45, no punch-out — the engine raises BOTH lines on this date.
    //
    // The punch is marked CONFIRMED because that is now what makes the pair of
    // lines possible: the attendance file stated this punch was the arrival, so
    // measuring lateness from it is sound. An unmarked punch would carry the
    // flat missing-punch charge alone, which is asserted in
    // engine.missingPunch.test.ts. This test is about the popup rendering two
    // reasons on one date, so it needs the case that produces two.
    const r = run(month({ 15: rec(15, [10, 45], null, 'confirmed'), 21: null }))
    const day = dayOf(r, '2026-07-15')
    const items = explainDay(day.lines)

    assert.equal(items.length, 2, 'two reasons on one date')
    const missing = items.find(i => i.title === 'Missing Punch-Out')
    const late    = items.find(i => i.title === 'Late Arrival')
    assert.ok(missing && late)
    assert.match(missing.rule, /punch-in but no punch-out/)
    assert.match(missing.rule, /flat 2 hours/)

    // And the popup's total is the row's total.
    assert.equal(dayDeductionTotal(day.lines), day.total_amount)
    assert.equal(items.reduce((s, i) => s + i.amount, 0), day.total_amount)
  })

  test('missing punch-in', () => {
    const r = run(month({ 15: rec(15, null, [18, 30]), 21: null }))
    const day = dayOf(r, '2026-07-15')
    const [item] = explainDay(day.lines)
    assert.equal(item.title, 'Missing Punch-In')
    assert.match(item.rule, /punch-out but no punch-in/)
  })

  test('absent: charged as a whole day at the daily rate', () => {
    // Two absences, and the month's allowance settles the EARLIER one — so the
    // day that carries a real charge is 22 July, not 21.
    const r = run(month({ 21: null, 22: null }))
    const day = dayOf(r, '2026-07-22')
    const [item] = explainDay(day.lines)

    assert.equal(item.title, 'Absent')
    assert.match(item.rule, /No attendance was recorded/)
    const rateRow = item.calculation.find(c => c.label.startsWith('Daily rate'))
    assert.ok(rateRow, 'the daily rate is named and shown')
    assert.equal(rateRow.value, money(SALARY / 26))
    assert.equal(deductionRow(item).value, money(SALARY / 26))
  })

  test('half day: half the daily rate, named as such', () => {
    const r = run(month({ 21: rec(21, [10, 0], [15, 0]), 22: rec(22, [10, 0], [15, 0]), 23: rec(23, [10, 0], [15, 0]) }))
    const day = toDeductionDays(r.day_results).find(d => d.lines.some(l => l.deduction_type === 'half_day' && l.amount_deducted > 0))
    assert.ok(day)
    const item = explainDay(day.lines)[0]
    assert.equal(item.title, 'Half Day')
    assert.ok(item.calculation.some(c => c.label === 'Half of the daily rate'))
    assert.equal(deductionRow(item).value, money(SALARY / 26 / 2))
  })

  test('company-paid leave: the charge, then the allowance, then ₹0', () => {
    const r = run(month({ 21: null }))
    const day = dayOf(r, '2026-07-21')
    const [item] = explainDay(day.lines)

    assert.equal(item.title, 'Paid Leave · Company Paid')
    assert.equal(item.companyPaid, true)
    assert.match(item.rule, /first paid leave of the month — the earliest one by date — is covered by BOE/)

    // Three steps: what the rule charged, the allowance cancelling it, ₹0.
    const gross = item.calculation.find(c => c.label.startsWith('× 1 day'))
    const waive = item.calculation.find(c => c.label === 'Company-paid allowance')
    assert.ok(gross && waive)
    assert.equal(gross.value, money(SALARY / 26))
    assert.equal(waive.value, `− ${money(SALARY / 26)}`)
    assert.equal(deductionRow(item).value, money(0))
    assert.equal(item.amount, 0)
    assert.equal(item.grossAmount, SALARY / 26)
  })

  test('a covered late arrival is titled for the rule that covered it', () => {
    // Three 1h late days = 3h, absorbed by the month's leave.
    const r = run(month({ 15: rec(15, [10, 45], [18, 30]), 16: rec(16, [10, 45], [18, 30]), 17: rec(17, [10, 45], [18, 30]) }))
    const day = dayOf(r, '2026-07-15')
    const [item] = explainDay(day.lines)
    assert.equal(item.companyPaid, true)
    assert.equal(deductionTitle(day.lines[0]), 'Paid Leave · Company Paid')
    // The underlying rule is still explained — the employee learns they were late.
    assert.match(item.rule, /45 min past 10:00 AM/)
    assert.equal(item.amount, 0)
  })

  test('a corrected date explains the corrected punches, not the machine’s', () => {
    const correction: AttendanceDayCorrection = {
      attendance_date: '2026-07-15',
      corrected_check_in_at:  at(15, 11, 0),
      corrected_check_out_at: at(15, 18, 30),
      day_treatment: 'auto',
      waive_late_arrival: false,
      waive_early_checkout: false,
      waive_missing_punch: false,
    }
    // Machine said 10:45; the admin restated it as 11:00.
    const r = run(month({ 15: rec(15, [10, 45], [18, 30]), 21: null }), [correction])
    const day = dayOf(r, '2026-07-15')
    const [item] = explainDay(day.lines)
    assert.match(item.rule, /1h past 10:00 AM/, 'the rule reflects the corrected 11:00 punch')
  })

  test('a waived deduction produces no line at all, so there is nothing to explain', () => {
    const correction: AttendanceDayCorrection = {
      attendance_date: '2026-07-15',
      corrected_check_in_at:  at(15, 10, 45),
      corrected_check_out_at: at(15, 18, 30),
      day_treatment: 'auto',
      waive_late_arrival: true,
      waive_early_checkout: false,
      waive_missing_punch: false,
    }
    const r = run(month({ 15: rec(15, [10, 45], [18, 30]) }), [correction])
    assert.equal(toDeductionDays(r.day_results).find(d => d.date === '2026-07-15'), undefined)
  })

  test('a line with no engine metadata still states its amount', () => {
    const item = explainLine({ deduction_type: 'short_hours', hours_deducted: 1, amount_deducted: 100 })
    assert.equal(item.title, 'Short Hours')
    assert.equal(item.calculation.length, 1)
    assert.equal(deductionRow(item).value, money(100))
  })
})

// ─── Reconciliation ───────────────────────────────────────────────────────────

describe('every figure in the popup reconciles to the payroll result', () => {
  test('across a month of mixed reasons, the popups sum to total_deductions', () => {
    const r = run(month({
      2:  rec(2, [10, 45], [18, 30]),     // late
      3:  rec(3, [10, 0],  [17, 30]),     // early
      6:  rec(6, [10, 20], null),         // missing punch-out + late
      7:  rec(7, [10, 0],  [15, 0]),      // half day
      21: null,                            // absent
      22: null,                            // absent — one of these is covered
    }))

    const days = toDeductionDays(r.day_results)
    let popupTotal = 0
    for (const day of days) {
      const items = explainDay(day.lines)
      const dayTotal = items.reduce((s, i) => s + i.amount, 0)
      assert.ok(
        Math.abs(dayTotal - day.total_amount) < 0.005,
        `${day.date}: popup ${dayTotal} vs row ${day.total_amount}`,
      )
      assert.equal(dayDeductionTotal(day.lines), day.total_amount)
      popupTotal += dayTotal
    }

    assert.ok(
      Math.abs(popupTotal - r.total_deductions) < 0.005,
      `popups ${popupTotal} vs engine ${r.total_deductions}`,
    )
    assert.ok(days.some(d => d.total_amount === 0), 'the covered day is one of the rows')
  })

  test('gross × waiver arithmetic holds on every line the engine produced', () => {
    const r = run(month({ 2: rec(2, [10, 45], [18, 30]), 21: null, 22: null }))
    for (const day of toDeductionDays(r.day_results)) {
      for (const line of day.lines) {
        const e = line.explain
        assert.ok(e, `${day.date}/${line.deduction_type} carries its metadata`)
        assert.ok(Math.abs(e.units * e.rate - e.gross_amount) < 0.005, 'units × rate = gross')
        const expected = line.waived_by === 'paid_leave' ? 0 : e.gross_amount
        assert.ok(Math.abs(line.amount_deducted - expected) < 0.005, 'amount follows the waiver')
      }
    }
  })
})
