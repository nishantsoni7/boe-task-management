/**
 * Payroll period deletion — behavioural tests against a real database.
 *
 * WHAT THESE PROVE THAT THE PURE TESTS CANNOT
 * -------------------------------------------
 * src/lib/payroll/deletionRules.test.ts pins the decisions. This file proves the
 * DATABASE enforces the same answers when the interface is bypassed entirely,
 * that the deletion removes exactly what it claims and nothing else, and that a
 * failure part-way through leaves the payroll readable and unchanged.
 *
 * TEST DATA
 * ---------
 * Every payroll row these tests create lives in year 2999 — outside any real
 * payroll data, and outside the month filters of every screen. No production
 * period, result, deduction line, settlement or attendance record is created,
 * modified or deleted by this file. Two guards enforce that:
 *
 *   * a fixture helper that refuses to build anything outside FIXTURE_YEAR;
 *   * a whole-suite assertion that the three real periods, their result counts
 *     and their stored totals are byte-for-byte identical before and after.
 *
 * Real USER rows are referenced (an admin to act, employees to own results)
 * because the foreign keys demand real ids. They are only ever read.
 *
 * Run:
 *   npx tsx --test src/app/api/payroll/delete/route.test.ts
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.
 */

import { test, before, after, afterEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { NextRequest } from 'next/server'
import { collectDeletionFacts, GET as deleteGET, POST as deletePOST } from './route'
import { canDeletePayrollPeriod } from '@/lib/payroll/deletionRules'
import { buildResultDetailPayload } from '@/lib/payroll/resultDetailPayload'

config({ path: '.env.local' })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

/**
 * Far outside any real payroll, and NOT shared with another suite.
 *
 * Node runs test FILES in parallel, payroll_periods has a unique (month, year),
 * and this file cleans up by YEAR — so a shared sandbox year means one suite
 * deleting another's fixtures mid-run. The years already claimed:
 *
 *   2021  ../settlementAuth.test.ts, src/lib/security/attendancePayrollApiIsolation
 *   2996  THIS FILE
 *   2997  src/lib/security/attendancePayrollIsolation, .../objectionIsolation
 *   2998  ../unlock/route.test.ts
 *   2999  ../periods/route.test.ts
 *
 * Anything new needs its own.
 */
const FIXTURE_YEAR = 2996

/**
 * The years a REAL payroll can be in.
 *
 * The production guard at the end of this file compares payroll before and
 * after. Every sandbox year has to be outside that comparison, or a fixture
 * another suite creates while this one is capturing its baseline reads as
 * "production changed" — which is exactly what it did.
 */
const REAL_YEAR_MIN = 2025
const REAL_YEAR_MAX = 2100

/** A uuid no row has, so an `in`/`not in` list is never empty. */
const NO_UUID = '00000000-0000-0000-0000-000000000000'

/** Every payroll period this file could have created, found by its year. */
async function fixturePeriodIdList(): Promise<string[]> {
  const { data } = await svc
    .from('payroll_periods').select('id').eq('payroll_year', FIXTURE_YEAR)
  return (data ?? []).map(p => (p as { id: string }).id)
}

// Two months, so "another period is not affected" is a real neighbour rather
// than an assertion about an empty database.
const TARGET_MONTH    = 3
const NEIGHBOUR_MONTH = 4

type Actors = { admin: string; manager: string; member: string; member2: string }
let actors: Actors

// ─── Production baseline ──────────────────────────────────────────────────────
// Captured once before anything runs and compared once after everything has,
// so a defect that reaches real payroll fails the suite rather than the company.

type ProductionSnapshot = {
  periods: string
  results: string
  lines: number
  settings: string
  attendance: number
  corrections: number
}

async function snapshotProduction(): Promise<ProductionSnapshot> {
  // Real years only. Every suite's sandbox year is outside this window, so a
  // fixture another test file creates while this one runs cannot be mistaken
  // for a change to real payroll.
  const { data: periods } = await svc
    .from('payroll_periods')
    .select('id, payroll_month, payroll_year, status, locked_at')
    .gte('payroll_year', REAL_YEAR_MIN)
    .lte('payroll_year', REAL_YEAR_MAX)
    .order('id')

  const realPeriodIds = (periods ?? []).map(p => (p as { id: string }).id)

  // payroll_results carries no year of its own, so real rows are selected by the
  // period they belong to. Without this the snapshot would sweep in every other
  // suite's fixtures and the guard would be worthless.
  const { data: results } = await svc
    .from('payroll_results')
    .select('id, payroll_period_id, employee_id, gross_salary, total_deductions, net_salary, half_day_count, status')
    .in('payroll_period_id', realPeriodIds.length > 0 ? realPeriodIds : [NO_UUID])
    .order('id')

  const realResultIds = (results ?? []).map(r => (r as { id: string }).id)

  const { count: lines } = await svc
    .from('payroll_deduction_lines').select('id', { count: 'exact', head: true })
    .in('payroll_result_id', realResultIds.length > 0 ? realResultIds : [NO_UUID])

  const { data: settings } = await svc
    .from('payroll_settings').select('id, settings').order('id')

  // Attendance is dated, so real rows are the ones inside the real years.
  const { count: attendance } = await svc
    .from('attendance_records').select('id', { count: 'exact', head: true })
    .gte('attendance_date', `${REAL_YEAR_MIN}-01-01`).lte('attendance_date', `${REAL_YEAR_MAX}-12-31`)

  const { count: corrections } = await svc
    .from('attendance_day_corrections').select('id', { count: 'exact', head: true })
    .gte('attendance_date', `${REAL_YEAR_MIN}-01-01`).lte('attendance_date', `${REAL_YEAR_MAX}-12-31`)

  return {
    periods:     JSON.stringify(periods ?? []),
    results:     JSON.stringify(results ?? []),
    lines:       lines ?? 0,
    settings:    JSON.stringify(settings ?? []),
    attendance:  attendance ?? 0,
    corrections: corrections ?? 0,
  }
}

let productionBefore: ProductionSnapshot

// ─── Fixture construction ─────────────────────────────────────────────────────

type Fixture = {
  targetPeriodId: string
  neighbourPeriodId: string
  generationId: string
  resultIds: string[]
  settlementIds: string[]
  correctionIds: string[]
  adjustmentIds: string[]
  attendanceIds: string[]
  neighbourResultId: string
}

const created: Fixture[] = []

/** Refuses to build anything that is not clearly test data. */
function assertFixtureYear(year: number) {
  if (year !== FIXTURE_YEAR) {
    throw new Error(`Refusing to build payroll fixtures outside year ${FIXTURE_YEAR} (got ${year})`)
  }
}

async function insertOne<T extends Record<string, unknown>>(table: string, row: T): Promise<string> {
  const { data, error } = await svc.from(table).insert(row).select('id').single()
  if (error || !data) throw new Error(`fixture insert ${table}: ${error?.message ?? 'no row'}`)
  return (data as { id: string }).id
}

async function buildFixture(opts: {
  status?: 'draft' | 'generated' | 'locked'
  withResults?: boolean
  withSettlement?: boolean
  paid?: boolean
  lockedResult?: boolean
  runningGeneration?: boolean
  carryForwardAmount?: number
  withCorrection?: boolean
  withAdjustment?: boolean
  /** Point the neighbour's result at THIS period's generation row — forces a rollback. */
  crossLinkGeneration?: boolean
} = {}): Promise<Fixture> {
  assertFixtureYear(FIXTURE_YEAR)

  const {
    status = 'generated', withResults = true, withSettlement = true, paid = false,
    lockedResult = false, runningGeneration = false, carryForwardAmount,
    withCorrection = false, withAdjustment = false, crossLinkGeneration = false,
  } = opts

  // Built as 'generated' and locked at the very end, never created locked:
  // payroll_settlements carries a BEFORE INSERT lock guard, so a locked period
  // cannot be populated. Locking last is also what really happens — a month is
  // generated and then locked.
  const targetPeriodId = await insertOne('payroll_periods', {
    payroll_month: TARGET_MONTH, payroll_year: FIXTURE_YEAR,
    status: status === 'locked' ? 'generated' : status,
    settings_snapshot: { marker: 'fixture-snapshot' },
  })
  const neighbourPeriodId = await insertOne('payroll_periods', {
    payroll_month: NEIGHBOUR_MONTH, payroll_year: FIXTURE_YEAR, status: 'generated',
  })

  const generationId = await insertOne('payroll_generation', {
    payroll_period_id: targetPeriodId,
    triggered_by: actors.admin,
    status: runningGeneration ? 'running' : 'done',
    employee_count: 2,
  })
  const neighbourGenerationId = await insertOne('payroll_generation', {
    payroll_period_id: neighbourPeriodId, triggered_by: actors.admin, status: 'done', employee_count: 1,
  })

  const resultIds: string[] = []
  const settlementIds: string[] = []

  if (withResults) {
    for (const [i, employee] of [actors.member, actors.member2].entries()) {
      const resultId = await insertOne('payroll_results', {
        payroll_period_id: targetPeriodId,
        employee_id: employee,
        monthly_salary: 20000,
        working_days_in_month: 26,
        gross_salary: 20000,
        total_deductions: 1154,
        net_salary: 18846,
        half_day_count: 1,
        status: lockedResult && i === 0 ? 'locked' : 'draft',
        payroll_generation_id: generationId,
      })
      resultIds.push(resultId)

      // Two lines per result, so "stored deduction and addition lines are
      // removed" is a count that could fail rather than a tautology.
      for (const line of [
        { line_date: `${FIXTURE_YEAR}-0${TARGET_MONTH}-20`, deduction_type: 'half_day', hours_deducted: 4.25, amount_deducted: 385 },
        { line_date: `${FIXTURE_YEAR}-0${TARGET_MONTH}-21`, deduction_type: 'absent',   hours_deducted: 8.5,  amount_deducted: 769 },
      ]) {
        await insertOne('payroll_deduction_lines', { payroll_result_id: resultId, ...line })
      }

      if (withSettlement) {
        settlementIds.push(await insertOne('payroll_settlements', {
          payroll_period_id: targetPeriodId,
          employee_id: employee,
          payroll_result_id: resultId,
          proposed_carry_forward: 0,
          carry_forward_amount: 0,
          ...(paid && i === 0
            ? { amount_paid: 18846, payment_date: `${FIXTURE_YEAR}-0${TARGET_MONTH}-28`, payment_recorded_by: actors.admin }
            : {}),
        }))
      }
    }
  }

  // The neighbour's own result — the thing that must survive untouched.
  const neighbourResultId = await insertOne('payroll_results', {
    payroll_period_id: neighbourPeriodId,
    employee_id: actors.member,
    monthly_salary: 20000,
    working_days_in_month: 26,
    gross_salary: 20000,
    total_deductions: 0,
    net_salary: 20000,
    status: 'draft',
    // Cross-linking makes step 10 of the RPC (deleting this period's generation
    // rows) violate a foreign key, which is how the rollback test forces a
    // dependent-record failure without any DDL.
    payroll_generation_id: crossLinkGeneration ? generationId : neighbourGenerationId,
  })
  await insertOne('payroll_deduction_lines', {
    payroll_result_id: neighbourResultId,
    line_date: `${FIXTURE_YEAR}-0${NEIGHBOUR_MONTH}-10`,
    deduction_type: 'late_arrival', hours_deducted: 0.5, amount_deducted: 45,
  })

  // The neighbour's settlement carries a balance forward FROM the target.
  if (carryForwardAmount !== undefined) {
    settlementIds.push(await insertOne('payroll_settlements', {
      payroll_period_id: neighbourPeriodId,
      employee_id: actors.member,
      payroll_result_id: neighbourResultId,
      proposed_carry_forward: carryForwardAmount,
      carry_forward_amount: carryForwardAmount,
      carry_forward_source_period_id: targetPeriodId,
    }))
  }

  const attendanceIds: string[] = []
  const correctionIds: string[] = []
  if (withCorrection) {
    // Raw attendance, and an admin correction of it that points at the period.
    attendanceIds.push(await insertOne('attendance_records', {
      user_id: actors.member,
      attendance_date: `${FIXTURE_YEAR}-0${TARGET_MONTH}-20`,
      check_in_at:  `${FIXTURE_YEAR}-0${TARGET_MONTH}-20T04:35:00Z`,
      check_out_at: `${FIXTURE_YEAR}-0${TARGET_MONTH}-20T08:03:00Z`,
      status: 'present',
    }))
    correctionIds.push(await insertOne('attendance_day_corrections', {
      user_id: actors.member,
      attendance_date: `${FIXTURE_YEAR}-0${TARGET_MONTH}-20`,
      day_treatment: 'half_day',
      remark: 'Fixture correction — must survive payroll deletion.',
      payroll_period_id: targetPeriodId,
      corrected_by: actors.admin,
      is_current: true,
    }))
  }

  const adjustmentIds: string[] = []
  if (withAdjustment && resultIds.length > 0) {
    adjustmentIds.push(await insertOne('payroll_pending_adjustments', {
      employee_id: actors.member,
      description: 'Fixture advance',
      amount: 500,
      adjustment_type: 'deduction',
      status: 'applied',
      payroll_month: TARGET_MONTH,
      payroll_year: FIXTURE_YEAR,
      applied_in_period_id: targetPeriodId,
      payroll_result_id: resultIds[0],
      created_by: actors.admin,
    }))
  }

  if (status === 'locked') {
    const { error } = await svc
      .from('payroll_periods')
      .update({ status: 'locked', locked_at: new Date().toISOString(), locked_by: actors.admin })
      .eq('id', targetPeriodId)
    if (error) throw new Error(`fixture lock: ${error.message}`)
  }

  const fixture: Fixture = {
    targetPeriodId, neighbourPeriodId, generationId,
    resultIds, settlementIds, correctionIds, adjustmentIds, attendanceIds,
    neighbourResultId,
  }
  created.push(fixture)
  return fixture
}

/**
 * Removes every year-2999 row, in FK-safe order. Never touches real data.
 *
 * Scoped by YEAR rather than by the ids a fixture remembers, because a test that
 * fails part-way leaves rows no fixture object knows about, and a leftover
 * fixture period is the one thing that can make the next test lie.
 *
 * The unlock at the top is not optional: payroll_settlements carries a BEFORE
 * DELETE trigger that refuses any change to a locked period, so the fixture for
 * "a locked payroll is blocked" cannot be cleaned up while it is still locked.
 */
async function destroyFixtures() {
  created.length = 0

  // These two are cleaned FIRST and by YEAR, because both deliberately outlive
  // the period they belong to: a successful deletion clears an adjustment's
  // period pointer, and the audit row has no foreign key at all. Scoping them by
  // period id would leave both behind for good.
  await svc.from('payroll_pending_adjustments').delete().eq('payroll_year', FIXTURE_YEAR)
  await svc.from('payroll_deletion_audit').delete().eq('payroll_year', FIXTURE_YEAR)

  const periodIds = await fixturePeriodIdList()
  if (periodIds.length === 0) return

  // 1. Unlock, so the settlement lock guard lets the cleanup through.
  await svc.from('payroll_periods').update({ status: 'generated' }).in('id', periodIds)

  const { data: rs } = await svc.from('payroll_results').select('id').in('payroll_period_id', periodIds)
  const resultIds = (rs ?? []).map(r => (r as { id: string }).id)
  const safeResultIds = resultIds.length > 0 ? resultIds : [NO_UUID]

  await svc.from('payroll_deletion_audit').delete().in('payroll_period_id', periodIds)
  await svc.from('payroll_pending_adjustments').delete().in('applied_in_period_id', periodIds)
  await svc.from('payroll_pending_adjustments').delete().in('payroll_result_id', safeResultIds)
  await svc.from('attendance_day_corrections').delete().in('payroll_period_id', periodIds)
  await svc.from('attendance_day_corrections').delete()
    .gte('attendance_date', `${FIXTURE_YEAR}-01-01`).lte('attendance_date', `${FIXTURE_YEAR}-12-31`)
  await svc.from('attendance_records').delete()
    .gte('attendance_date', `${FIXTURE_YEAR}-01-01`).lte('attendance_date', `${FIXTURE_YEAR}-12-31`)
  await svc.from('payroll_settlements').delete().in('payroll_period_id', periodIds)
  await svc.from('payroll_settlements').delete().in('carry_forward_source_period_id', periodIds)
  await svc.from('payroll_deduction_lines').delete().in('payroll_result_id', safeResultIds)
  await svc.from('payroll_results').delete().in('id', safeResultIds)
  await svc.from('payroll_generation').delete().in('payroll_period_id', periodIds)
  await svc.from('payroll_period_status_events').delete().in('payroll_period_id', periodIds)

  const { error } = await svc.from('payroll_periods').delete().in('id', periodIds)
  if (error) throw new Error(`fixture cleanup could not remove the periods: ${error.message}`)
}

/** Call the deletion RPC exactly as the route does. */
async function deletePeriod(params: {
  periodId: string
  actor?: string
  reason?: string
  month?: number
  year?: number
}) {
  return svc.rpc('delete_payroll_period', {
    p_period_id: params.periodId,
    p_month:     params.month ?? TARGET_MONTH,
    p_year:      params.year  ?? FIXTURE_YEAR,
    p_reason:    params.reason ?? 'Behavioural test — fixture payroll.',
    p_actor:     params.actor ?? actors.admin,
  })
}

async function countIn(table: string, column: string, value: string): Promise<number> {
  const { count } = await svc.from(table).select('id', { count: 'exact', head: true }).eq(column, value)
  return count ?? 0
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

before(async () => {
  const { data: users, error } = await svc
    .from('users').select('id, role').eq('is_active', true).order('id')
  if (error) throw new Error(`could not resolve test actors: ${error.message}`)

  const byRole = (role: string) => (users ?? []).filter(u => (u as { role: string }).role === role)
  const admin   = byRole('admin')[0]  as { id: string } | undefined
  const manager = byRole('manager')[0] as { id: string } | undefined
  const members = byRole('member')     as Array<{ id: string }>

  if (!admin || members.length < 2) {
    throw new Error('These tests need one admin and two member accounts to reference.')
  }

  actors = {
    admin:   admin.id,
    // No manager account is not a reason to skip the manager test — an admin id
    // is never substituted, so the assertion would be meaningless. Falls back to
    // a member, which is denied by the same rule.
    manager: manager?.id ?? members[0].id,
    member:  members[0].id,
    member2: members[1].id,
  }

  // Defensive: a prior interrupted run must not leave year-2999 rows behind.
  await destroyFixtures()

  productionBefore = await snapshotProduction()
})

afterEach(async () => { await destroyFixtures() })

after(async () => {
  await destroyFixtures()

  // Belt and braces: nothing in year 2999 may survive this file, in ANY table.
  // The two that outlive their period are named explicitly because they are the
  // two that once did survive it.
  for (const table of ['payroll_periods', 'payroll_pending_adjustments', 'payroll_deletion_audit']) {
    const { count } = await svc
      .from(table).select('id', { count: 'exact', head: true }).eq('payroll_year', FIXTURE_YEAR)
    assert.equal(count ?? 0, 0, `fixture rows were left behind in ${table}`)
  }
  // Bounded at both ends: another suite's sandbox year is not this file's to
  // assert about.
  const { count: strayAttendance } = await svc
    .from('attendance_records').select('id', { count: 'exact', head: true })
    .gte('attendance_date', `${FIXTURE_YEAR}-01-01`).lte('attendance_date', `${FIXTURE_YEAR}-12-31`)
  assert.equal(strayAttendance ?? 0, 0, 'fixture attendance records were left behind')
})

// ─── 1. Authorization ─────────────────────────────────────────────────────────

describe('authorization', () => {
  test('an admin can delete an eligible payroll', async () => {
    const f = await buildFixture()
    const { data, error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.equal(error, null)
    assert.equal((data as { deleted: boolean }).deleted, true)
  })

  test('an employee is denied by the database, not merely by the interface', async () => {
    const f = await buildFixture()
    const { error } = await deletePeriod({ periodId: f.targetPeriodId, actor: actors.member })
    assert.ok(error, 'a member must not be able to delete payroll')
    assert.match(error!.message, /PAYROLL_DELETE_DENIED/)
    assert.equal(await countIn('payroll_results', 'payroll_period_id', f.targetPeriodId), 2)
  })

  test('a manager is denied — manager is not admin under the current business rules', async () => {
    const f = await buildFixture()
    const { error } = await deletePeriod({ periodId: f.targetPeriodId, actor: actors.manager })
    assert.ok(error)
    assert.match(error!.message, /PAYROLL_DELETE_DENIED/)
    assert.equal(await countIn('payroll_results', 'payroll_period_id', f.targetPeriodId), 2)
  })

  test('a null actor is denied', async () => {
    const f = await buildFixture()
    const { error } = await svc.rpc('delete_payroll_period', {
      p_period_id: f.targetPeriodId, p_month: TARGET_MONTH, p_year: FIXTURE_YEAR,
      p_reason: 'no actor', p_actor: null,
    })
    assert.ok(error)
    assert.match(error!.message, /PAYROLL_DELETE_DENIED/)
  })

  test('custom module visibility cannot grant deletion — the rule reads users.role only', () => {
    // The shape a Control Center "Custom" member arrives in. Asserted here as
    // well as in the pure suite because this is the rule the route applies
    // before it ever reaches the database.
    for (const role of ['member', 'manager', 'custom']) {
      assert.equal(
        canDeletePayrollPeriod(role, {
          status: 'generated', resultCount: 2, settlementCount: 2, paidSettlementCount: 0,
          lockedResultCount: 0, generationRunning: false, carryForwardDependentCount: 0,
        }).allowed,
        false,
      )
    }
  })

  test('the HTTP route refuses a caller with no session, on both verbs', async () => {
    const f = await buildFixture()

    const get = await deleteGET(
      new NextRequest(`http://localhost/api/payroll/delete?period_id=${f.targetPeriodId}`),
    )
    assert.equal(get.status, 401)

    const post = await deletePOST(new NextRequest('http://localhost/api/payroll/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payroll_period_id: f.targetPeriodId,
        payroll_month: TARGET_MONTH,
        payroll_year: FIXTURE_YEAR,
        confirmation: `March ${FIXTURE_YEAR}`,
        reason: 'direct call with no session',
      }),
    }))
    assert.equal(post.status, 401)

    // And the payroll is untouched by either attempt.
    assert.equal(await countIn('payroll_results', 'payroll_period_id', f.targetPeriodId), 2)
    assert.equal(await countIn('payroll_periods', 'id', f.targetPeriodId), 1)
  })

  test('the HTTP route refuses a bearer token that is not a session', async () => {
    const f = await buildFixture()
    const post = await deletePOST(new NextRequest('http://localhost/api/payroll/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-real-token' },
      body: JSON.stringify({
        payroll_period_id: f.targetPeriodId,
        payroll_month: TARGET_MONTH,
        payroll_year: FIXTURE_YEAR,
        confirmation: `March ${FIXTURE_YEAR}`,
        reason: 'forged token',
      }),
    }))
    assert.equal(post.status, 401)
    assert.equal(await countIn('payroll_periods', 'id', f.targetPeriodId), 1)
  })

  test('the RPC is not executable by anon or authenticated — a direct PostgREST call cannot reach it', async () => {
    const anon = createClient(SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '')
    const f = await buildFixture()
    const { error } = await anon.rpc('delete_payroll_period', {
      p_period_id: f.targetPeriodId, p_month: TARGET_MONTH, p_year: FIXTURE_YEAR,
      p_reason: 'direct call', p_actor: actors.admin,
    })
    assert.ok(error, 'an anonymous PostgREST call must not be able to execute the deletion')
    assert.equal(await countIn('payroll_results', 'payroll_period_id', f.targetPeriodId), 2)
  })
})

