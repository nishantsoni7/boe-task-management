/**
 * BOE Credits Phase 1C — a redemption or its reversal makes a generated
 * payroll out of date, through the REAL stale helper.
 *
 * buildResultDetailPayload (the module both /api/payroll/my-result and the
 * admin detail route call) decides `stale` by re-running the engine over
 * live attendance, corrections AND active credit coverage, and comparing
 * that total to the STORED total_deductions. This file drives that exact
 * code with a table-keyed Supabase fake and proves the invariant the
 * redemption route relies on:
 *
 *   generated → redeemed → regeneration FAILED   ⇒ stale = true
 *   generated → redeemed → regeneration succeeded ⇒ stale = false
 *   regenerated with coverage → redemption reversed ⇒ stale = true
 *   regenerated after the reversal                ⇒ stale = false
 *
 * Run:
 *   npx tsx --test src/lib/payroll/resultDetailPayload.stale.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildResultDetailPayload } from './resultDetailPayload'
import { generatePayrollForEmployee } from './engine'
import { isSkip } from './types'
import type { EngineEmployee, EnginePeriod, EngineAttendanceRecord, EngineResult, AttendanceCreditRedemption } from './types'
import { DEFAULT_PAYROLL_SETTINGS } from './settings'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const EMP = 'emp-1'
const PERIOD = 'period-1'
const employee: EngineEmployee = { id: EMP, monthly_salary: 26_000, payroll_active: true, joining_date: null, employment_type: 'permanent' }
const period: EnginePeriod = { id: PERIOD, payroll_month: 7, payroll_year: 2026, status: 'draft' }
const JULY_WORKING_DAYS = [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 20, 21, 22, 23, 24, 25, 27, 28, 29, 30, 31]
const iso = (d: number) => `2026-07-${String(d).padStart(2, '0')}`
const at  = (d: number, hh: number, mm: number) => new Date(Date.UTC(2026, 6, d, hh, mm - 330)).toISOString()

/** The stored shape: what fetchAttendanceForPeriod selects. */
const TWO_ABSENCES = JULY_WORKING_DAYS
  .filter(d => d !== 21 && d !== 22)
  .map(d => ({ id: `r-${d}`, user_id: EMP, attendance_date: iso(d), check_in_at: at(d, 10, 0), check_out_at: at(d, 18, 30), punch_direction_source: 'confirmed' }))

const engineRecords: EngineAttendanceRecord[] = TWO_ABSENCES.map(r => ({
  id: r.id, attendance_date: r.attendance_date, check_in_at: r.check_in_at, check_out_at: r.check_out_at, direction_source: 'confirmed',
}))

function totalWith(coverage: AttendanceCreditRedemption[]): number {
  const o = generatePayrollForEmployee(employee, period, engineRecords, [], [], [], DEFAULT_PAYROLL_SETTINGS, coverage)
  assert.ok(!isSkip(o))
  return (o as EngineResult).total_deductions
}

const COVER_22 = { id: 'red-1', employee_id: EMP, attendance_date: '2026-07-22', deduction_type: 'absent' as const, credits: 2, transaction_id: 'tx-1', payroll_period_id: PERIOD, created_at: '2026-08-01T00:00:00Z' }

/**
 * A table-keyed fake. Filters are ignored — every table holds exactly one
 * employee-month — so what matters is which rows are ACTIVE in the
 * redemption table, which is what the scenario controls.
 */
function fakeSvc(tables: Record<string, unknown[]>) {
  const chain = (table: string): Record<string, unknown> => {
    const c: Record<string, unknown> = {}
    for (const op of ['select', 'eq', 'neq', 'is', 'gte', 'lt', 'in', 'or', 'order', 'limit', 'range']) c[op] = () => c
    const rows = () => tables[table] ?? []
    c.single      = () => Promise.resolve({ data: rows()[0] ?? null, error: rows()[0] ? null : { message: `${table}: no row` } })
    c.maybeSingle = () => Promise.resolve({ data: rows()[0] ?? null, error: null })
    c.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(ok)
    return c
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: (table: string) => chain(table) } as any
}

