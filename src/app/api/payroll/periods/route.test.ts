/**
 * POST/GET /api/payroll/periods — behavioural tests
 *
 * Two independent behaviours, two suites:
 *
 * 1. create/reuse/locked — the branching added so HR can re-trigger payroll
 *    generation for a month after re-uploading corrected attendance, without
 *    the endpoint hard-blocking with "period already exists". Exercises
 *    getOrCreatePayrollPeriod() directly against a real Supabase database
 *    (service-role client, same pattern as src/lib/payroll/smoke.ts). Uses a
 *    dedicated far-future year so it can never collide with real payroll
 *    data, and deletes every row it creates when done.
 *
 * 2. computeOutOfDate — the "attendance changed after payroll was generated"
 *    staleness flag. This is pure data-in/data-out logic (no DB calls), so
 *    it's tested with fabricated timestamps instead — faster and doesn't
 *    need real attendance/generation rows.
 *
 * Auth/role checks are not covered here since they're identical to every
 * other admin route in this app; these suites are scoped to the new
 * behaviour only.
 *
 * Run:
 *   npx tsx --test src/app/api/payroll/periods/route.test.ts
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local
 * (only for suite 1 — suite 2 needs no environment/DB access).
 */

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { getOrCreatePayrollPeriod, computeOutOfDate } from './route'

config({ path: '.env.local' })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

describe('POST /api/payroll/periods — create/reuse/locked', () => {
  // Test isolation: a year far outside any real payroll data so this can
  // never collide with real HR records. The month is derived from the
  // current timestamp (not hardcoded) purely so two runs launched close
  // together don't contend over the exact same row while each is mid-test.
  const TEST_YEAR = 2999
  const TEST_MONTH = (new Date().getTime() % 12) + 1

  const createdPeriodIds: string[] = []

  before(async () => {
    // Defensive cleanup in case a prior interrupted run left a row behind.
    await svc.from('payroll_periods').delete()
      .eq('payroll_month', TEST_MONTH).eq('payroll_year', TEST_YEAR)
  })

  after(async () => {
    if (createdPeriodIds.length === 0) return
    await svc.from('payroll_periods').delete().in('id', createdPeriodIds)
  })

  test('creating a period for a new month/year returns "created" and persists a draft row', async () => {
    const result = await getOrCreatePayrollPeriod(svc, TEST_MONTH, TEST_YEAR)

    assert.equal(result.outcome, 'created')
    if (result.outcome !== 'created') return
    createdPeriodIds.push(result.period.id)

    assert.equal(result.period.payroll_month, TEST_MONTH)
    assert.equal(result.period.payroll_year, TEST_YEAR)
    assert.equal(result.period.status, 'draft')

    const { data: row } = await svc.from('payroll_periods').select('*').eq('id', result.period.id).single()
    assert.ok(row, 'period row was actually persisted')
  })

  test('creating a period again for the same Draft month/year returns "reused" with the same row (no duplicate)', async () => {
    const result = await getOrCreatePayrollPeriod(svc, TEST_MONTH, TEST_YEAR)

    assert.equal(result.outcome, 'reused')
    if (result.outcome !== 'reused') return
    assert.equal(result.period.id, createdPeriodIds[0], 'must return the existing row, not a new one')

    const { data: rows } = await svc.from('payroll_periods').select('id')
      .eq('payroll_month', TEST_MONTH).eq('payroll_year', TEST_YEAR)
    assert.equal(rows?.length, 1, 'exactly one row should exist for this month/year')
  })

  test('creating a period again for the same Generated (not locked) month/year still returns "reused"', async () => {
    await svc.from('payroll_periods').update({ status: 'generated' }).eq('id', createdPeriodIds[0])

    const result = await getOrCreatePayrollPeriod(svc, TEST_MONTH, TEST_YEAR)

    assert.equal(result.outcome, 'reused')
    if (result.outcome !== 'reused') return
    assert.equal(result.period.id, createdPeriodIds[0])
    assert.equal(result.period.status, 'generated')
  })

  test('creating a period for a Locked month/year returns "locked" (blocked, no row returned)', async () => {
    await svc.from('payroll_periods').update({ status: 'locked' }).eq('id', createdPeriodIds[0])

    const result = await getOrCreatePayrollPeriod(svc, TEST_MONTH, TEST_YEAR)

    assert.equal(result.outcome, 'locked')

    const { data: rows } = await svc.from('payroll_periods').select('id')
      .eq('payroll_month', TEST_MONTH).eq('payroll_year', TEST_YEAR)
    assert.equal(rows?.length, 1, 'locked guard must not create a duplicate row')
  })
})

describe('computeOutOfDate — attendance-vs-generation staleness', () => {
  const PERIOD = { id: 'period-june', payroll_month: 6, payroll_year: 2026 }

  test('attendance updated after generation → out of date', () => {
    const result = computeOutOfDate(
      [PERIOD],
      { [PERIOD.id]: '2026-07-01T09:00:00.000Z' },
      [{ attendance_date: '2026-06-15', updated_at: '2026-07-01T10:00:00.000Z' }],
    )
    assert.equal(result[PERIOD.id], true)
  })

  test('attendance untouched since generation → not out of date', () => {
    const result = computeOutOfDate(
      [PERIOD],
      { [PERIOD.id]: '2026-07-01T09:00:00.000Z' },
      [{ attendance_date: '2026-06-15', updated_at: '2026-06-20T08:00:00.000Z' }],
    )
    assert.equal(result[PERIOD.id], false)
  })

  test('attendance updated exactly at generation time → not out of date (strictly-after only)', () => {
    const result = computeOutOfDate(
      [PERIOD],
      { [PERIOD.id]: '2026-07-01T09:00:00.000Z' },
      [{ attendance_date: '2026-06-15', updated_at: '2026-07-01T09:00:00.000Z' }],
    )
    assert.equal(result[PERIOD.id], false)
  })

  test('attendance rows outside the period\'s month are ignored', () => {
    const result = computeOutOfDate(
      [PERIOD],
      { [PERIOD.id]: '2026-07-01T09:00:00.000Z' },
      [
        { attendance_date: '2026-07-02', updated_at: '2026-07-05T00:00:00.000Z' }, // next month
        { attendance_date: '2026-05-31', updated_at: '2026-07-05T00:00:00.000Z' }, // prior month
      ],
    )
    assert.equal(result[PERIOD.id], false)
  })

  test('period with no attendance rows at all → not out of date', () => {
    const result = computeOutOfDate([PERIOD], { [PERIOD.id]: '2026-07-01T09:00:00.000Z' }, [])
    assert.equal(result[PERIOD.id], false)
  })

  test('December month-boundary rolls into next year correctly', () => {
    const decPeriod = { id: 'period-dec', payroll_month: 12, payroll_year: 2026 }
    const result = computeOutOfDate(
      [decPeriod],
      { [decPeriod.id]: '2027-01-01T00:00:00.000Z' },
      [
        { attendance_date: '2027-01-01', updated_at: '2027-01-02T00:00:00.000Z' }, // Jan 1 — not December, must be excluded
        { attendance_date: '2026-12-31', updated_at: '2026-12-31T23:00:00.000Z' }, // in range, before generation
      ],
    )
    assert.equal(result[decPeriod.id], false)
  })
})
