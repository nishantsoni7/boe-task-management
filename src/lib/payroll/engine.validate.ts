/**
 * Payroll Engine — Validation Scenarios (V1)
 * 15 scenarios covering the full engine spec (docs/PAYROLL_RULES_V1.md).
 *
 * Run:   npx tsx src/lib/payroll/engine.validate.ts
 */

import { generatePayrollForEmployee } from './engine'
import { isSkip } from './types'
import type {
  EngineEmployee,
  EnginePeriod,
  EngineAttendanceRecord,
  EngineHoliday,
  EnginePendingAdjustment,
  EngineResult,
} from './types'

// ─── Constants ────────────────────────────────────────────────────────────────

const SALARY = 30_000
const PDR    = SALARY / 30        // per_day_rate  = 1 000.000
const PHR    = PDR / 8.5          // per_hour_rate ≈   117.647

// ─── Shared period ────────────────────────────────────────────────────────────

const PERIOD: EnginePeriod = {
  id: 'p1',
  payroll_month: 6,
  payroll_year: 2026,
  status: 'draft',
}

// ─── Builder helpers ──────────────────────────────────────────────────────────

function emp(overrides: Partial<EngineEmployee> = {}): EngineEmployee {
  return {
    id: 'e1',
    monthly_salary: SALARY,
    payroll_active: true,
    joining_date: null,
    employment_type: 'permanent',
    ...overrides,
  }
}

/**
 * June 2026 non-Sunday working days, minus any explicit excludeDates.
 * Sundays: 7, 14, 21, 28  →  full-month count = 26.
 */
function juneWorkDays(excludeDates: string[] = []): string[] {
  const skip = new Set(excludeDates)
  const out: string[] = []
  for (let d = 1; d <= 30; d++) {
    const date = `2026-06-${String(d).padStart(2, '0')}`
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
    if (dow !== 0 && !skip.has(date)) out.push(date)
  }
  return out
}

// Attendance record factories
// Full present: 9:00–18:30 IST = 03:30–13:00 UTC → 9.5 raw − 1 lunch = 8.5 h effective
function recFull(date: string, i: number): EngineAttendanceRecord {
  return { id: `r${i}`, attendance_date: date, check_in_at: `${date}T03:30:00Z`, check_out_at: `${date}T13:00:00Z` }
}
// Half-day: 9:00–13:00 IST = 03:30–07:30 UTC → 4 h raw, outMin=780 NOT > 780 → no lunch → 4 h effective
function recHalf(date: string, i: number): EngineAttendanceRecord {
  return { id: `r${i}`, attendance_date: date, check_in_at: `${date}T03:30:00Z`, check_out_at: `${date}T07:30:00Z` }
}
// Missing punch-in: check_in absent → missing_punch classification, 2 h deduction
function recMissingIn(date: string, i: number): EngineAttendanceRecord {
  return { id: `r${i}`, attendance_date: date, check_in_at: null, check_out_at: `${date}T13:00:00Z` }
}
// Missing punch-out: check_out absent → missing_punch classification, 2 h deduction
function recMissingOut(date: string, i: number): EngineAttendanceRecord {
  return { id: `r${i}`, attendance_date: date, check_in_at: `${date}T03:30:00Z`, check_out_at: null }
}

// ─── Assertion framework ──────────────────────────────────────────────────────

let pass = 0
let fail = 0
const failures: string[] = []

function near(a: number, b: number, tol = 0.001) { return Math.abs(a - b) <= tol }

function chk(label: string, actual: unknown, expected: unknown) {
  const ok = typeof actual === 'number' && typeof expected === 'number'
    ? near(actual, expected)
    : actual === expected
  if (ok) { pass++ } else {
    fail++
    const msg = `  ✗  ${label}\n       expected ${JSON.stringify(expected)}  got ${JSON.stringify(actual)}`
    failures.push(msg)
    console.error(msg)
  }
}

function resultOf(outcome: ReturnType<typeof generatePayrollForEmployee>): EngineResult {
  if (isSkip(outcome)) throw new Error(`Unexpected skip: ${outcome.reason}`)
  return outcome
}

function scenario(name: string, fn: () => void) {
  const before = fail
  try { fn() } catch (e) { fail++; console.error(`  ✗  ${name} — threw: ${e}`) }
  const status = fail === before ? '✓ PASS' : '✗ FAIL'
  console.log(`  ${status}  ${name}`)
}

