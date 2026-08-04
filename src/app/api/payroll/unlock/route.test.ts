/**
 * POST /api/payroll/unlock — the transition itself, against a real database.
 *
 * Exercises unlockPayrollPeriod() directly with a service-role client, the same
 * arrangement as ../periods/route.test.ts. Auth and role are not covered here —
 * they are pure and covered in src/lib/payroll/unlockRules.test.ts, and are
 * identical to every other admin payroll route.
 *
 * Isolation: a payroll period in a far-future year that can never collide with
 * real payroll data, plus one payroll_results row attached to an existing user.
 * Everything created is deleted afterwards.
 *
 * Run:
 *   npx tsx --test src/app/api/payroll/unlock/route.test.ts
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local,
 * and migration 20260811000000_payroll_period_status_events.sql applied.
 */

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { unlockPayrollPeriod } from './route'

config({ path: '.env.local' })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

describe('unlockPayrollPeriod', () => {
  const TEST_YEAR = 2998
  const TEST_MONTH = (new Date().getTime() % 12) + 1
  const REASON = 'Attendance correction approved after finalisation.'

  let periodId = ''
  let adminId = ''
  let resultId = ''
  /** The figures written before the lock, to compare against after the unlock. */
  const NET_SALARY = 41234.56

  before(async () => {
    // Defensive cleanup in case a prior interrupted run left rows behind.
    const { data: stale } = await svc.from('payroll_periods').select('id')
      .eq('payroll_month', TEST_MONTH).eq('payroll_year', TEST_YEAR)
    for (const row of stale ?? []) {
      await svc.from('payroll_results').delete().eq('payroll_period_id', row.id)
      await svc.from('payroll_periods').delete().eq('id', row.id)
    }

    const { data: admin } = await svc.from('users').select('id').eq('role', 'admin').limit(1).single()
    assert.ok(admin, 'an admin user must exist to act as the unlocking actor')
    adminId = admin.id

    const { data: period, error: periodErr } = await svc.from('payroll_periods')
      .insert({ payroll_month: TEST_MONTH, payroll_year: TEST_YEAR, status: 'locked', locked_by: adminId, locked_at: new Date().toISOString() })
      .select('id').single()
    assert.ok(!periodErr, `test period insert failed: ${periodErr?.message}`)
    periodId = period!.id

    const { data: result, error: resultErr } = await svc.from('payroll_results')
      .insert({
        payroll_period_id: periodId,
        employee_id:       adminId,
        monthly_salary:    50000,
        net_salary:        NET_SALARY,
        total_deductions:  8765.44,
      })
      .select('id').single()
    assert.ok(!resultErr, `test payroll result insert failed: ${resultErr?.message}`)
    resultId = result!.id
  })

  after(async () => {
    if (resultId) await svc.from('payroll_results').delete().eq('id', resultId)
    // payroll_period_status_events cascades with the period.
    if (periodId) await svc.from('payroll_periods').delete().eq('id', periodId)
  })

  test('an admin can unlock a locked payroll period, and it reopens as generated', async () => {
    const result = await unlockPayrollPeriod(svc, {
      periodId, actorId: adminId, actorName: 'Test Admin', reason: REASON,
    })

    assert.equal(result.outcome, 'unlocked')
    if (result.outcome !== 'unlocked') return
    assert.equal(result.previous_status, 'locked')
    assert.equal(result.new_status, 'generated')

    const { data: row } = await svc.from('payroll_periods')
      .select('status, locked_at, locked_by').eq('id', periodId).single()
    assert.equal(row?.status, 'generated', 'the period must actually be reopened in the database')
  })

  test('the original locking record is preserved, not cleared', async () => {
    const { data: row } = await svc.from('payroll_periods')
      .select('locked_at, locked_by').eq('id', periodId).single()
    assert.ok(row?.locked_at, 'locked_at must survive the unlock')
    assert.equal(row?.locked_by, adminId, 'locked_by must survive the unlock')
  })

  test('the payroll results are untouched by the unlock', async () => {
    const { data: results } = await svc.from('payroll_results')
      .select('id, net_salary, total_deductions').eq('payroll_period_id', periodId)

    assert.equal(results?.length, 1, 'the result row must still exist')
    assert.equal(results![0].id, resultId, 'it must be the same row, not a regenerated one')
    assert.equal(Number(results![0].net_salary), NET_SALARY, 'net salary must be unchanged')
  })

  test('an audit entry is created with the reason, the actor and both statuses', async () => {
    const { data: events } = await svc.from('payroll_period_status_events')
      .select('event, previous_status, new_status, actor_id, actor_name, reason, created_at')
      .eq('payroll_period_id', periodId)
      .eq('event', 'unlocked')

    assert.equal(events?.length, 1, 'exactly one unlock event must be recorded')
    const e = events![0]
    assert.equal(e.previous_status, 'locked')
    assert.equal(e.new_status, 'generated')
    assert.equal(e.actor_id, adminId)
    assert.equal(e.actor_name, 'Test Admin')
    assert.equal(e.reason, REASON)
    assert.ok(e.created_at, 'the event must be timestamped')
  })

  test('a period that is no longer locked cannot be unlocked again', async () => {
    const result = await unlockPayrollPeriod(svc, {
      periodId, actorId: adminId, actorName: 'Test Admin', reason: 'second attempt',
    })

    assert.equal(result.outcome, 'not_locked')
    if (result.outcome !== 'not_locked') return
    assert.equal(result.status, 'generated')

    // And no second audit row was written for a transition that did not happen.
    const { data: events } = await svc.from('payroll_period_status_events')
      .select('id').eq('payroll_period_id', periodId).eq('event', 'unlocked')
    assert.equal(events?.length, 1, 'a refused unlock must not add an audit entry')
  })

  test('a draft period cannot be unlocked', async () => {
    await svc.from('payroll_periods').update({ status: 'draft' }).eq('id', periodId)
    const result = await unlockPayrollPeriod(svc, {
      periodId, actorId: adminId, actorName: 'Test Admin', reason: REASON,
    })
    assert.equal(result.outcome, 'not_locked')

    const { data: row } = await svc.from('payroll_periods').select('status').eq('id', periodId).single()
    assert.equal(row?.status, 'draft', 'a refused unlock must leave the status alone')
  })

  test('an unknown payroll period id reports not found rather than failing', async () => {
    const result = await unlockPayrollPeriod(svc, {
      periodId: '00000000-0000-0000-0000-000000000000',
      actorId: adminId, actorName: 'Test Admin', reason: REASON,
    })
    assert.equal(result.outcome, 'not_found')
  })

  test('two unlocks racing on the same period produce one unlock and one conflict', async () => {
    await svc.from('payroll_periods').update({ status: 'locked' }).eq('id', periodId)

    const [a, b] = await Promise.all([
      unlockPayrollPeriod(svc, { periodId, actorId: adminId, actorName: 'A', reason: REASON }),
      unlockPayrollPeriod(svc, { periodId, actorId: adminId, actorName: 'B', reason: REASON }),
    ])

    const outcomes = [a.outcome, b.outcome].sort()
    // The loser either lost the conditional UPDATE ('conflict') or read the
    // already-reopened row ('not_locked'); both refuse without writing.
    assert.equal(outcomes.filter(o => o === 'unlocked').length, 1,
      `exactly one unlock should win, got ${outcomes.join(' + ')}`)
    assert.ok(outcomes.some(o => o === 'conflict' || o === 'not_locked'),
      `the loser must be refused, got ${outcomes.join(' + ')}`)

    const { data: events } = await svc.from('payroll_period_status_events')
      .select('id').eq('payroll_period_id', periodId).eq('event', 'unlocked')
    assert.equal(events?.length, 2, 'one more unlock event than before, not two')
  })
})