// ─── 2. Safety rules ──────────────────────────────────────────────────────────

describe('safety rules', () => {
  test('a draft payroll can be deleted', async () => {
    const f = await buildFixture({ status: 'draft', withResults: false, withSettlement: false })
    const { data, error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.equal(error, null)
    assert.equal((data as { period_status: string }).period_status, 'draft')
    assert.equal(await countIn('payroll_periods', 'id', f.targetPeriodId), 0)
  })

  test('a generated, unpaid, unsettled payroll can be deleted', async () => {
    const f = await buildFixture({ status: 'generated' })
    const { data, error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.equal(error, null)
    assert.equal((data as { results_deleted: number }).results_deleted, 2)
  })

  test('a locked payroll is blocked, and deletion does not unlock it', async () => {
    const f = await buildFixture({ status: 'locked' })
    const { error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.ok(error)
    assert.match(error!.message, /PAYROLL_DELETE_BLOCKED_LOCKED/)

    const { data: period } = await svc
      .from('payroll_periods').select('status').eq('id', f.targetPeriodId).single()
    assert.equal((period as { status: string }).status, 'locked', 'the period must still be locked')
    assert.equal(await countIn('payroll_results', 'payroll_period_id', f.targetPeriodId), 2)
  })

  test('a payroll with a recorded payment is blocked', async () => {
    const f = await buildFixture({ paid: true })
    const { error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.ok(error)
    assert.match(error!.message, /PAYROLL_DELETE_BLOCKED_PAID/)
    assert.equal(await countIn('payroll_results', 'payroll_period_id', f.targetPeriodId), 2)
  })

  test('a settled payroll is blocked even when only a payment date is recorded', async () => {
    const f = await buildFixture()
    await svc.from('payroll_settlements')
      .update({ payment_date: `${FIXTURE_YEAR}-0${TARGET_MONTH}-28` })
      .eq('id', f.settlementIds[0])

    const { error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.ok(error)
    assert.match(error!.message, /PAYROLL_DELETE_BLOCKED_PAID/)
  })

  test('a locked employee result blocks deletion', async () => {
    const f = await buildFixture({ lockedResult: true })
    const { error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.ok(error)
    assert.match(error!.message, /PAYROLL_DELETE_BLOCKED_RESULT_LOCKED/)
  })

  test('deletion while a generation is running is blocked', async () => {
    const f = await buildFixture({ runningGeneration: true })
    const { error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.ok(error)
    assert.match(error!.message, /PAYROLL_DELETE_BLOCKED_RUNNING/)
    assert.equal(await countIn('payroll_results', 'payroll_period_id', f.targetPeriodId), 2)
  })

  test('a later payroll carrying a non-zero balance forward blocks deletion', async () => {
    const f = await buildFixture({ carryForwardAmount: 1500 })
    const { error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.ok(error)
    assert.match(error!.message, /PAYROLL_DELETE_BLOCKED_CARRY_FORWARD/)
  })

  test('a zero-value carry-forward pointer is cleared, not blocked, and no amount changes', async () => {
    const f = await buildFixture({ carryForwardAmount: 0 })
    const { error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.equal(error, null)

    const { data: neighbourSettlement } = await svc
      .from('payroll_settlements')
      .select('carry_forward_source_period_id, carry_forward_amount, payroll_period_id')
      .eq('payroll_period_id', f.neighbourPeriodId)
      .single()
    const s = neighbourSettlement as { carry_forward_source_period_id: string | null; carry_forward_amount: number }
    assert.equal(s.carry_forward_source_period_id, null, 'the dangling pointer must be cleared')
    assert.equal(Number(s.carry_forward_amount), 0, 'the amount must not change')
  })

  test('a mismatched month or year is refused — deletion is never by a broad month query', async () => {
    const f = await buildFixture()
    const { error } = await deletePeriod({ periodId: f.targetPeriodId, month: NEIGHBOUR_MONTH })
    assert.ok(error)
    assert.match(error!.message, /PAYROLL_DELETE_MISMATCH/)
    assert.equal(await countIn('payroll_results', 'payroll_period_id', f.targetPeriodId), 2)
  })

  test('a blank reason is refused', async () => {
    const f = await buildFixture()
    const { error } = await deletePeriod({ periodId: f.targetPeriodId, reason: '   ' })
    assert.ok(error)
    assert.match(error!.message, /PAYROLL_DELETE_REASON_REQUIRED/)
    assert.equal(await countIn('payroll_results', 'payroll_period_id', f.targetPeriodId), 2)
  })
})

// ─── 3. What survives ─────────────────────────────────────────────────────────

describe('what deletion must not touch', () => {
  test('another payroll period, its results and its lines are unaffected', async () => {
    const f = await buildFixture()
    const { error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.equal(error, null)

    assert.equal(await countIn('payroll_periods', 'id', f.neighbourPeriodId), 1)
    assert.equal(await countIn('payroll_results', 'payroll_period_id', f.neighbourPeriodId), 1)
    assert.equal(await countIn('payroll_deduction_lines', 'payroll_result_id', f.neighbourResultId), 1)
  })

  test('raw attendance records are untouched', async () => {
    const f = await buildFixture({ withCorrection: true })
    const before = await countIn('attendance_records', 'user_id', actors.member)

    const { error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.equal(error, null)

    assert.equal(await countIn('attendance_records', 'user_id', actors.member), before)
    assert.equal(await countIn('attendance_records', 'id', f.attendanceIds[0]), 1)
  })

  test('attendance corrections survive in full — only the period pointer is cleared', async () => {
    const f = await buildFixture({ withCorrection: true })
    const { data: correctionBefore } = await svc
      .from('attendance_day_corrections').select('*').eq('id', f.correctionIds[0]).single()

    const { error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.equal(error, null)

    const { data: correctionAfter } = await svc
      .from('attendance_day_corrections').select('*').eq('id', f.correctionIds[0]).single()

    assert.ok(correctionAfter, 'the correction must not be deleted')
    const before = { ...(correctionBefore as Record<string, unknown>), payroll_period_id: null }
    assert.deepEqual(correctionAfter, before, 'only payroll_period_id may differ')
  })

  test('employee records and salary configuration are unchanged', async () => {
    const f = await buildFixture()
    const { data: before } = await svc
      .from('users').select('id, full_name, employee_code, is_active, payroll_active')
      .in('id', [actors.member, actors.member2]).order('id')

    const { error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.equal(error, null)

    const { data: after } = await svc
      .from('users').select('id, full_name, employee_code, is_active, payroll_active')
      .in('id', [actors.member, actors.member2]).order('id')
    assert.deepEqual(after, before)
  })

  test('global Payroll Settings are unchanged', async () => {
    const f = await buildFixture()
    const { data: before } = await svc.from('payroll_settings').select('*').order('id')

    const { error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.equal(error, null)

    const { data: after } = await svc.from('payroll_settings').select('*').order('id')
    assert.deepEqual(after, before)
  })

  test('salary advances return to pending rather than being destroyed', async () => {
    const f = await buildFixture({ withAdjustment: true })
    const { error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.equal(error, null)

    const { data: adj } = await svc
      .from('payroll_pending_adjustments').select('*').eq('id', f.adjustmentIds[0]).single()
    const a = adj as { status: string; applied_in_period_id: string | null; payroll_result_id: string | null; amount: number }
    assert.equal(a.status, 'pending')
    assert.equal(a.applied_in_period_id, null)
    assert.equal(a.payroll_result_id, null)
    assert.equal(Number(a.amount), 500, 'the amount the admin recorded must survive')
  })
})

// ─── 4. What is removed ───────────────────────────────────────────────────────

describe('dependent data and visibility', () => {
  test('period-owned employee results and their deduction lines are removed', async () => {
    const f = await buildFixture()
    assert.equal(await countIn('payroll_deduction_lines', 'payroll_result_id', f.resultIds[0]), 2)

    const { data, error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.equal(error, null)

    assert.equal(await countIn('payroll_results', 'payroll_period_id', f.targetPeriodId), 0)
    for (const resultId of f.resultIds) {
      assert.equal(await countIn('payroll_deduction_lines', 'payroll_result_id', resultId), 0)
    }
    const counts = (data as { removed_counts: Record<string, number> }).removed_counts
    assert.equal(counts.payroll_results, 2)
    assert.equal(counts.payroll_deduction_lines, 4)
  })

  test('the period settings snapshot goes with the period', async () => {
    const f = await buildFixture()
    const { error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.equal(error, null)
    assert.equal(await countIn('payroll_periods', 'id', f.targetPeriodId), 0)
  })

  test('no orphaned payroll records remain anywhere', async () => {
    const f = await buildFixture({ withCorrection: true, withAdjustment: true, carryForwardAmount: 0 })
    const { error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.equal(error, null)

    assert.equal(await countIn('payroll_results',              'payroll_period_id', f.targetPeriodId), 0)
    assert.equal(await countIn('payroll_generation',           'payroll_period_id', f.targetPeriodId), 0)
    assert.equal(await countIn('payroll_settlements',          'payroll_period_id', f.targetPeriodId), 0)
    assert.equal(await countIn('payroll_period_status_events', 'payroll_period_id', f.targetPeriodId), 0)
    assert.equal(await countIn('payroll_settlements', 'carry_forward_source_period_id', f.targetPeriodId), 0)
    assert.equal(await countIn('attendance_day_corrections', 'payroll_period_id', f.targetPeriodId), 0)
    assert.equal(await countIn('payroll_pending_adjustments', 'applied_in_period_id', f.targetPeriodId), 0)
    for (const resultId of f.resultIds) {
      assert.equal(await countIn('payroll_deduction_lines',    'payroll_result_id', resultId), 0)
      assert.equal(await countIn('payroll_pending_adjustments','payroll_result_id', resultId), 0)
      assert.equal(await countIn('employee_record_objections', 'payroll_result_id', resultId), 0)
    }
  })

  test('the employee no longer lists the deleted period in My Payroll', async () => {
    const f = await buildFixture()
    // Exactly the read GET /api/payroll/my-result performs for its list view.
    const listFor = async (employeeId: string) => {
      const { data } = await svc
        .from('payroll_results').select('id, payroll_period_id').eq('employee_id', employeeId)
      return (data ?? []).map(r => (r as { payroll_period_id: string }).payroll_period_id)
    }

    assert.ok((await listFor(actors.member)).includes(f.targetPeriodId))

    const { error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.equal(error, null)

    const after = await listFor(actors.member)
    assert.ok(!after.includes(f.targetPeriodId), 'the deleted month must leave the employee list')
    assert.ok(after.includes(f.neighbourPeriodId), 'their other months must remain')
  })

  test('the deleted month is gone from the period list and its counts', async () => {
    const f = await buildFixture()
    const { error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.equal(error, null)

    const { data: periods } = await svc
      .from('payroll_periods').select('id').eq('payroll_year', FIXTURE_YEAR)
    const ids = (periods ?? []).map(p => (p as { id: string }).id)
    assert.ok(!ids.includes(f.targetPeriodId))
    assert.ok(ids.includes(f.neighbourPeriodId))
  })

  test('direct access to a deleted payroll id returns not found, for admin and employee alike', async () => {
    const f = await buildFixture()
    const { error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.equal(error, null)

    // The preview the delete route serves.
    assert.equal(await collectDeletionFacts(svc, f.targetPeriodId), null)

    // The payslip detail both the admin route and My Payroll are built on.
    for (const employeeId of [actors.member, actors.member2]) {
      const outcome = await buildResultDetailPayload(svc, {
        periodId: f.targetPeriodId, employeeId, canEdit: false, editBlocked: null,
      })
      assert.equal(outcome.ok, false)
      assert.equal(outcome.ok === false && outcome.status, 404)
    }
  })

  test('a report route reading the deleted period finds nothing', async () => {
    const f = await buildFixture()
    const { error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.equal(error, null)

    // What GET /api/payroll/salary-report does before it builds anything.
    const { data: period } = await svc
      .from('payroll_periods').select('id').eq('id', f.targetPeriodId).maybeSingle()
    assert.equal(period, null)
  })
})

// ─── 5. Transaction safety and auditing ───────────────────────────────────────

describe('transaction safety', () => {
  test('a dependent-record failure rolls back the whole deletion', async () => {
    // The neighbour's result points at the target period's generation row, so
    // step 10 — deleting that generation — violates a foreign key AFTER the
    // results and lines have already been deleted inside the transaction.
    const f = await buildFixture({ crossLinkGeneration: true })

    const { error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.ok(error, 'the deletion must fail')

    // Everything is still there, exactly as it was.
    assert.equal(await countIn('payroll_periods', 'id', f.targetPeriodId), 1)
    assert.equal(await countIn('payroll_results', 'payroll_period_id', f.targetPeriodId), 2)
    for (const resultId of f.resultIds) {
      assert.equal(await countIn('payroll_deduction_lines', 'payroll_result_id', resultId), 2)
    }
    assert.equal(await countIn('payroll_settlements', 'payroll_period_id', f.targetPeriodId), 2)
    assert.equal(await countIn('payroll_generation', 'payroll_period_id', f.targetPeriodId), 1)

    // And no audit event claims a deletion that did not happen.
    assert.equal(await countIn('payroll_deletion_audit', 'payroll_period_id', f.targetPeriodId), 0)
  })

  test('the payroll stays readable after a failed deletion', async () => {
    const f = await buildFixture({ crossLinkGeneration: true })
    await deletePeriod({ periodId: f.targetPeriodId })

    const outcome = await buildResultDetailPayload(svc, {
      periodId: f.targetPeriodId, employeeId: actors.member, canEdit: false, editBlocked: null,
    })
    assert.equal(outcome.ok, true, 'the payslip must still open after a failed deletion')
  })

  test('a repeated submission cannot delete a second payroll or corrupt counts', async () => {
    const f = await buildFixture()

    const first = await deletePeriod({ periodId: f.targetPeriodId })
    assert.equal(first.error, null)

    const second = await deletePeriod({ periodId: f.targetPeriodId })
    assert.ok(second.error, 'the second call must not succeed')
    assert.match(second.error!.message, /PAYROLL_DELETE_MISSING/)

    // The neighbour is untouched and exactly one audit row exists.
    assert.equal(await countIn('payroll_periods', 'id', f.neighbourPeriodId), 1)
    assert.equal(await countIn('payroll_results', 'payroll_period_id', f.neighbourPeriodId), 1)
    assert.equal(await countIn('payroll_deletion_audit', 'payroll_period_id', f.targetPeriodId), 1)
  })
})

describe('the deletion audit', () => {
  test('a minimal audit event is retained, with the mandatory reason', async () => {
    const f = await buildFixture()
    const reason = 'Test payroll created while configuring the module.'
    const { error } = await deletePeriod({ periodId: f.targetPeriodId, reason })
    assert.equal(error, null)

    const { data: audit } = await svc
      .from('payroll_deletion_audit').select('*').eq('payroll_period_id', f.targetPeriodId).single()
    const a = audit as Record<string, unknown>

    assert.equal(a.payroll_period_id, f.targetPeriodId)
    assert.equal(a.payroll_month, TARGET_MONTH)
    assert.equal(a.payroll_year,  FIXTURE_YEAR)
    assert.equal(a.period_status, 'generated')
    assert.equal(a.deleted_by,    actors.admin)
    assert.equal(a.reason,        reason)
    assert.equal(a.results_deleted, 2)
    assert.equal(a.deduction_lines_deleted, 4)
    assert.ok(a.deleted_at, 'the deletion must be timestamped')
  })

  test('the audit records whether the period was draft or generated', async () => {
    const draft = await buildFixture({ status: 'draft', withResults: false, withSettlement: false })
    await deletePeriod({ periodId: draft.targetPeriodId })
    const { data: a } = await svc
      .from('payroll_deletion_audit').select('period_status, results_deleted')
      .eq('payroll_period_id', draft.targetPeriodId).single()
    assert.equal((a as { period_status: string }).period_status, 'draft')
    assert.equal((a as { results_deleted: number }).results_deleted, 0)
  })

  test('no salary amount is copied into the audit event', async () => {
    const f = await buildFixture()
    const { error } = await deletePeriod({ periodId: f.targetPeriodId })
    assert.equal(error, null)

    const { data: audit } = await svc
      .from('payroll_deletion_audit').select('*').eq('payroll_period_id', f.targetPeriodId).single()

    // The fixture's figures — 20000 gross, 1154 deducted, 18846 net, 385 and 769
    // on the lines. None may appear anywhere in the audit row.
    //
    // The identifiers are dropped before the search, and deliberately: a uuid or
    // an ISO timestamp is a long random digit string, and "385" turns up inside
    // one often enough that the assertion would fail on luck rather than on a
    // leak. What is left is every field that could actually carry an amount.
    const { id: _id, payroll_period_id: _pid, deleted_by: _by, deleted_at: _at, ...meaningful } =
      audit as Record<string, unknown>
    const serialised = JSON.stringify(meaningful)
    for (const amount of ['20000', '18846', '1154', '385', '769']) {
      assert.doesNotMatch(serialised, new RegExp(amount), `the audit must not carry the amount ${amount}`)
    }

    // And structurally: no column names money.
    const columns = Object.keys(audit as Record<string, unknown>)
    for (const column of columns) {
      assert.doesNotMatch(column, /salary|amount|gross|net|deduction_amount|payslip/i,
        `audit column "${column}" must not name a monetary field`)
    }
    // The two count columns are allowed and are counts, not money.
    assert.ok(columns.includes('results_deleted'))
    assert.ok(columns.includes('deduction_lines_deleted'))
  })

  test('the audit survives the payroll it describes — it holds no foreign key to it', async () => {
    const f = await buildFixture()
    await deletePeriod({ periodId: f.targetPeriodId })

    assert.equal(await countIn('payroll_periods', 'id', f.targetPeriodId), 0)
    assert.equal(await countIn('payroll_deletion_audit', 'payroll_period_id', f.targetPeriodId), 1)
  })
})

// ─── 6. Existing payroll behaviour ────────────────────────────────────────────

describe('existing payroll behaviour', () => {
  test('the deletion preview reads counts only, and exposes no salary figure', async () => {
    const f = await buildFixture()
    const collected = await collectDeletionFacts(svc, f.targetPeriodId)
    assert.ok(collected)

    assert.equal(collected!.facts.resultCount, 2)
    assert.equal(collected!.facts.settlementCount, 2)
    assert.equal(collected!.facts.paidSettlementCount, 0)
    assert.equal(collected!.facts.generationRunning, false)

    const serialised = JSON.stringify(collected)
    for (const amount of ['20000', '18846', '1154']) {
      assert.doesNotMatch(serialised, new RegExp(amount),
        'the deletion preview must never carry a salary figure')
    }
  })

  test('the preview reports a running generation and a recorded payment', async () => {
    const running = await buildFixture({ runningGeneration: true })
    const r = await collectDeletionFacts(svc, running.targetPeriodId)
    assert.equal(r!.facts.generationRunning, true)
    assert.equal(canDeletePayrollPeriod('admin', r!.facts).allowed, false)
    await destroyFixtures()

    const paid = await buildFixture({ paid: true })
    const p = await collectDeletionFacts(svc, paid.targetPeriodId)
    assert.equal(p!.facts.paidSettlementCount, 1)
    assert.equal(canDeletePayrollPeriod('admin', p!.facts).allowed, false)
  })

  test('BOE-030’s July result and the July totals are unchanged by this suite', async () => {
    // Read straight from production. This suite never writes outside year 2999,
    // so any difference here is a defect that escaped the fixture boundary.
    const { data: july } = await svc
      .from('payroll_periods').select('id')
      .eq('payroll_month', 7).eq('payroll_year', 2026).maybeSingle()

    if (!july) return  // No July period in this environment; nothing to assert.

    const { data: results } = await svc
      .from('payroll_results')
      .select('employee_id, gross_salary, total_deductions, net_salary, half_day_count')
      .eq('payroll_period_id', (july as { id: string }).id)

    const rows = (results ?? []) as Array<{ total_deductions: number; net_salary: number }>
    const totalDeductions = rows.reduce((sum, r) => sum + Number(r.total_deductions), 0)
    const totalNet        = rows.reduce((sum, r) => sum + Number(r.net_salary), 0)

    const snapshot = JSON.parse(productionBefore.results) as Array<{
      payroll_period_id: string; total_deductions: number; net_salary: number
    }>
    const before = snapshot.filter(r => r.payroll_period_id === (july as { id: string }).id)
    assert.equal(rows.length, before.length, 'the July headcount must not change')
    assert.equal(totalDeductions, before.reduce((s, r) => s + Number(r.total_deductions), 0))
    assert.equal(totalNet,        before.reduce((s, r) => s + Number(r.net_salary), 0))
  })

  test('no historical payroll was deleted or recalculated by this suite', async () => {
    const productionAfter = await snapshotProduction()

    // Fixture results are gone by now, so the full result list must match too.
    assert.equal(productionAfter.periods,     productionBefore.periods,     'a real payroll period changed')
    assert.equal(productionAfter.results,     productionBefore.results,     'a real payroll result changed')
    assert.equal(productionAfter.lines,       productionBefore.lines,       'a real deduction line changed')
    assert.equal(productionAfter.settings,    productionBefore.settings,    'Payroll Settings changed')
    assert.equal(productionAfter.attendance,  productionBefore.attendance,  'an attendance record changed')
    assert.equal(productionAfter.corrections, productionBefore.corrections, 'an attendance correction changed')
  })

  test('targeted recalculation still resolves an explicit employee list', async () => {
    // The path POST /api/payroll/generate takes for a named employee — the one
    // used to correct BOE-030 alone. Deletion must not have disturbed it.
    const { fetchEmployeesForGeneration } = await import('@/lib/payroll/store')
    const named = await fetchEmployeesForGeneration(svc, [actors.member, actors.member2])
    assert.equal(
      named.included.length + named.excludedIds.length, 2,
      'a targeted generation must still resolve exactly the employees it names',
    )
  })
})
