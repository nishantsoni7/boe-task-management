/**
 * Half a paid leave has to fit in the database.
 *
 * The engine awards 0.5 paid leave for 11 to 15 days present and can spend it on one half day, so a
 * payslip carries paid_leave_available / paid_leave_used of 0.5. Both columns were smallint until
 * 20270604000000, and Postgres refuses 0.5 for a smallint: in October 2026 two payslips could not
 * be saved and nothing said why.
 *
 * This ties the two ends together. It makes the engine produce the fraction, then checks that the
 * LATEST migration defining each column stores a fraction. The executed proof (the real migration on
 * a real Postgres) is supabase/tests/payroll_half_paid_leave_pglite.mjs.
 *
 * Run: npx tsx --test src/lib/payroll/halfPaidLeaveColumns.test.ts
 */
import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { generatePayrollForEmployee } from './engine'
import { isSkip } from './types'
import type { EngineAttendanceRecord, EngineEmployee, EnginePeriod, EngineResult } from './types'

const employee: EngineEmployee = {
  id: 'emp-1',
  monthly_salary: 26_000,
  payroll_active: true,
  joining_date: null,
  employment_type: 'permanent',
}

// July 2026: 31 days, Sundays on 5, 12, 19 and 26, so 27 working days.
const period: EnginePeriod = { id: 'period-1', payroll_month: 7, payroll_year: 2026, status: 'draft' }
const WORKING_DAYS = [
  1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18,
  20, 21, 22, 23, 24, 25, 27, 28, 29, 30, 31,
]

const iso = (day: number) => `2026-07-${String(day).padStart(2, '0')}`
/** IST wall clock on a July 2026 date, as the UTC instant the importer stores. */
const at = (day: number, hh: number, mm: number) => new Date(Date.UTC(2026, 6, day, hh, mm - 330)).toISOString()

const fullDay = (day: number): EngineAttendanceRecord =>
  ({ id: `r-${day}`, attendance_date: iso(day), check_in_at: at(day, 10, 0), check_out_at: at(day, 18, 30) })
/** About four effective hours after the lunch deduction: a half day. */
const halfDay = (day: number): EngineAttendanceRecord =>
  ({ id: `r-${day}`, attendance_date: iso(day), check_in_at: at(day, 10, 0), check_out_at: at(day, 15, 0) })

function run(records: EngineAttendanceRecord[]): EngineResult {
  const outcome = generatePayrollForEmployee(employee, period, records, [], [], [])
  assert.ok(!isSkip(outcome), `engine skipped: ${isSkip(outcome) ? outcome.reason : ''}`)
  return outcome as EngineResult
}

describe('the engine produces half a paid leave', () => {
  test('15 days present earns 0.5, not a whole number', () => {
    const r = run(WORKING_DAYS.slice(0, 15).map(fullDay))
    assert.equal(r.days_present, 15)
    assert.equal(r.paid_leave_available, 0.5)
    assert.equal(Number.isInteger(r.paid_leave_available), false)
  })

  test('0.5 is spent on one half day, so paid_leave_used is 0.5 too', () => {
    const r = run([...WORKING_DAYS.slice(0, 14).map(fullDay), halfDay(WORKING_DAYS[14])])
    assert.equal(r.paid_leave_available, 0.5)
    assert.equal(r.paid_leave_used, 0.5)
    assert.equal(Number.isInteger(r.paid_leave_used), false)
  })
})

describe('the database can hold it', () => {
  // The last file that names a column's type wins, the way a replay of the migrations does.
  // Comments are stripped first: this very file's rollback note names smallint.
  function latestType(column: string): string {
    const dir = join(process.cwd(), 'supabase/migrations')
    const typeAfterColumn = new RegExp(
      `${column}\\s+(?:type\\s+)?(smallint|integer|int2|int4|bigint|numeric\\s*\\(\\s*\\d+\\s*,\\s*\\d+\\s*\\))`,
      'gi',
    )
    let latest: string | null = null
    for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
      const sql = readFileSync(join(dir, file), 'utf8').replace(/--[^\n]*/g, '')
      for (const m of sql.matchAll(typeAfterColumn)) latest = m[1].toLowerCase().replace(/\s+/g, '')
    }
    assert.ok(latest, `no migration defines ${column}`)
    return latest
  }

  for (const column of ['paid_leave_available', 'paid_leave_used']) {
    test(`payroll_results.${column} is numeric(3,1), not a whole-number type`, () => {
      assert.equal(latestType(column), 'numeric(3,1)')
    })
  }
})
