/**
 * BOE Credits Phase 1C — a covered day costs nothing, and the truth of the day
 * is untouched.
 *
 * The engine takes the coverage layer (days the employee paid for with
 * credits) as its last argument and settles the matching absent or half-day
 * line at ₹0, marked `waived_by: 'boe_credits'` with the credits spent. What
 * it must NOT do is rewrite history: the classification, the day counts and
 * the raw punches stay exactly as they were, so the payslip shows the absence,
 * that credits covered it, and how many.
 *
 * Run:
 *   npx tsx --test src/lib/payroll/engine.creditRedemption.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { generatePayrollForEmployee } from './engine'
import { isSkip } from './types'
import type { EngineEmployee, EnginePeriod, EngineAttendanceRecord, EngineResult, AttendanceCreditRedemption } from './types'
import { DEFAULT_PAYROLL_SETTINGS } from './settings'
import { toDeductionDays, toConsideredDays, isCompanyPaidLine, isCreditCoveredLine } from './resultTabs'
import { explainLine } from './deductionExplanation'
import { ATTENDANCE_REDEMPTION_COST } from '../boeCredits/attendanceRedemption'
import { PER_DAY_DIVISOR } from './rules'

// ─── Fixtures (the companyPaidLeave suite's month, so the figures are known) ──

const SALARY  = 26_000
const PER_DAY = SALARY / PER_DAY_DIVISOR   // ₹1,000
const HALF    = PER_DAY / 2                // ₹500

const employee: EngineEmployee = {
  id: 'emp-1', monthly_salary: SALARY, payroll_active: true, joining_date: null, employment_type: 'permanent',
}
const period: EnginePeriod = { id: 'period-1', payroll_month: 7, payroll_year: 2026, status: 'draft' }

const JULY_WORKING_DAYS = [
  1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18,
  20, 21, 22, 23, 24, 25, 27, 28, 29, 30, 31,
]
const iso = (d: number) => `2026-07-${String(d).padStart(2, '0')}`
const at  = (d: number, hh: number, mm: number) => new Date(Date.UTC(2026, 6, d, hh, mm - 330)).toISOString()

const fullDay = (d: number): EngineAttendanceRecord =>
  ({ id: `r-${d}`, attendance_date: iso(d), check_in_at: at(d, 10, 0), check_out_at: at(d, 18, 30) })
const halfDay = (d: number): EngineAttendanceRecord =>
  ({ id: `r-${d}`, attendance_date: iso(d), check_in_at: at(d, 10, 0), check_out_at: at(d, 15, 0) })
const lateDay = (d: number): EngineAttendanceRecord =>
  ({ id: `r-${d}`, attendance_date: iso(d), check_in_at: at(d, 10, 45), check_out_at: at(d, 18, 30) })

/** null = no punches at all → absent. */
function month(exceptions: Record<number, EngineAttendanceRecord | null>): EngineAttendanceRecord[] {
  const out: EngineAttendanceRecord[] = []
  for (const d of JULY_WORKING_DAYS) {
    if (d in exceptions) { const rec = exceptions[d]; if (rec) out.push(rec); continue }
    out.push(fullDay(d))
  }
  return out
}

function run(records: EngineAttendanceRecord[], redemptions: AttendanceCreditRedemption[] = []): EngineResult {
  const o = generatePayrollForEmployee(employee, period, records, [], [], [], DEFAULT_PAYROLL_SETTINGS, redemptions)
  assert.ok(!isSkip(o), `engine skipped: ${isSkip(o) ? o.reason : ''}`)
  return o as EngineResult
}

const linesOn = (r: EngineResult, date: string) => r.deduction_lines.filter(l => l.line_date === date)
const dayOf   = (r: EngineResult, date: string) => r.day_results.find(d => d.date === date)!

// Two absences: 21 July is the company-paid one (earliest), 22 July is charged.
const TWO_ABSENCES = month({ 21: null, 22: null })
// One absorbed absence and one chargeable half day.
const ABSENCE_AND_HALF = month({ 21: null, 23: halfDay(23) })

