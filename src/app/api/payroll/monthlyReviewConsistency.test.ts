/**
 * Monthly Review must preview the calculation that generation will actually run.
 *
 *   npx tsx --test src/app/api/payroll/monthlyReviewConsistency.test.ts
 *
 * Two divergences are asserted away here, both found by audit:
 *
 *   1. The preview called generatePayrollForEmployee() WITHOUT the corrections
 *      argument, so it ran on raw biometric punches while generation ran on
 *      punches overlaid with approved admin corrections. An admin who corrected
 *      a date and then compared the two screens saw different money and nothing
 *      to explain it — and the preview was the wrong one.
 *
 *   2. The preview selected employees with a hand-written
 *      `.eq('payroll_active', true)` instead of the shared participation helper,
 *      so it did not apply the same deleted-user protection the store applies.
 *
 * The engine half is proved by running the engine both ways over the same
 * inputs. The query half is proved against the shared helper and against the
 * route source, because the filter itself is what must not drift.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { generatePayrollForEmployee } from '@/lib/payroll/engine'
import { isSkip } from '@/lib/payroll/types'
import type {
  EngineEmployee,
  EnginePeriod,
  EngineAttendanceRecord,
  EngineResult,
} from '@/lib/payroll/types'
import type { AttendanceDayCorrection } from '@/lib/attendance/corrections'
import { participatesInPayroll, onlyParticipating, PARTICIPATION_COLUMN } from '@/lib/payroll/participation'
import { toEngineAttendanceRecord } from '@/lib/payroll/store'

/**
 * Source with `//` comments removed.
 *
 * The "this must not come back" assertions below are about CODE. Without this
 * they also match the comment explaining why the old filter was replaced, so
 * documenting the fix would fail the test that guards it.
 *
 * Splits on /\r?\n/ rather than '\n': these files are checked out with CRLF, and
 * `.` does not match `\r`, so a trailing carriage return defeats an anchored
 * `.*$` and every comment survives the strip.
 */