function world(opts: { storedTotal: number; activeRedemptions: unknown[]; status?: 'generated' | 'locked' }) {
  return fakeSvc({
    payroll_periods: [{ id: PERIOD, payroll_month: 7, payroll_year: 2026, status: opts.status ?? 'generated', locked_at: null, settings_snapshot: null }],
    payroll_results: [{
      id: 'res-1', employee_id: EMP, monthly_salary: 26_000, working_days_in_month: 27, days_present: 25, days_absent: 2, half_day_count: 0,
      gross_salary: 26_000, total_deductions: opts.storedTotal, pending_adjustment_total: 0, net_salary: 26_000 - opts.storedTotal,
      status: 'draft', generated_at: '2026-08-01T00:00:00Z', employee_reviewed_at: null,
      users: { full_name: 'Test Employee', employee_code: 'T-001' },
    }],
    payroll_deduction_lines: [],
    payroll_pending_adjustments: [],
    payroll_settlements: [],
    payroll_settings: [],
    users: [{ id: EMP, monthly_salary: 26_000, payroll_active: true, joining_date: null, employment_type: 'permanent' }],
    attendance_records: TWO_ABSENCES,
    payroll_holidays: [],
    attendance_day_corrections: [],
    boe_credit_attendance_redemptions: opts.activeRedemptions,
  })
}

async function payload(opts: Parameters<typeof world>[0], canRedeem = true) {
  const out = await buildResultDetailPayload(world(opts), { periodId: PERIOD, employeeId: EMP, canEdit: false, editBlocked: null, canRedeem })
  assert.ok(out.ok, out.ok ? '' : out.error)
  return out.ok ? out.payload : null!
}

// ─── The invariant ────────────────────────────────────────────────────────────

const BEFORE = totalWith([])           // what payroll stored before any redemption: 22 July charged
const AFTER  = totalWith([COVER_22])   // what a regeneration with the coverage stores

describe('the real stale helper sees a redemption exactly as it sees an attendance change', () => {
  test('sanity: the coverage changes the money', () => {
    assert.ok(BEFORE > 0)
    assert.equal(AFTER, 0)
  })

  test('generated, then redeemed, then regeneration FAILED → stale = true, and the day already reads as covered', async () => {
    const p = await payload({ storedTotal: BEFORE, activeRedemptions: [COVER_22] })
    assert.equal(p.stale, true)
    assert.equal(p.day_view_error, null)
    const day = p.deduction_days.find((d: { date: string }) => d.date === '2026-07-22')
    assert.ok(day)
    assert.equal(day.lines[0].waived_by, 'boe_credits')
    assert.equal(day.lines[0].credits_redeemed, 2)
    assert.equal(day.total_amount, 0)
    assert.equal(p.result.total_deductions, BEFORE, 'the stored money is what it was — and the page says it is out of date')
  })

  test('generated, redeemed, regeneration succeeded → stale = false', async () => {
    const p = await payload({ storedTotal: AFTER, activeRedemptions: [COVER_22] })
    assert.equal(p.stale, false)
  })

  test('the redemption reversed after regeneration → stale = true until regenerated', async () => {
    // Reversed = no longer active, so the redemption table answers nothing.
    const p = await payload({ storedTotal: AFTER, activeRedemptions: [] })
    assert.equal(p.stale, true)
    const day = p.deduction_days.find((d: { date: string }) => d.date === '2026-07-22')
    assert.equal(day.lines[0].waived_by, undefined, 'the day view already charges the day again')
    assert.equal(day.total_amount, BEFORE)
  })

  test('regenerated after the reversal → stale = false, and the deduction is back', async () => {
    const p = await payload({ storedTotal: BEFORE, activeRedemptions: [] })
    assert.equal(p.stale, false)
    assert.equal(p.result.total_deductions, BEFORE)
  })
})

describe('what the employee is offered', () => {
  test('an unlocked, generated month lists the chargeable day; a covered day is not offered again', async () => {
    const open = await payload({ storedTotal: BEFORE, activeRedemptions: [] })
    assert.equal(open.can_redeem, true)
    assert.deepEqual(open.redeemable_dates, [{ date: '2026-07-22', deduction_type: 'absent', credits: 2, amount: BEFORE }])

    const covered = await payload({ storedTotal: AFTER, activeRedemptions: [COVER_22] })
    assert.deepEqual(covered.redeemable_dates, [])
  })

  test('a locked month offers nothing, and the admin reader is offered nothing', async () => {
    const locked = await payload({ storedTotal: BEFORE, activeRedemptions: [], status: 'locked' })
    assert.equal(locked.can_redeem, false)
    assert.deepEqual(locked.redeemable_dates, [])

    const admin = await payload({ storedTotal: BEFORE, activeRedemptions: [] }, false)
    assert.equal(admin.can_redeem, false)
    assert.deepEqual(admin.redeemable_dates, [])
  })
})
