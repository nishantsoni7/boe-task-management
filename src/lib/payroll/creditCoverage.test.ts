/**
 * BOE Credits Phase 1C — the coverage lifecycle: credits stay spent only
 * while there is a chargeable deduction for that employee and date.
 *
 * The planner is driven by the REAL engine over a known July: a day is
 * redeemed against the deduction it showed, attendance then changes (a
 * correction to Present, a shift to a half day, paid leave absorbing it),
 * and the plan must restore or re-price the credits — never leave them
 * spent for a deduction that no longer exists, never silently keep a
 * 2-credit charge on a 1-credit day. The executor is exercised against a
 * recording fake so the ORDER of database calls is pinned: reverse first,
 * then (for a re-price) a fresh correctly-priced redemption, then re-read.
 *
 * Run:
 *   npx tsx --test src/lib/payroll/creditCoverage.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { generatePayrollForEmployee } from './engine'
import { isSkip } from './types'
import type { EngineEmployee, EnginePeriod, EngineAttendanceRecord, EngineResult, AttendanceCreditRedemption } from './types'
import type { AttendanceDayCorrection } from '../attendance/corrections'
import { DEFAULT_PAYROLL_SETTINGS } from './settings'
import { planCoverageReconciliation, reconcileAttendanceCoverage } from './creditCoverage'
import type { StoredAttendanceRedemption } from './store'
// The prices the fixtures were written against (the Phase 1C literals). Since
// Phase 1D the price is a setting; the PLAN never reads it — it compares the
// kind of day bought with the kind the engine now settles.
const ATTENDANCE_REDEMPTION_COST = { half_day: 1, absent: 2 } as const

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const employee: EngineEmployee = {
  id: 'emp-1', monthly_salary: 26_000, payroll_active: true, joining_date: null, employment_type: 'permanent',
}
const period: EnginePeriod = { id: 'period-1', payroll_month: 7, payroll_year: 2026, status: 'draft' }
const JULY_WORKING_DAYS = [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 20, 21, 22, 23, 24, 25, 27, 28, 29, 30, 31]
const iso = (d: number) => `2026-07-${String(d).padStart(2, '0')}`
const at  = (d: number, hh: number, mm: number) => new Date(Date.UTC(2026, 6, d, hh, mm - 330)).toISOString()
const fullDay = (d: number): EngineAttendanceRecord => ({ id: `r-${d}`, attendance_date: iso(d), check_in_at: at(d, 10, 0), check_out_at: at(d, 18, 30) })
const halfDay = (d: number): EngineAttendanceRecord => ({ id: `r-${d}`, attendance_date: iso(d), check_in_at: at(d, 10, 0), check_out_at: at(d, 15, 0) })

function month(exceptions: Record<number, EngineAttendanceRecord | null>): EngineAttendanceRecord[] {
  const out: EngineAttendanceRecord[] = []
  for (const d of JULY_WORKING_DAYS) {
    if (d in exceptions) { const rec = exceptions[d]; if (rec) out.push(rec); continue }
    out.push(fullDay(d))
  }
  return out
}

const correction = (date: string, day_treatment: AttendanceDayCorrection['day_treatment']): AttendanceDayCorrection => ({
  attendance_date: date, corrected_check_in_at: null, corrected_check_out_at: null, day_treatment,
  waive_late_arrival: false, waive_early_checkout: false, waive_missing_punch: false,
})

function run(records: EngineAttendanceRecord[], corrections: AttendanceDayCorrection[], coverage: AttendanceCreditRedemption[]): EngineResult {
  const o = generatePayrollForEmployee(employee, period, records, [], [], corrections, DEFAULT_PAYROLL_SETTINGS, coverage)
  assert.ok(!isSkip(o))
  return o as EngineResult
}

let seq = 0
function stored(date: string, deduction_type: 'absent' | 'half_day'): StoredAttendanceRedemption {
  seq += 1
  return {
    id: `red-${seq}`, employee_id: employee.id, attendance_date: date, deduction_type,
    credits: ATTENDANCE_REDEMPTION_COST[deduction_type], transaction_id: `tx-${seq}`,
    payroll_period_id: period.id, created_at: '2026-08-01T00:00:00Z',
  }
}

// Two absences: 21 July is company-paid (earliest), 22 July is charged.
const TWO_ABSENCES = month({ 21: null, 22: null })

// ─── The plan ─────────────────────────────────────────────────────────────────

describe('a redemption whose deduction still exists is left alone', () => {
  test('absent day, still absent, still charged → no action', () => {
    const r = stored('2026-07-22', 'absent')
    const result = run(TWO_ABSENCES, [], [r])
    assert.equal(result.total_deductions, 0, 'covered')
    assert.deepEqual(planCoverageReconciliation([r], result.deduction_lines), [])
  })

  test('half day, still a half day → no action', () => {
    const r = stored('2026-07-23', 'half_day')
    const result = run(month({ 21: null, 23: halfDay(23) }), [], [r])
    assert.deepEqual(planCoverageReconciliation([r], result.deduction_lines), [])
  })
})

describe('Absent → Present: the credits come back', () => {
  test('an admin correction to a full day removes the deduction, so the redemption is reversed', () => {
    const r = stored('2026-07-22', 'absent')
    const result = run(TWO_ABSENCES, [correction('2026-07-22', 'full_day')], [r])
    assert.equal(result.deduction_lines.filter(l => l.line_date === '2026-07-22').length, 0)
    const plan = planCoverageReconciliation([r], result.deduction_lines)
    assert.equal(plan.length, 1)
    assert.equal(plan[0].action, 'reverse')
    assert.equal(plan[0].redemption.id, r.id)
    assert.match(plan[0].reason, /22 Jul 2026 no longer carries a salary deduction/)
  })

  test('Half Day → Present, the same', () => {
    const r = stored('2026-07-23', 'half_day')
    const result = run(month({ 21: null, 23: halfDay(23) }), [correction('2026-07-23', 'full_day')], [r])
    const plan = planCoverageReconciliation([r], result.deduction_lines)
    assert.equal(plan.length, 1)
    assert.equal(plan[0].action, 'reverse')
  })
})

describe('Absent → company-paid: the credits come back', () => {
  test('when the earlier absence is corrected away, paid leave moves to the redeemed day and the credits are restored', () => {
    // 21 July becomes a full day, so the month's one paid leave now absorbs
    // 22 July — the day the employee had paid for.
    const r = stored('2026-07-22', 'absent')
    const result = run(TWO_ABSENCES, [correction('2026-07-21', 'full_day')], [r])
    const line = result.deduction_lines.find(l => l.line_date === '2026-07-22')!
    assert.equal(line.waived_by, 'paid_leave')
    const plan = planCoverageReconciliation([r], result.deduction_lines)
    assert.equal(plan.length, 1)
    assert.equal(plan[0].action, 'reverse')
    assert.match(plan[0].reason, /covered by paid leave/)
  })
})

describe('Absent → Half Day: re-priced, never silently over-charged', () => {
  test('the 2-credit redemption is reversed and a 1-credit one planned in its place', () => {
    const r = stored('2026-07-22', 'absent')
    const result = run(TWO_ABSENCES, [correction('2026-07-22', 'half_day')], [r])
    const line = result.deduction_lines.find(l => l.line_date === '2026-07-22')!
    assert.equal(line.deduction_type, 'half_day')
    assert.equal(line.waived_by, 'boe_credits', 'the absent-day coverage still applies to the half day')
    const plan = planCoverageReconciliation([r], result.deduction_lines)
    assert.equal(plan.length, 1)
    assert.equal(plan[0].action, 'reprice')
    if (plan[0].action === 'reprice') {
      assert.equal(plan[0].new_type, 'half_day')
      assert.match(plan[0].reason, /now a Half Day, not Absent/)
    }
  })

  test('Half Day → Absent: the 1-credit coverage no longer fits, so it is restored and the day is chargeable again', () => {
    const r = stored('2026-07-23', 'half_day')
    const result = run(month({ 21: null, 23: halfDay(23) }), [correction('2026-07-23', 'absent')], [r])
    const line = result.deduction_lines.find(l => l.line_date === '2026-07-23')!
    assert.equal(line.deduction_type, 'absent')
    assert.equal(line.waived_by, undefined)
    assert.ok(line.amount_deducted > 0)
    const plan = planCoverageReconciliation([r], result.deduction_lines)
    assert.equal(plan.length, 1)
    assert.equal(plan[0].action, 'reverse')
    assert.match(plan[0].reason, /now Absent, not Half Day/)
  })
})

// ─── The executor ─────────────────────────────────────────────────────────────

/**
 * A recording Supabase fake for the executor: the redemption table answers
 * with whatever the scenario says is active on each read, and every RPC is
 * recorded in order.
 */