const cover = (date: string, deduction_type: 'absent' | 'half_day'): AttendanceCreditRedemption =>
  ({ attendance_date: date, deduction_type, credits: ATTENDANCE_REDEMPTION_COST[deduction_type] })

// ─── Coverage ─────────────────────────────────────────────────────────────────

describe('a covered absent day', () => {
  const before = run(TWO_ABSENCES)
  const after  = run(TWO_ABSENCES, [cover('2026-07-22', 'absent')])

  test('was charged a full day before, and ₹0 after, with the credits on the line', () => {
    assert.equal(linesOn(before, '2026-07-22')[0].amount_deducted, PER_DAY)
    const line = linesOn(after, '2026-07-22')[0]
    assert.equal(line.deduction_type, 'absent')
    assert.equal(line.amount_deducted, 0)
    assert.equal(line.waived_by, 'boe_credits')
    assert.equal(line.credits_redeemed, 2)
    assert.equal(line.explain!.gross_amount, PER_DAY, 'what it would have cost survives for the popup')
    assert.ok(isCreditCoveredLine(line))
    assert.ok(!isCompanyPaidLine(line))
  })

  test('the month\'s totals drop by exactly that day, once', () => {
    assert.equal(before.total_deductions, PER_DAY)
    assert.equal(after.total_deductions, 0)
    assert.equal(after.net_salary, SALARY)
    assert.equal(after.deduction_lines.filter(l => l.line_date === '2026-07-22').length, 1)
  })

  test('the original attendance outcome is intact: classification, counts, punches', () => {
    for (const r of [before, after]) {
      assert.equal(dayOf(r, '2026-07-22').classification, 'full_absent')
      assert.equal(dayOf(r, '2026-07-22').check_in_at, null)
      assert.equal(dayOf(r, '2026-07-22').raw_check_in_at, null)
      assert.equal(r.days_absent, 2)
      assert.equal(r.days_present, before.days_present)
      assert.equal(r.half_day_count, 0)
    }
    assert.equal(after.paid_leave_used, before.paid_leave_used, 'the company-paid day is still the company-paid day')
    assert.ok(isCompanyPaidLine(linesOn(after, '2026-07-21')[0]))
  })

  test('the covered day stays on the Deductions tab, and Days Considered does not gain it', () => {
    const days = toDeductionDays(after.day_results)
    const july22 = days.find(d => d.date === '2026-07-22')
    assert.ok(july22, 'a ₹0 covered day must not vanish from the ledger')
    assert.equal(july22.total_amount, 0)
    assert.equal(july22.lines[0].credits_redeemed, 2)
    assert.equal(toConsideredDays(after.day_results).some(d => d.date === '2026-07-22'), false)
  })

  test('the explanation names the credits and the ₹0', () => {
    const item = explainLine(linesOn(after, '2026-07-22')[0])
    assert.equal(item.creditCovered, true)
    assert.equal(item.companyPaid, false)
    assert.equal(item.coverageNote, 'Covered with 2 BOE Credits')
    assert.equal(item.amount, 0)
    assert.equal(item.grossAmount, PER_DAY)
    assert.ok(item.calculation.some(row => row.label === 'BOE Credits (2 credits)'))
    assert.match(item.rule, /2 credits from the employee's BOE Credits/)
  })
})

describe('a covered half day', () => {
  const after = run(ABSENCE_AND_HALF, [cover('2026-07-23', 'half_day')])

  test('costs 1 credit and ₹0, and is still a half day', () => {
    const line = linesOn(after, '2026-07-23')[0]
    assert.equal(line.deduction_type, 'half_day')
    assert.equal(line.amount_deducted, 0)
    assert.equal(line.waived_by, 'boe_credits')
    assert.equal(line.credits_redeemed, 1)
    assert.equal(line.explain!.gross_amount, HALF)
    assert.equal(dayOf(after, '2026-07-23').classification, 'half_day')
    assert.equal(after.half_day_count, 1)
    assert.equal(after.total_deductions, 0)
    assert.equal(explainLine(line).coverageNote, 'Covered with 1 BOE Credit')
  })
})

// ─── What coverage does NOT do ────────────────────────────────────────────────

describe('coverage never reaches a day that costs nothing or is not a day deduction', () => {
  test('paid leave keeps precedence: a redemption on the company-paid day changes nothing', () => {
    const r = run(TWO_ABSENCES, [cover('2026-07-21', 'absent')])
    const july21 = linesOn(r, '2026-07-21')[0]
    assert.equal(july21.waived_by, 'paid_leave')
    assert.equal(july21.credits_redeemed, undefined)
    assert.equal(r.total_deductions, PER_DAY, '22 July is still charged')
  })

  test('a late mark is not covered: the hourly line stays', () => {
    const records = month({ 21: null, 24: lateDay(24) })
    const plain = run(records)
    const r = run(records, [cover('2026-07-24', 'absent')])
    assert.deepEqual(linesOn(r, '2026-07-24'), linesOn(plain, '2026-07-24'))
    assert.equal(linesOn(r, '2026-07-24')[0].deduction_type, 'late_arrival')
    assert.equal(r.total_deductions, plain.total_deductions)
  })

  test('a redemption on a full present day changes nothing', () => {
    const r = run(TWO_ABSENCES, [cover('2026-07-10', 'absent')])
    assert.equal(linesOn(r, '2026-07-10').length, 0)
    assert.equal(r.total_deductions, PER_DAY)
  })

  test('an absent-day redemption still covers a day that became a half day; a half-day one does not stretch to an absence', () => {
    const halfNow = run(ABSENCE_AND_HALF, [cover('2026-07-23', 'absent')])
    assert.equal(linesOn(halfNow, '2026-07-23')[0].waived_by, 'boe_credits')
    assert.equal(linesOn(halfNow, '2026-07-23')[0].credits_redeemed, 2, 'the credits actually spent are what the line records')

    const absentNow = run(TWO_ABSENCES, [cover('2026-07-22', 'half_day')])
    assert.equal(linesOn(absentNow, '2026-07-22')[0].waived_by, undefined)
    assert.equal(absentNow.total_deductions, PER_DAY)
  })
})

// ─── Regeneration ─────────────────────────────────────────────────────────────

describe('regeneration carries the coverage exactly once', () => {
  const coverage = [cover('2026-07-22', 'absent')]

  test('three runs give one covered 22 July line and the same total each time', () => {
    for (let i = 0; i < 3; i++) {
      const r = run(TWO_ABSENCES, coverage)
      const lines = linesOn(r, '2026-07-22')
      assert.equal(lines.length, 1, `run ${i + 1}`)
      assert.equal(lines[0].waived_by, 'boe_credits')
      assert.equal(r.deduction_lines.filter(l => l.waived_by === 'boe_credits').length, 1)
      assert.equal(r.total_deductions, 0)
    }
  })

  test('a result generated BEFORE the redemption reads as stale, and regenerating clears it', () => {
    // The staleness rule exactly as buildDayView applies it: stored total vs a
    // live run over the same inputs plus the coverage.
    const sameMoney = (a: number, b: number) => Math.abs(a - b) < 0.005
    const stored = run(TWO_ABSENCES)
    const live   = run(TWO_ABSENCES, coverage)
    assert.equal(sameMoney(stored.total_deductions, live.total_deductions), false, 'stale until regenerated')

    const regenerated = run(TWO_ABSENCES, coverage)
    assert.equal(sameMoney(regenerated.total_deductions, live.total_deductions), true, 'no longer stale')
  })

  test('with two covered days, each is covered once and the counts still say what happened', () => {
    const r = run(month({ 21: null, 22: null, 23: halfDay(23) }), [cover('2026-07-22', 'absent'), cover('2026-07-23', 'half_day')])
    assert.equal(r.deduction_lines.filter(l => l.waived_by === 'boe_credits').length, 2)
    assert.equal(r.total_deductions, 0)
    assert.equal(r.days_absent, 2)
    assert.equal(r.half_day_count, 1)
  })
})
