/**
 * A half paid leave covers half of the earliest absent day.
 *
 * 11–15 days present earns 0.5 leave. A whole absent day needs a whole leave, so
 * before this rule a half leave could not touch an absence and was spent on late
 * lines worth less (October 2026: three late lines, ₹407, while every absent day
 * was charged in full). Now, when no half day takes the leave first, the earliest
 * absent day is charged half and the company pays the other half.
 *
 * Run:
 *   npx tsx --test src/lib/payroll/engine.halfLeaveAbsentDay.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { generatePayrollForEmployee } from './engine'
import { isSkip } from './types'
import type { EngineEmployee, EnginePeriod, EngineAttendanceRecord, EngineResult } from './types'
import { explainLine } from './deductionExplanation'
import { toDeductionDays } from './resultTabs'
import { DEFAULT_PAYROLL_SETTINGS } from './settings'

// ─── July 2026, ₹26,000 → ₹1,000 a day (27 working days, Sundays 5/12/19/26) ──

const SALARY = 26_000
const employee: EngineEmployee = {
  id: 'emp-1', monthly_salary: SALARY, payroll_active: true, joining_date: null, employment_type: 'permanent',
}
const period: EnginePeriod = { id: 'period-1', payroll_month: 7, payroll_year: 2026, status: 'draft' }

const WORKING_DAYS = [
  1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18,
  20, 21, 22, 23, 24, 25, 27, 28, 29, 30, 31,
]

const iso = (d: number) => `2026-07-${String(d).padStart(2, '0')}`
const at = (d: number, hh: number, mm: number) => new Date(Date.UTC(2026, 6, d, hh, mm - 330)).toISOString()

const fullDay = (d: number): EngineAttendanceRecord =>
  ({ id: `r-${d}`, attendance_date: iso(d), check_in_at: at(d, 10, 0), check_out_at: at(d, 18, 30) })
const halfDay = (d: number): EngineAttendanceRecord =>
  ({ id: `r-${d}`, attendance_date: iso(d), check_in_at: at(d, 10, 0), check_out_at: at(d, 15, 0) })
/** In at 10:45 — 45 minutes past 10:00, which rounds up to 1 h. */
const lateDay = (d: number): EngineAttendanceRecord =>
  ({ id: `r-${d}`, attendance_date: iso(d), check_in_at: at(d, 10, 45), check_out_at: at(d, 18, 30) })

function run(records: EngineAttendanceRecord[]): EngineResult {
  const out = generatePayrollForEmployee(employee, period, records, [], [])
  assert.ok(!isSkip(out), 'engine skipped')
  return out as EngineResult
}

/** `n` full days from the start of the month, then the extras; everything else is absent. */
function presentFirst(n: number, extra: EngineAttendanceRecord[] = []): EngineAttendanceRecord[] {
  return [...WORKING_DAYS.slice(0, n).map(fullDay), ...extra]
}

const lineFor = (r: EngineResult, date: string, type: string) =>
  r.deduction_lines.find(l => l.line_date === date && l.deduction_type === type)

