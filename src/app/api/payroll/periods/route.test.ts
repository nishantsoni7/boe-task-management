/**
 * POST /api/payroll/periods — behavioural tests
 *
 * Covers the create/reuse/locked branching added to allow HR to re-trigger
 * payroll generation for a month after re-uploading corrected attendance,
 * without the endpoint hard-blocking with "period already exists".
 *
 * Exercises getOrCreatePayrollPeriod() (the function POST delegates to)
 * directly against a real Supabase database, using the service-role client —
 * same pattern as src/lib/payroll/smoke.ts. Auth/role checks are not covered
 * here since they're identical to every other admin route in this app; this
 * file is scoped to the new period create-vs-reuse-vs-locked behaviour only.
 *
 * Uses a dedicated far-future year so it can never collide with real payroll
 * data, and deletes every row it creates when done — safe to run repeatedly.
 *
 * Run:
 *   npx tsx --test src/app/api/payroll/periods/route.test.ts
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { getOrCreatePayrollPeriod } from './route'

config({ path: '.env.local' })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

// Test isolation: a year far outside any real payroll data so this can never
// collide with real HR records. The month is derived from the current
// timestamp (not hardcoded) purely so two runs launched close together don't
// contend over the exact same row while each is mid-test.
const TEST_YEAR = 2999
const TEST_MONTH = (new Date().getTime() % 12) + 1

const createdPeriodIds: string[] = []

after(async () => {
  if (createdPeriodIds.length === 0) return
  await svc.from('payroll_periods').delete().in('id', createdPeriodIds)
})

before(async () => {
  // Defensive cleanup in case a prior interrupted run left a row behind.
  await svc.from('payroll_periods').delete()
    .eq('payroll_month', TEST_MONTH).eq('payroll_year', TEST_YEAR)
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