function fakeSvc(activeReads: StoredAttendanceRedemption[][], rpcFail: (name: string) => string | null = () => null) {
  const rpcs: { name: string; args: Record<string, unknown> }[] = []
  let reads = 0
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {}
    for (const op of ['select', 'eq', 'is', 'gte', 'lt', 'in', 'order', 'limit']) c[op] = () => c
    c.then = (ok: (v: unknown) => unknown) => {
      const rows = activeReads[Math.min(reads, activeReads.length - 1)] ?? []
      reads += 1
      return Promise.resolve({ data: rows, error: null }).then(ok)
    }
    return c
  }
  const svc = {
    from: () => chain(),
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args })
      const fail = rpcFail(name)
      if (fail) return Promise.resolve({ data: null, error: { message: fail, code: '55000' } })
      return Promise.resolve({ data: { redemption_id: 'x', transaction_id: 'y', reversal_transaction_id: 'z', credits: 1, available_credits: 9 }, error: null })
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { svc: svc as any, rpcs }
}

describe('reconcileAttendanceCoverage', () => {
  const corrections = [correction('2026-07-22', 'full_day')]
  const runner = (coverage: AttendanceCreditRedemption[]) => run(TWO_ABSENCES, corrections, coverage)

  test('reverses through the redemption-reversal RPC with the admin actor and a reason, then re-reads and re-runs', async () => {
    const r = stored('2026-07-22', 'absent')
    const { svc, rpcs } = fakeSvc([[r], []])
    const out = await reconcileAttendanceCoverage(svc, {
      employeeId: employee.id, periodId: period.id, month: 7, year: 2026, actorId: 'admin-1', run: runner,
    })
    assert.equal(rpcs.length, 1)
    assert.equal(rpcs[0].name, 'reverse_boe_credit_attendance_redemption')
    assert.equal(rpcs[0].args.p_redemption_id, r.id)
    assert.equal(rpcs[0].args.p_actor_id, 'admin-1')
    assert.match(String(rpcs[0].args.p_reason), /no longer carries a salary deduction/)
    assert.deepEqual(out.redemptions, [])
    assert.equal(out.failures.length, 0)
    assert.ok(!isSkip(out.outcome))
    assert.equal((out.outcome as EngineResult).total_deductions, 0, '22 July is a full day now; 21 July is company-paid')
  })

  test('a re-price is a reversal FOLLOWED BY a fresh redemption at the new kind, by the same admin', async () => {
    const r = stored('2026-07-22', 'absent')
    const repriced = { ...stored('2026-07-22', 'half_day'), id: 'red-new' }
    const { svc, rpcs } = fakeSvc([[r], [repriced]])
    const out = await reconcileAttendanceCoverage(svc, {
      employeeId: employee.id, periodId: period.id, month: 7, year: 2026, actorId: 'admin-1',
      run: coverage => run(TWO_ABSENCES, [correction('2026-07-22', 'half_day')], coverage),
    })
    assert.deepEqual(rpcs.map(c => c.name), ['reverse_boe_credit_attendance_redemption', 'redeem_boe_credits_for_attendance'])
    assert.deepEqual(rpcs[1].args, {
      p_employee_id: employee.id, p_payroll_period_id: period.id, p_attendance_date: '2026-07-22',
      p_deduction_type: 'half_day', p_actor_id: 'admin-1',
    })
    assert.equal(out.actions[0].action, 'reprice')
    const line = (out.outcome as EngineResult).deduction_lines.find(l => l.line_date === '2026-07-22')!
    assert.equal(line.credits_redeemed, 1, 'the re-run carries the re-priced coverage')
  })

  test('nothing to do → no RPC, and the outcome is the plain run', async () => {
    const r = stored('2026-07-22', 'absent')
    const { svc, rpcs } = fakeSvc([[r]])
    const out = await reconcileAttendanceCoverage(svc, {
      employeeId: employee.id, periodId: period.id, month: 7, year: 2026, actorId: 'admin-1',
      run: coverage => run(TWO_ABSENCES, [], coverage),
    })
    assert.equal(rpcs.length, 0)
    assert.deepEqual(out.actions, [])
    assert.deepEqual(out.redemptions, [r])
  })

  test('a failed reversal is reported, the coverage is re-read, and the result is written against what the ledger still holds', async () => {
    const r = stored('2026-07-22', 'absent')
    const { svc, rpcs } = fakeSvc([[r], [r]], name => name.startsWith('reverse') ? 'BOE_CREDITS_PERIOD_LOCKED: locked' : null)
    const out = await reconcileAttendanceCoverage(svc, {
      employeeId: employee.id, periodId: period.id, month: 7, year: 2026, actorId: 'admin-1', run: runner,
    })
    assert.equal(rpcs.length, 1)
    assert.equal(out.failures.length, 1)
    assert.match(out.failures[0].error, /locked/)
    assert.deepEqual(out.redemptions, [r], 'still active, so the run still sees it')
  })
})