describe('a half leave takes half off the earliest absent day', () => {
  test('12 present, 15 absent: the 13th working day is charged half, the rest in full', () => {
    const r = run(presentFirst(12))
    assert.equal(r.paid_leave_available, 0.5)
    assert.equal(r.paid_leave_used, 0.5)
    assert.equal(r.days_absent, 15)

    const earliest = lineFor(r, iso(WORKING_DAYS[12]), 'absent')!
    assert.equal(earliest.amount_deducted, 500)
    assert.equal(earliest.waived_by, 'paid_leave')
    assert.equal(earliest.explain!.gross_amount, 1000, 'the popup keeps what the rule charged')

    const others = r.deduction_lines.filter(l => l.deduction_type === 'absent' && l !== earliest)
    assert.equal(others.length, 14)
    for (const l of others) {
      assert.equal(l.amount_deducted, 1000)
      assert.equal(l.waived_by, undefined)
    }
    assert.equal(r.total_deductions, 500 + 14 * 1000)
    assert.equal(r.net_salary, SALARY - (500 + 14 * 1000))
  })

  test('the saving beats the late lines it used to go to, which are charged again', () => {
    // 11 full days + 1 late day (₹118 for 1 h) and 15 absent days.
    const r = run(presentFirst(11, [lateDay(WORKING_DAYS[11])]))
    assert.equal(r.paid_leave_used, 0.5)
    assert.equal(r.leave_absorbed_deductions, false, 'the late line is no longer the thing waived')

    const late = lineFor(r, iso(WORKING_DAYS[11]), 'late_arrival')!
    assert.equal(late.amount_deducted, 118)
    assert.equal(late.waived_by, undefined)
    assert.equal(lineFor(r, iso(WORKING_DAYS[12]), 'absent')!.amount_deducted, 500)
    assert.equal(r.total_deductions, 118 + 500 + 14 * 1000)
  })

  test('only the earliest absent day is touched, whatever order the days arrive in', () => {
    const records = presentFirst(12).reverse()
    const r = run(records)
    const absentDates = r.deduction_lines.filter(l => l.deduction_type === 'absent').map(l => l.line_date).sort()
    assert.equal(lineFor(r, absentDates[0], 'absent')!.amount_deducted, 500)
    assert.equal(lineFor(r, absentDates[1], 'absent')!.amount_deducted, 1000)
  })

  test('every total is still a whole-rupee sum of the printed lines', () => {
    const r = run(presentFirst(13))
    const sum = r.deduction_lines.reduce((t, l) => t + l.amount_deducted, 0)
    assert.equal(r.total_deductions, sum)
    assert.ok(Number.isInteger(sum))
  })
})

describe('what the half leave does NOT change', () => {
  test('a half day still takes the half leave first, and is fully covered', () => {
    const r = run(presentFirst(11, [halfDay(WORKING_DAYS[11])]))
    assert.equal(r.paid_leave_available, 0.5)
    assert.equal(r.paid_leave_used, 0.5)
    const half = lineFor(r, iso(WORKING_DAYS[11]), 'half_day')!
    assert.equal(half.amount_deducted, 0)
    assert.equal(half.waived_by, 'paid_leave')
    // The absences are all charged in full: the leave was already spent.
    for (const l of r.deduction_lines.filter(x => x.deduction_type === 'absent')) {
      assert.equal(l.amount_deducted, 1000)
      assert.equal(l.waived_by, undefined)
    }
  })

  test('a full leave still covers a whole absent day, not half of it', () => {
    const r = run(presentFirst(16))
    assert.equal(r.paid_leave_available, 1)
    assert.equal(r.paid_leave_used, 1)
    const earliest = r.deduction_lines.filter(l => l.deduction_type === 'absent')
      .sort((a, b) => (a.line_date < b.line_date ? -1 : 1))[0]
    assert.equal(earliest.amount_deducted, 0)
    assert.equal(earliest.waived_by, 'paid_leave')
  })

  test('with no leave earned (10 present) nothing is covered', () => {
    const r = run(presentFirst(10))
    assert.equal(r.paid_leave_available, 0)
    assert.equal(r.total_deductions, 17 * 1000)
    assert.ok(r.deduction_lines.every(l => l.waived_by === undefined))
  })

  test('every full month present has no absent day for the half leave to take', () => {
    const r = run(WORKING_DAYS.map(fullDay))
    assert.equal(r.total_deductions, 0)
    assert.equal(r.paid_leave_used, 0)
  })
})

describe('how the half-covered day reads on the payslip', () => {
  test('it keeps its name, says half was covered, and the workings add up', () => {
    const r = run(presentFirst(12))
    const day = toDeductionDays(r.day_results).find(d => d.date === iso(WORKING_DAYS[12]))!
    assert.equal(day.total_amount, 500)
    assert.equal(day.lines.length, 1, 'the date stays on the Deductions tab')

    const item = explainLine(day.lines[0])
    assert.equal(item.title, 'Absent')
    assert.equal(item.partlyCovered, true)
    assert.equal(item.companyPaid, false, 'the charge was not cancelled')
    assert.equal(item.amount, 500)
    assert.equal(item.grossAmount, 1000)
    assert.equal(item.coverageNote, 'Half covered by company paid leave')

    const row = (label: string) => item.calculation.find(c => c.label === label)!
    assert.match(row('Company-paid allowance').value, /− ₹500\.00/)
    assert.match(row('Deduction').value, /₹500\.00/)
  })

  test('a fully covered day is unchanged: company paid, ₹0, the whole gross subtracted', () => {
    const r = run(presentFirst(16))
    const line = r.deduction_lines.find(l => l.waived_by === 'paid_leave')!
    const item = explainLine(line)
    assert.equal(item.companyPaid, true)
    assert.equal(item.partlyCovered, false)
    assert.equal(item.title, 'Paid Leave · Company Paid')
    assert.match(item.calculation.find(c => c.label === 'Company-paid allowance')!.value, /− ₹1,000\.00/)
  })
})

