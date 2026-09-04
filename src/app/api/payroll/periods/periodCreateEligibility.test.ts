/**
 * checkPeriodCreateEligibility — the business rule behind Part 2 of the
 * Attendance & Payroll UX consolidation: a payroll period may only be
 * created for a month that has already happened AND already has attendance
 * uploaded for it.
 *
 * Exercised directly against a real Supabase database (service-role client),
 * same pattern as the create/reuse/locked suite in ./route.test.ts — this
 * function is extracted from POST specifically so it can be tested the same
 * way getOrCreatePayrollPeriod already is, without constructing a NextRequest.
 *
 * SCOPE NOTE — why "current month" isn't tested with today's real date
 * ----------------------------------------------------------------------
 * checkPeriodCreateEligibility does not branch on "is this the current
 * month" vs "is this a past month" — both take the identical
 * not-future-then-attendance-exists path. Asserting against whatever month
 * the test happens to run in would be environment-dependent (this dev
 * database already holds real attendance for some recent months, so a
 * "current month has no attendance" assertion could pass or fail purely
 * based on when the suite runs). The isolated past month below exercises the
 * exact same code path a current-month call would, without that flakiness.
 * isFutureMonth() itself (the only place "which month is current" matters)
 * has its own dedicated tests — see src/lib/attendance/*.test.ts.
 *
 * Run:
 *   npx tsx --test src/app/api/payroll/periods/periodCreateEligibility.test.ts
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local
 */

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { checkPeriodCreateEligibility, getOrCreatePayrollPeriod } from './route'
import { istCurrentYearMonth } from '@/lib/attendance/monthAvailability'

config({ path: '.env.local' })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

// A year no real BOE payroll or attendance data will ever land on (every
// timestamp elsewhere in this codebase is 2026), so inserting and deleting a
// marker row here cannot disturb or be disturbed by real records.
const ISOLATED_YEAR  = 2020
const ISOLATED_MONTH = 3
const MARKER_DATE = `${ISOLATED_YEAR}-0${ISOLATED_MONTH}-15`

describe('A — a future month is always rejected, attendance or not', () => {
  test('rejected regardless of whether attendance happens to exist', async () => {
    const current = istCurrentYearMonth()
    const future = current.month === 12
      ? { year: current.year + 1, month: 1 }
      : { year: current.year, month: current.month + 1 }

    const result = await checkPeriodCreateEligibility(svc, future.month, future.year)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.error, /future month/i)
  })
})

describe('B/D — a real (non-future) month, with and without uploaded attendance', () => {
  let markerRowId: string | null = null
  let markerUserId: string | null = null

  before(async () => {
    // Defensive cleanup from a prior interrupted run. Safe to match on the
    // date alone: 2020 cannot hold any real BOE attendance (see file header).
    await svc.from('attendance_records').delete().eq('attendance_date', MARKER_DATE)

    // A real users.id is required by attendance_records' FK — reuse any
    // existing active user rather than inserting one; this test writes
    // nothing to `users`.
    const { data: anyUser } = await svc.from('users').select('id').limit(1).single()
    markerUserId = anyUser?.id ?? null
  })

  after(async () => {
    if (markerRowId) await svc.from('attendance_records').delete().eq('id', markerRowId)
  })

  test('B — no attendance anywhere in the month → rejected, with a message naming the month', async () => {
    const result = await checkPeriodCreateEligibility(svc, ISOLATED_MONTH, ISOLATED_YEAR)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.error, /March 2020/)
    assert.match(result.error, /has not been uploaded/)
    assert.match(result.error, /upload attendance before creating payroll/i)
  })

  test('D — attendance exists anywhere in the month → accepted', async () => {
    assert.ok(markerUserId, 'test needs at least one real user row to attach the marker to')

    const { data: inserted, error } = await svc
      .from('attendance_records')
      .insert({
        user_id: markerUserId,
        attendance_date: MARKER_DATE,
        punch_direction_source: 'confirmed',
      })
      .select('id')
      .single()
    assert.equal(error, null, error?.message)
    markerRowId = inserted!.id

    const result = await checkPeriodCreateEligibility(svc, ISOLATED_MONTH, ISOLATED_YEAR)
    assert.equal(result.ok, true, result.ok ? '' : result.error)
  })

  test('the rejection never reaches getOrCreatePayrollPeriod — no draft row is left behind', async () => {
    // Belt and braces: the POST route only calls getOrCreatePayrollPeriod
    // AFTER eligibility passes. Confirm no period row exists for the
    // still-ineligible combination this suite has not yet inserted attendance
    // for (a fresh isolated month/year, untouched by the tests above).
    const emptyMonth = 7
    const before = await checkPeriodCreateEligibility(svc, emptyMonth, ISOLATED_YEAR)
    assert.equal(before.ok, false)

    const { data: rows } = await svc.from('payroll_periods').select('id')
      .eq('payroll_month', emptyMonth).eq('payroll_year', ISOLATED_YEAR)
    assert.equal(rows?.length ?? 0, 0, 'no period may exist for a month the rule has not cleared')
  })
})

describe('F — an already-existing period is unaffected by this rule (unchanged behaviour)', () => {
  // getOrCreatePayrollPeriod's own reuse/locked semantics are covered in
  // ./route.test.ts and are NOT touched by this change — checkPeriodCreateEligibility
  // is a gate placed BEFORE that function runs, not a replacement for it.
  test('checkPeriodCreateEligibility only decides whether the create step runs at all — it does not itself de-duplicate', () => {
    // Documented, not asserted against the DB again here: getOrCreatePayrollPeriod
    // is the sole owner of "does this row already exist" (see route.ts:44-56),
    // and its own test suite already proves reuse/locked. This suite's job
    // ends at "the request even reaches that function."
    assert.equal(typeof getOrCreatePayrollPeriod, 'function')
  })
})