// ─── Validation scenarios ─────────────────────────────────────────────────────

console.log('\nPayroll Engine Validation — June 2026')
console.log('══════════════════════════════════════════════════════════════\n')

// ─────────────────────────────────────────────────────────────────────────────
// S01  Perfect attendance — full month, no deductions, no adjustments
//
// Inputs:  26 working days, all full-present (9:00–18:30 IST)
// Expect:  0 deductions, gross = net = 30 000
// ─────────────────────────────────────────────────────────────────────────────
scenario('S01  Perfect attendance — no deductions, no adjustments', () => {
  const days = juneWorkDays()
  const r = resultOf(generatePayrollForEmployee(emp(), PERIOD, days.map(recFull), [], []))

  chk('working_days_in_month',  r.working_days_in_month,  26)
  chk('days_present',           r.days_present,           26)
  chk('days_absent',            r.days_absent,             0)
  chk('paid_leave_available',   r.paid_leave_available,    1)
  chk('paid_leave_used',        r.paid_leave_used,         0)
  chk('total_deductions',       r.total_deductions,        0)
  chk('gross_salary',           r.gross_salary,       30_000)
  chk('net_salary',             r.net_salary,         30_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// S02  One absent day — absorbed by 1 paid leave
//
// Inputs:  25 full-present + Jun 30 absent (no record)
// Leave:   stage-1 absorbs 1 absent → paid_leave_used = 1
// Expect:  0 deductions, gross = net = 30 000
// ─────────────────────────────────────────────────────────────────────────────
scenario('S02  One absent day — absorbed by paid leave', () => {
  const days = juneWorkDays()
  const records = days.filter(d => d !== '2026-06-30').map(recFull)
  const r = resultOf(generatePayrollForEmployee(emp(), PERIOD, records, [], []))

  chk('days_present',          r.days_present,          25)
  chk('days_absent',           r.days_absent,            1)
  chk('paid_leave_available',  r.paid_leave_available,   1)
  chk('paid_leave_used',       r.paid_leave_used,        1)
  chk('total_deductions',      r.total_deductions,       0)
  chk('gross_salary',          r.gross_salary,       30_000)
  chk('net_salary',            r.net_salary,         30_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// S03  Two half-days — absorbed by one paid leave (stage 2)
//
// Inputs:  24 full-present + Jun 29 half-day + Jun 30 half-day
// Leave:   stage-2 absorbs 2 half-days → paid_leave_used = 1
// Expect:  0 deductions, gross = net = 30 000
// ─────────────────────────────────────────────────────────────────────────────
scenario('S03  Two half-days — absorbed by one paid leave (stage 2)', () => {
  const days = juneWorkDays()
  const records = days.map((d, i) => {
    if (d === '2026-06-29' || d === '2026-06-30') return recHalf(d, i)
    return recFull(d, i)
  })
  const r = resultOf(generatePayrollForEmployee(emp(), PERIOD, records, [], []))

  chk('half_day_count',        r.half_day_count,         2)
  chk('paid_leave_used',       r.paid_leave_used,         1)
  chk('total_deductions',      r.total_deductions,        0)
  chk('gross_salary',          r.gross_salary,       30_000)
  chk('net_salary',            r.net_salary,         30_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// S04  One half-day — absorbed by 0.5 paid leave (stage 2b, mid-month joiner)
//
// Joining: Jun 16  →  13 in-scope days  →  ratio 13/26 = 0.50  →  leave = 0.5
// Inputs:  12 full-present + Jun 30 half-day
// Leave:   stage-2b absorbs 1 half-day with 0.5 leave → paid_leave_used = 0.5
// Expect:  0 deductions, gross = net = 30 000
// ─────────────────────────────────────────────────────────────────────────────
scenario('S04  One half-day — absorbed by 0.5 paid leave (joining Jun 16)', () => {
  const e    = emp({ joining_date: '2026-06-16' })
  // 13 in-scope working days: 16,17,18,19,20,22,23,24,25,26,27,29,30
  const days = juneWorkDays().filter(d => d >= '2026-06-16')
  const records = days.map((d, i) =>
    d === '2026-06-30' ? recHalf(d, i) : recFull(d, i)
  )
  const r = resultOf(generatePayrollForEmployee(e, PERIOD, records, [], []))

  chk('working_days_in_month', r.working_days_in_month,  13)
  chk('paid_leave_available',  r.paid_leave_available,   0.5)
  chk('paid_leave_used',       r.paid_leave_used,        0.5)
  chk('half_day_count',        r.half_day_count,          1)
  chk('total_deductions',      r.total_deductions,        0)
  chk('gross_salary',          r.gross_salary,       30_000)
  chk('net_salary',            r.net_salary,         30_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// S05  Missing punch-out — absorbed by unused paid leave (stage 3)
//
// Inputs:  25 full-present + Jun 30 missing punch-out
// Leave:   no absent, no half-days → stage-3: 2 h ≤ threshold (1 × 8.5 h) → absorbed
//          leave_absorbed_deductions = true, paid_leave_used = 1
// Expect:  0 deductions, deduction line amount zeroed, gross = net = 30 000
// ─────────────────────────────────────────────────────────────────────────────
scenario('S05  Missing punch-out — absorbed by unused paid leave (stage 3)', () => {
  const days = juneWorkDays()
  const records = days.map((d, i) =>
    d === '2026-06-30' ? recMissingOut(d, i) : recFull(d, i)
  )
  const r = resultOf(generatePayrollForEmployee(emp(), PERIOD, records, [], []))

  chk('missing_punch_hours',        r.missing_punch_hours,        2)
  chk('leave_absorbed_deductions',  r.leave_absorbed_deductions,  true)
  chk('paid_leave_used',            r.paid_leave_used,            1)
  chk('total_deductions',           r.total_deductions,           0)
  chk('gross_salary',               r.gross_salary,          30_000)
  chk('net_salary',                 r.net_salary,            30_000)
  // Engine zeroes the line amount when leave absorbs hourly deductions
  const line = r.deduction_lines[0]
  chk('deduction_lines.length',     r.deduction_lines.length,     1)
  chk('line.amount_deducted = 0',   line?.amount_deducted,        0)
})

// ─────────────────────────────────────────────────────────────────────────────
// S06  Missing punch-in — deduction charged (leave = 0)
//
// Joining: Jun 25  →  5 in-scope days  →  ratio 5/26 ≈ 0.19  →  leave = 0
// Inputs:  4 full-present + Jun 30 missing punch-in (no check_in)
// Deduct:  2 h × PHR  ≈  235.294
// Expect:  gross ≈ 29 764.706, net ≈ 29 764.706
// ─────────────────────────────────────────────────────────────────────────────
scenario('S06  Missing punch-in — deduction charged (leave = 0, joining Jun 25)', () => {
  const e    = emp({ joining_date: '2026-06-25' })
  // 5 in-scope working days: 25, 26, 27, 29, 30
  const days = juneWorkDays().filter(d => d >= '2026-06-25')
  const records = days.map((d, i) =>
    d === '2026-06-30' ? recMissingIn(d, i) : recFull(d, i)
  )
  const r = resultOf(generatePayrollForEmployee(e, PERIOD, records, [], []))

  const deduction = 2 * PHR              // 2000 / 8.5  ≈ 235.294
  const net       = SALARY - deduction   //             ≈ 29 764.706

  chk('working_days_in_month',      r.working_days_in_month,      5)
  chk('paid_leave_available',       r.paid_leave_available,       0)
  chk('missing_punch_hours',        r.missing_punch_hours,        2)
  chk('leave_absorbed_deductions',  r.leave_absorbed_deductions,  false)
  chk('total_deductions',           r.total_deductions,           deduction)
  chk('gross_salary',               r.gross_salary,               SALARY)
  chk('net_salary',                 r.net_salary,                 net)
  const line = r.deduction_lines[0]
  chk('line.deduction_type',        line?.deduction_type,   'missing_punch_in')
  chk('line.hours_deducted',        line?.hours_deducted,   2)
  chk('line.amount_deducted',       line?.amount_deducted,  deduction)
})

// ─────────────────────────────────────────────────────────────────────────────
// S07  Missing punch-out — deduction charged (leave = 0)
//
// Same setup as S06 but check_out is null on Jun 30.
// Deduct:  2 h × PHR  ≈  235.294  (same monetary result, different type)
// ─────────────────────────────────────────────────────────────────────────────
scenario('S07  Missing punch-out — deduction charged (leave = 0, joining Jun 25)', () => {
  const e    = emp({ joining_date: '2026-06-25' })
  const days = juneWorkDays().filter(d => d >= '2026-06-25')
  const records = days.map((d, i) =>
    d === '2026-06-30' ? recMissingOut(d, i) : recFull(d, i)
  )
  const r = resultOf(generatePayrollForEmployee(e, PERIOD, records, [], []))

  const deduction = 2 * PHR
  const net       = SALARY - deduction

  chk('total_deductions',  r.total_deductions,  deduction)
  chk('gross_salary',      r.gross_salary,      SALARY)
  chk('net_salary',        r.net_salary,        net)
  const line = r.deduction_lines[0]
  chk('line.deduction_type',  line?.deduction_type,  'missing_punch_out')
  chk('line.hours_deducted',  line?.hours_deducted,  2)
})

// ─────────────────────────────────────────────────────────────────────────────
// S08  Missing punch isolation — late check-in present, only 2 h deducted
//
// Rule: missing punch is the SOLE deduction source for that day.
//       Even a late check-in (10:30 IST) does NOT generate a late_arrival line.
// Inputs:  Jun 30: check_in = 10:30 IST (late), check_out = null → missing_punch_out
// Expect:  exactly 1 deduction line, type = missing_punch_out, hours = 2, no late_arrival
// ─────────────────────────────────────────────────────────────────────────────
scenario('S08  Missing punch isolation — late check-in present, only missing_punch_out deducted', () => {
  const e    = emp({ joining_date: '2026-06-25' })
  const days = juneWorkDays().filter(d => d >= '2026-06-25')
  const records: EngineAttendanceRecord[] = days.map((d, i) => {
    if (d === '2026-06-30') {
      // 10:30 IST = 05:00 UTC  — late arrival, but punch-out is missing
      return { id: `r${i}`, attendance_date: d, check_in_at: `${d}T05:00:00Z`, check_out_at: null }
    }
    return recFull(d, i)
  })
  const r = resultOf(generatePayrollForEmployee(e, PERIOD, records, [], []))

  const deduction = 2 * PHR
  chk('deduction_lines.length',  r.deduction_lines.length,  1)
  const line = r.deduction_lines[0]
  chk('only missing_punch_out',  line?.deduction_type,       'missing_punch_out')
  chk('hours = 2 (not late h)',  line?.hours_deducted,       2)
  chk('total_deductions',        r.total_deductions,         deduction)
})

// ─────────────────────────────────────────────────────────────────────────────
// S09  Absent day — no leave balance to absorb it
//
// Joining: Jun 25  →  leave = 0
// Inputs:  4 full-present + Jun 30 absent (no record)
// Deduct:  1 × PDR = 1 000
// Expect:  gross = 29 000, net = 29 000
// ─────────────────────────────────────────────────────────────────────────────
scenario('S09  Absent day — no leave balance, full deduction applied', () => {
  const e    = emp({ joining_date: '2026-06-25' })
  const days = juneWorkDays().filter(d => d >= '2026-06-25')
  const records = days.filter(d => d !== '2026-06-30').map(recFull)
  const r = resultOf(generatePayrollForEmployee(e, PERIOD, records, [], []))

  chk('paid_leave_available',  r.paid_leave_available,  0)
  chk('days_absent',           r.days_absent,           1)
  chk('paid_leave_used',       r.paid_leave_used,       0)
  chk('total_deductions',      r.total_deductions,      PDR)    // 1 000
  chk('gross_salary',          r.gross_salary,          SALARY) // 30 000
  chk('net_salary',            r.net_salary,            SALARY - PDR)
})

// ─────────────────────────────────────────────────────────────────────────────
// S10  Mid-month joiner — 0.5 leave cannot absorb an absent day (needs ≥ 1)
//
// Joining: Jun 16  →  13 in-scope days  →  leave = 0.5
// Inputs:  12 full-present + Jun 30 absent
// Deduct:  stage-1 skipped (leave < 1); 1 × PDR = 1 000
// Expect:  gross = 29 000, net = 29 000
// ─────────────────────────────────────────────────────────────────────────────
scenario('S10  Mid-month joiner — 0.5 leave cannot absorb absent day (needs ≥ 1)', () => {
  const e    = emp({ joining_date: '2026-06-16' })
  const days = juneWorkDays().filter(d => d >= '2026-06-16')
  const records = days.filter(d => d !== '2026-06-30').map(recFull)
  const r = resultOf(generatePayrollForEmployee(e, PERIOD, records, [], []))

  chk('working_days_in_month', r.working_days_in_month,  13)
  chk('paid_leave_available',  r.paid_leave_available,   0.5)
  chk('paid_leave_used',       r.paid_leave_used,        0)
  chk('days_absent',           r.days_absent,            1)
  chk('total_deductions',      r.total_deductions,       PDR)    // 1 000
  chk('gross_salary',          r.gross_salary,           SALARY) // 30 000
  chk('net_salary',            r.net_salary,             SALARY - PDR)
})

// ─────────────────────────────────────────────────────────────────────────────
// S11  Sundays excluded — working_days_in_month = 26, not 30
//
// Rule: Sundays (Jun 7, 14, 21, 28) are never working days.
// Inputs:  full-month employee, all 26 working days present
// Expect:  working_days_in_month = 26
// ─────────────────────────────────────────────────────────────────────────────
scenario('S11  Sundays excluded — working_days_in_month = 26 (not 30)', () => {
  const days = juneWorkDays()
  const r = resultOf(generatePayrollForEmployee(emp(), PERIOD, days.map(recFull), [], []))

  chk('working_days_in_month = 26', r.working_days_in_month, 26)
  chk('NOT 30',                     r.working_days_in_month !== 30, true)
  chk('days_present = 26',          r.days_present, 26)
  chk('total_deductions',           r.total_deductions, 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// S12  Net salary floor at zero — large negative adjustment clamps to 0
//
// Employee: salary = 3 000, PDR = 100
// Inputs:   Jun 1 present; all other 25 working days absent (no records)
// Leave:    stage-1 absorbs 1 absent → 24 remaining → deduction = 2 400
// Gross:    max(0, 3 000 − 2 400) = 600
// Adj:      −5 000  →  net = max(0, 600 − 5 000) = 0
// ─────────────────────────────────────────────────────────────────────────────
scenario('S12  Net salary floor at zero — large negative adjustment clamps to 0', () => {
  const e    = emp({ monthly_salary: 3_000 })
  const pdr3 = 3_000 / 30   // 100
  const adjustments: EnginePendingAdjustment[] = [
    { id: 'adj1', amount: -5_000, description: 'Large recovery deduction' },
  ]
  // Only Jun 1 present; all other working days absent
  const records = [recFull('2026-06-01', 0)]
  const r = resultOf(generatePayrollForEmployee(e, PERIOD, records, [], adjustments))

  chk('days_absent',                r.days_absent,               25)
  chk('paid_leave_used',            r.paid_leave_used,            1)  // absorbed 1 absent
  chk('total_deductions',           r.total_deductions,        2_400)  // 24 × 100
  chk('gross_salary',               r.gross_salary,            3_000)
  chk('pending_adjustment_total',   r.pending_adjustment_total, -5_000)
  chk('net_salary = 0 (floored)',   r.net_salary,                  0)
})

// ─────────────────────────────────────────────────────────────────────────────
// S13  Payroll holiday excluded — attendance on that day ignored
//
// Holiday: Jun 9 (Tuesday)  →  working_days_in_month = 25
// Rule:    holiday attendance record is supplied but must not be classified.
// Expect:  working_days = 25, days_present = 25, zero deductions
// ─────────────────────────────────────────────────────────────────────────────
scenario('S13  Payroll holiday excluded — working_days = 25, holiday attendance ignored', () => {
  const holidays: EngineHoliday[] = [{ holiday_date: '2026-06-09' }]
  const days    = juneWorkDays(['2026-06-09'])   // 25 working days
  const records = [
    ...days.map(recFull),
    // Attendance record for Jun 9 exists but engine must ignore it
    { id: 'rh', attendance_date: '2026-06-09', check_in_at: '2026-06-09T03:30:00Z', check_out_at: '2026-06-09T13:00:00Z' },
  ]
  const r = resultOf(generatePayrollForEmployee(emp(), PERIOD, records, holidays, []))

  chk('working_days_in_month',  r.working_days_in_month,  25)
  chk('days_present',           r.days_present,           25)
  chk('days_absent',            r.days_absent,             0)
  chk('total_deductions',       r.total_deductions,        0)
  chk('gross_salary',           r.gross_salary,       30_000)
  chk('net_salary',             r.net_salary,         30_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// S14  Positive pending adjustment — added to net salary
//
// Inputs:  full month, all present, no deductions
// Adj:     +2 000 (prior-month underpayment correction)
// Expect:  gross = 30 000, net = 32 000
// ─────────────────────────────────────────────────────────────────────────────
scenario('S14  Positive pending adjustment — net salary increases', () => {
  const days = juneWorkDays()
  const adjustments: EnginePendingAdjustment[] = [
    { id: 'adj1', amount: 2_000, description: 'May underpayment correction' },
  ]
  const r = resultOf(generatePayrollForEmployee(emp(), PERIOD, days.map(recFull), [], adjustments))

  chk('gross_salary',               r.gross_salary,              30_000)
  chk('pending_adjustment_total',   r.pending_adjustment_total,   2_000)
  chk('net_salary',                 r.net_salary,                32_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// S15  Mixed — absent (absorbed) + half-day + missing punch-in + mixed adjustments
//
// Inputs (26 working days):
//   23 full-present
//   Jun 27 — full absent (no record)
//   Jun 29 — half-day
//   Jun 30 — missing punch-in
//   Adjustments: +500 (bonus), −200 (advance repayment)
//
// Leave absorption:
//   stage-1: absent = 1, available = 1  →  paid_leave_used = 1, remaining_absent = 0
//   stages 2/2b/3: skipped (leave already used)
//
// Remaining deductions:
//   half-day : 1 × (PDR / 2) = 500
//   hourly   : 2 × PHR       = 2 000 / 8.5  ≈ 235.294
//   total    ≈ 735.294
//
// Gross  = 30 000 − 735.294  ≈ 29 264.706
// netAdj = 500 − 200         =    300
// Net    = 29 264.706 + 300  ≈ 29 564.706
// ─────────────────────────────────────────────────────────────────────────────
scenario('S15  Mixed — absent absorbed, half-day + missing punch charged, adjustments applied', () => {
  const days = juneWorkDays()
  const records: EngineAttendanceRecord[] = days
    .filter(d => d !== '2026-06-27')      // Jun 27 absent
    .map((d, i) => {
      if (d === '2026-06-29') return recHalf(d, i)
      if (d === '2026-06-30') return recMissingIn(d, i)
      return recFull(d, i)
    })
  const adjustments: EnginePendingAdjustment[] = [
    { id: 'adj1', amount:  500, description: 'Performance bonus' },
    { id: 'adj2', amount: -200, description: 'Advance repayment' },
  ]
  const r = resultOf(generatePayrollForEmployee(emp(), PERIOD, records, [], adjustments))

  const halfDeduction   = PDR / 2        // 500
  const hourlyDeduction = 2 * PHR        // ≈ 235.294
  const totalDeduction  = halfDeduction + hourlyDeduction  // ≈ 735.294
  const netAdj          = 500 - 200                        // 300
  const expectedNet     = SALARY - totalDeduction + netAdj // ≈ 29 564.706

  chk('days_absent',                r.days_absent,                1)
  chk('paid_leave_used',            r.paid_leave_used,            1)
  chk('half_day_count',             r.half_day_count,             1)
  chk('missing_punch_hours',        r.missing_punch_hours,        2)
  chk('leave_absorbed_deductions',  r.leave_absorbed_deductions,  false)
  chk('total_deductions',           r.total_deductions,           totalDeduction)
  chk('gross_salary',               r.gross_salary,               SALARY)
  chk('pending_adjustment_total',   r.pending_adjustment_total,   300)
  chk('net_salary',                 r.net_salary,                 expectedNet)
  // Both adjustment IDs recorded
  chk('applied_adjustment_ids.length', r.applied_adjustment_ids.length, 2)
})

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════')
console.log(`  ${pass} passed   ${fail} failed   ${pass + fail} total assertions`)
console.log('══════════════════════════════════════════════════════════════\n')

if (fail > 0) process.exit(1)