function codeOnly(src: string): string {
  return src.split(/\r?\n/).map(line => line.replace(/(^|\s)\/\/.*/, '$1')).join('\n')
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const employee: EngineEmployee = {
  id: 'emp-1',
  monthly_salary: 26_000,
  payroll_active: true,
  joining_date: null,
  employment_type: 'permanent',
}

/** The preview builds exactly this shape — no DB row, id 'preview'. */
const previewPeriod: EnginePeriod = { id: 'preview', payroll_month: 7, payroll_year: 2026, status: 'draft' }
/** Generation uses the real period row. Same month, so same calendar. */
const realPeriod: EnginePeriod = { id: 'period-1', payroll_month: 7, payroll_year: 2026, status: 'draft' }

const JULY_WORKING_DAYS = [
  1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18,
  20, 21, 22, 23, 24, 25, 27, 28, 29, 30, 31,
]

const iso = (d: number) => `2026-07-${String(d).padStart(2, '0')}`
const at  = (d: number, hh: number, mm: number) =>
  new Date(Date.UTC(2026, 6, d, hh, mm - 330)).toISOString()

function fullDay(day: number): EngineAttendanceRecord {
  return { id: `r-${day}`, attendance_date: iso(day), check_in_at: at(day, 10, 0), check_out_at: at(day, 18, 30) }
}

/** A month with day 9 arriving very late, and day 10 missing its punch-out. */
function attendance(): EngineAttendanceRecord[] {
  return JULY_WORKING_DAYS.map(d => {
    if (d === 9)  return { id: 'r-9',  attendance_date: iso(9),  check_in_at: at(9, 12, 30), check_out_at: at(9, 18, 30) }
    if (d === 10) return { id: 'r-10', attendance_date: iso(10), check_in_at: at(10, 10, 0), check_out_at: null }
    return fullDay(d)
  })
}

const corrections: AttendanceDayCorrection[] = [
  {
    attendance_date: iso(9),
    corrected_check_in_at:  at(9, 10, 0),
    corrected_check_out_at: at(9, 18, 30),
    day_treatment: 'auto',
    waive_late_arrival: false,
    waive_early_checkout: false,
    waive_missing_punch: false,
  },
]

function resultOf(outcome: ReturnType<typeof generatePayrollForEmployee>): EngineResult {
  assert.equal(isSkip(outcome), false)
  return outcome as EngineResult
}

/** Everything that ends up on a Monthly Review row. */
function reviewRow(r: EngineResult) {
  return {
    gross_salary:              r.gross_salary,
    working_days_in_month:     r.working_days_in_month,
    days_present:              r.days_present,
    days_absent:               r.days_absent,
    half_day_count:            r.half_day_count,
    paid_leave_available:      r.paid_leave_available,
    paid_leave_used:           r.paid_leave_used,
    leave_absorbed_deductions: r.leave_absorbed_deductions,
    late_deduction_hours:      r.late_deduction_hours,
    missing_punch_hours:       r.missing_punch_hours,
    total_deductions:          r.total_deductions,
    net_salary:                r.net_salary,
  }
}

// ─── 23. Same corrections, same figures ───────────────────────────────────────

describe('23. Monthly Review and generation agree when a correction exists', () => {
  test('the correction changes the outcome at all — otherwise this proves nothing', () => {
    const raw       = resultOf(generatePayrollForEmployee(employee, realPeriod, attendance(), [], [], []))
    const corrected = resultOf(generatePayrollForEmployee(employee, realPeriod, attendance(), [], [], corrections))

    assert.notDeepEqual(
      reviewRow(raw), reviewRow(corrected),
      'the fixture must be one where ignoring corrections actually changes the money',
    )
    assert.ok(raw.late_deduction_hours > corrected.late_deduction_hours)
  })

  test('preview and generation produce identical figures for the same inputs', () => {
    const preview    = resultOf(generatePayrollForEmployee(employee, previewPeriod, attendance(), [], [], corrections))
    const generation = resultOf(generatePayrollForEmployee(employee, realPeriod,    attendance(), [], [], corrections))

    assert.deepEqual(reviewRow(preview), reviewRow(generation))
  })

  test('every corrected day classifies the same way on both paths', () => {
    const preview    = resultOf(generatePayrollForEmployee(employee, previewPeriod, attendance(), [], [], corrections))
    const generation = resultOf(generatePayrollForEmployee(employee, realPeriod,    attendance(), [], [], corrections))

    const shape = (r: EngineResult) =>
      r.day_results.map(d => ({ date: d.date, classification: d.classification, is_corrected: d.is_corrected }))

    assert.deepEqual(shape(preview), shape(generation))
  })

  test('16. both paths read stored provenance, and read it the same way', () => {
    // A stored 'confirmed' late single punch costs more than a stored
    // 'inferred' one. If the preview mapped the column differently — or skipped
    // it — the two screens would show different money for the same month, which
    // is the divergence this describe block exists to prevent.
    const late = (direction: unknown) => ({
      id: 'r-9',
      attendance_date: iso(9),
      check_in_at: at(9, 12, 30),
      check_out_at: null,
      punch_direction_source: direction,
    })

    for (const direction of ['confirmed', 'inferred', null, 'unexpected-value']) {
      const records = [
        ...JULY_WORKING_DAYS.filter(d => d !== 9 && d !== 1).map(fullDay),
        toEngineAttendanceRecord(late(direction)),
      ]

      const preview    = resultOf(generatePayrollForEmployee(employee, previewPeriod, records, [], [], []))
      const generation = resultOf(generatePayrollForEmployee(employee, realPeriod,    records, [], [], []))

      assert.deepEqual(reviewRow(preview), reviewRow(generation), String(direction))
    }
  })

  test('16b. the two routes map the column through the same function', async () => {
    const [reviewSrc, storeSrc] = await Promise.all([
      readFile('src/app/api/payroll/monthly-review/route.ts', 'utf8'),
      readFile('src/lib/payroll/store.ts', 'utf8'),
    ])

    assert.match(reviewSrc, /punch_direction_source/, 'the preview must select the column')
    assert.match(reviewSrc, /toEngineAttendanceRecord\(/, 'and narrow it the same way generation does')
    assert.match(storeSrc,  /punch_direction_source/, 'generation must select the column')
    assert.match(storeSrc,  /export function toEngineAttendanceRecord/, 'one shared narrowing function')
  })

  test('the route passes corrections into the engine', async () => {
    const src = await readFile('src/app/api/payroll/monthly-review/route.ts', 'utf8')

    assert.match(src, /fetchCurrentCorrectionsByEmployee/, 'the route must load the correction layer')
    assert.match(
      src,
      /generatePayrollForEmployee\(\s*emp,\s*previewPeriod,\s*attendance,\s*holidays,\s*adjustments,\s*corrections\s*\)/,
      'the engine call must pass all six arguments, corrections included',
    )
  })
})

// ─── 24. Same employee set ────────────────────────────────────────────────────

describe('24. deleted and payroll-inactive employees are excluded consistently', () => {
  test('the shared predicate excludes both, and defaults an absent flag to included', () => {
    assert.equal(participatesInPayroll({ payroll_active: true,  is_deleted: false }), true)
    assert.equal(participatesInPayroll({ payroll_active: false, is_deleted: false }), false)
    assert.equal(participatesInPayroll({ payroll_active: true,  is_deleted: true  }), false)
    assert.equal(participatesInPayroll({ payroll_active: false, is_deleted: true  }), false)
    assert.equal(participatesInPayroll({}), true)
    assert.equal(participatesInPayroll(null), false)
  })

  test('onlyParticipating applies the same column filter the store uses', () => {
    const calls: [string, unknown][] = []
    const fakeQuery = { eq(column: string, value: unknown) { calls.push([column, value]); return this } }

    onlyParticipating(fakeQuery)

    assert.deepEqual(calls, [[PARTICIPATION_COLUMN, true]])
    assert.equal(PARTICIPATION_COLUMN, 'payroll_active')
  })

  test('the engine still refuses an inactive employee, as the backstop', () => {
    const inactive: EngineEmployee = { ...employee, payroll_active: false }
    const outcome = generatePayrollForEmployee(inactive, previewPeriod, attendance(), [], [], [])
    assert.equal(isSkip(outcome), true)
    if (!isSkip(outcome)) return
    assert.equal(outcome.reason, 'employee_inactive')
  })

  test('the route selects through the shared helper, not a hand-written filter', async () => {
    const src = await readFile('src/app/api/payroll/monthly-review/route.ts', 'utf8')

    assert.match(src, /onlyParticipating\(/, 'the route must use the shared participation helper')
    assert.match(src, /is_deleted\.eq\.false,is_deleted\.is\.null/, 'the deleted-user guard must be applied')
    assert.doesNotMatch(
      codeOnly(src),
      /\.eq\('payroll_active',\s*true\)/,
      'the hand-written participation filter must not come back',
    )
  })

  test('the preview stays read-only', async () => {
    const src = await readFile('src/app/api/payroll/monthly-review/route.ts', 'utf8')

    const code = codeOnly(src)
    for (const write of ['.insert(', '.update(', '.upsert(', '.delete(']) {
      assert.equal(code.includes(write), false, `Monthly Review must not ${write} anything`)
    }
    assert.equal(code.includes('writeEngineResult'), false, 'the preview must not persist payroll results')
    assert.match(src, /export async function GET/, 'the preview is a GET')
    assert.equal(src.includes('export async function POST'), false)
  })
})