describe('BOE Credits do not stack on the half-covered day', () => {
  test('a redemption on that date is not applied and the line stays paid-leave covered', () => {
    const earliest = iso(WORKING_DAYS[12])
    const out = generatePayrollForEmployee(
      employee, period, presentFirst(12), [], [], [], DEFAULT_PAYROLL_SETTINGS,
      [{ attendance_date: earliest, deduction_type: 'absent', credits: 15 }],
    )
    assert.ok(!isSkip(out))
    const line = (out as EngineResult).deduction_lines.find(l => l.line_date === earliest && l.deduction_type === 'absent')!
    assert.equal(line.waived_by, 'paid_leave')
    assert.equal(line.amount_deducted, 500)
  })
})

// ─── One employee, October 2026 — the case that started this ─────────────────
// The machine file's eleven punch days, a ₹36,000 salary, no company holidays.
// Before this rule the three late lines (2, 23, 26 Oct) were waived and all 16
// absent days charged ₹1,385: deductions ₹22,160, net ₹13,840.

describe('October 2026, an employee on ₹36,000 with 11 days present', () => {
  const PUNCHES: Record<number, [string, string]> = {
    1: ['10:09', '18:34'], 2: ['10:35', '18:46'], 3: ['10:13', '18:31'],
    19: ['10:05', '18:29'], 20: ['10:06', '18:32'], 21: ['10:06', '18:32'],
    22: ['10:04', '18:35'], 23: ['10:24', '18:27'], 24: ['10:03', '18:52'],
    26: ['10:31', '18:33'], 27: ['10:07', '18:33'],
  }
  const ist = (d: number, hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number)
    return new Date(Date.UTC(2026, 9, d, h, m - 330)).toISOString()
  }
  const records: EngineAttendanceRecord[] = Object.entries(PUNCHES).map(([d, [i, o]]) => ({
    id: `o-${d}`,
    attendance_date: `2026-10-${String(d).padStart(2, '0')}`,
    check_in_at: ist(Number(d), i),
    check_out_at: ist(Number(d), o),
  }))
  const oct: EnginePeriod = { id: 'oct', payroll_month: 10, payroll_year: 2026, status: 'draft' }
  const out = generatePayrollForEmployee({ ...employee, monthly_salary: 36_000 }, oct, records, [], [])
  assert.ok(!isSkip(out))
  const r = out as EngineResult

  test('11 present, 16 absent, a half leave earned and spent', () => {
    assert.equal(r.days_present, 11)
    assert.equal(r.days_absent, 16)
    assert.equal(r.paid_leave_available, 0.5)
    assert.equal(r.paid_leave_used, 0.5)
  })

  test('5 October, the earliest absence, is charged ₹692 instead of ₹1,385', () => {
    const l = lineFor(r, '2026-10-05', 'absent')!
    assert.equal(l.amount_deducted, 692)
    assert.equal(l.waived_by, 'paid_leave')
    assert.equal(l.explain!.gross_amount, 1385)
  })

  test('the three late lines are charged again: ₹163, ₹81, ₹163', () => {
    const late = r.deduction_lines.filter(l => l.deduction_type === 'late_arrival')
    assert.deepEqual(late.map(l => [l.line_date, l.amount_deducted]),
      [['2026-10-02', 163], ['2026-10-23', 81], ['2026-10-26', 163]])
    assert.ok(late.every(l => l.waived_by === undefined))
  })

  test('deductions ₹21,874 and salary after attendance ₹14,126 (was ₹22,160 / ₹13,840)', () => {
    assert.equal(r.total_deductions, 21_874)
    assert.equal(r.net_salary, 14_126)
  })
})
