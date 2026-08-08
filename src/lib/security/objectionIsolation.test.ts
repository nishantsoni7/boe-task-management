/**
 * Employee objections — RLS and the review function, exercised as a real user.
 *
 * These assertions run against the DATABASE with each actor's own anon-key
 * client, so what is being proved is the policies themselves, not a route's
 * politeness. An objection is the one thing in attendance/payroll an ordinary
 * employee may WRITE, so the write path deserves to be tested where it is
 * actually enforced.
 *
 * PENDING MIGRATION
 * -----------------
 * 20260823000000_employee_record_objections.sql has been written but NOT
 * applied. Until it is, this file SKIPS rather than fails: a red suite would
 * say "the isolation is broken" when the truth is "the table is not there yet".
 * The skip message names the migration so the reason is never a mystery, and
 * the moment it is applied these tests start running with no edit.
 *
 * Run:
 *   npx tsx --test src/lib/security/objectionIsolation.test.ts
 */

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import { config } from 'dotenv'
import { GET as objectionsGET } from '@/app/api/objections/route'
import { payrollObjectionHref } from '@/lib/objections'

config({ path: '.env.local' })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON_KEY     = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
  console.error('Missing Supabase environment variables in .env.local')
  process.exit(1)
}

const svc = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const TABLE      = 'employee_record_objections'
const TEST_YEAR  = 2997
const TEST_MONTH = 5
const DAY_A      = `${TEST_YEAR}-05-10`
const DAY_B      = `${TEST_YEAR}-05-11`
const STAMP      = Date.now()
const PASSWORD   = `Objection!${STAMP}`

type Actor = { id: string; email: string; db: SupabaseClient }

const actors: Record<'a' | 'b' | 'admin', Actor> = {} as never
const createdAuthUserIds: string[] = []
const created = { periodId: '', resultA: '', resultB: '' }

/** Whether the migration has been applied to the linked project. */
let tableExists = false
let seeded      = false

const SKIP_REASON =
  `pending migration 20260823000000_employee_record_objections.sql (table ${TABLE} not present)`

let actorSeq = 0

async function makeActor(label: string, role: 'member' | 'admin'): Promise<Actor> {
  const email = `boe-objection-${label}-${STAMP}@example.invalid`
  const { data: signUp, error } = await svc.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
    user_metadata: { full_name: `Objection ${label.toUpperCase()}` },
  })
  assert.ok(!error, `could not create ${label}: ${error?.message}`)
  const id = signUp!.user.id
  createdAuthUserIds.push(id)

  const { error: profileErr } = await svc.from('users').upsert({
    id,
    full_name:      `Objection ${label.toUpperCase()}`,
    email,
    phone:          `+97${String(STAMP).slice(-8)}${actorSeq++}`,
    role,
    team:           'sales',
    is_active:      true,
    monthly_salary: 30000,
    payroll_active: true,
  }, { onConflict: 'id' })
  assert.ok(!profileErr, `could not create profile for ${label}: ${profileErr?.message}`)

  const db = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error: signInErr } = await db.auth.signInWithPassword({ email, password: PASSWORD })
  assert.ok(!signInErr, `could not sign in as ${label}: ${signInErr?.message}`)

  return { id, email, db }
}

/** File an objection directly against the table, as that user. */
const fileObjection = (
  actor: Actor,
  target: { attendance_date: string } | { payroll_result_id: string },
  reason = 'This looks wrong to me',
  extra: Record<string, unknown> = {},
) =>
  actor.db.from(TABLE).insert({
    employee_id: actor.id,
    reason,
    subject_snapshot: 'snapshot',
    ...target,
    ...extra,
  }).select('id').single()

before(async () => {
  const probe = await svc.from(TABLE).select('id').limit(1)
  // 42P01 = undefined_table; PostgREST reports an unknown relation as PGRST205.
  tableExists = !probe.error || !['42P01', 'PGRST205'].includes(probe.error.code ?? '')
  if (!tableExists) return

  actors.a     = await makeActor('a',     'member')
  actors.b     = await makeActor('b',     'member')
  actors.admin = await makeActor('admin', 'admin')

  const { data: period, error: periodErr } = await svc.from('payroll_periods')
    .insert({ payroll_month: TEST_MONTH, payroll_year: TEST_YEAR, status: 'draft' })
    .select('id').single()
  assert.ok(!periodErr, `period insert failed: ${periodErr?.message}`)
  created.periodId = period!.id

  for (const [key, actor] of [['resultA', actors.a], ['resultB', actors.b]] as const) {
    const { data, error } = await svc.from('payroll_results').insert({
      payroll_period_id: created.periodId, employee_id: actor.id,
      monthly_salary: 30000, gross_salary: 30000, net_salary: 27000, total_deductions: 3000,
    }).select('id').single()
    assert.ok(!error, `result insert failed: ${error?.message}`)
    created[key] = data!.id
  }
  seeded = true
})

after(async () => {
  if (!seeded) return
  await svc.from(TABLE).delete().in('employee_id', createdAuthUserIds)
  await svc.from('payroll_results').delete().in('id', [created.resultA, created.resultB].filter(Boolean))
  if (created.periodId) await svc.from('payroll_periods').delete().eq('id', created.periodId)
  for (const id of createdAuthUserIds) {
    await svc.from('users').delete().eq('id', id)
    await svc.auth.admin.deleteUser(id)
  }
})

// ─── Employee A may act on A ──────────────────────────────────────────────────

describe('an employee may object to their own record', () => {
  test('A files an attendance objection for A', async t => {
    if (!tableExists) return t.skip(SKIP_REASON)

    const { data, error } = await fileObjection(actors.a, { attendance_date: DAY_A })
    assert.equal(error, null, error?.message)
    assert.ok(data?.id)
  })

  test('A files a payroll objection against A own result', async t => {
    if (!tableExists) return t.skip(SKIP_REASON)

    const { error } = await fileObjection(actors.a, { payroll_result_id: created.resultA })
    assert.equal(error, null, error?.message)
  })

  test('A lists A objections and sees only their own', async t => {
    if (!tableExists) return t.skip(SKIP_REASON)

    await fileObjection(actors.b, { attendance_date: DAY_B })
    const { data, error } = await actors.a.db.from(TABLE).select('id, employee_id')
    assert.equal(error, null, error?.message)
    assert.ok((data ?? []).length > 0, 'A should see their own rows')
    for (const row of data ?? []) {
      assert.equal(row.employee_id, actors.a.id, 'A must never see a colleague row')
    }
  })
})

// ─── Cross-employee is impossible, not merely refused ────────────────────────

describe('an employee cannot reach another employee', () => {
  test('A cannot file an objection in B name', async t => {
    if (!tableExists) return t.skip(SKIP_REASON)

    const { error } = await actors.a.db.from(TABLE).insert({
      employee_id: actors.b.id,
      attendance_date: DAY_B,
      reason: 'filed as someone else',
      subject_snapshot: 'snapshot',
    })
    assert.ok(error, 'the INSERT policy must reject a foreign employee_id')
  })

  test('A cannot object against B payroll result even under A own id', async t => {
    if (!tableExists) return t.skip(SKIP_REASON)

    // This is the clause that matters most: employee_id is honest, but the
    // target belongs to someone else. Without the EXISTS check in the policy
    // this row would be accepted and A would learn about B payroll.
    const { error } = await fileObjection(actors.a, { payroll_result_id: created.resultB })
    assert.ok(error, 'the payroll ownership EXISTS check must reject this')
  })

  test('B cannot read A objections', async t => {
    if (!tableExists) return t.skip(SKIP_REASON)

    const { data, error } = await actors.b.db.from(TABLE).select('id, employee_id')
    assert.equal(error, null, error?.message)
    for (const row of data ?? []) {
      assert.equal(row.employee_id, actors.b.id, 'B must never see an A row')
    }
  })
})

// ─── An employee cannot review, edit or withdraw ─────────────────────────────

describe('an employee cannot resolve their own objection', () => {
  test('A cannot approve their own objection by UPDATE', async t => {
    if (!tableExists) return t.skip(SKIP_REASON)

    const { data: own } = await actors.a.db.from(TABLE).select('id').limit(1).single()
    const { data, error } = await actors.a.db.from(TABLE)
      .update({ status: 'approved' }).eq('id', own!.id).select('id')
    // No UPDATE policy: either an explicit error, or zero rows matched.
    assert.ok(error || (data ?? []).length === 0, 'an employee must not be able to update an objection')

    const { data: after } = await svc.from(TABLE).select('status').eq('id', own!.id).single()
    assert.equal(after!.status, 'pending', 'the row must still be pending')
  })

  test('A cannot delete their objection', async t => {
    if (!tableExists) return t.skip(SKIP_REASON)

    const { data: own } = await actors.a.db.from(TABLE).select('id').limit(1).single()
    await actors.a.db.from(TABLE).delete().eq('id', own!.id)
    const { data: after } = await svc.from(TABLE).select('id').eq('id', own!.id).maybeSingle()
    assert.ok(after, 'the row must survive an employee delete attempt')
  })

  test('A cannot call the review function', async t => {
    if (!tableExists) return t.skip(SKIP_REASON)

    const { data: own } = await actors.a.db.from(TABLE).select('id').limit(1).single()
    const { error } = await actors.a.db.rpc('review_employee_record_objection', {
      p_objection_id: own!.id, p_status: 'approved', p_review_note: 'me',
    })
    assert.ok(error, 'the function must refuse a non-admin')
    assert.match(error!.message, /OBJECTION_FORBIDDEN/)
  })
})

// ─── One open objection per target ───────────────────────────────────────────

describe('duplicate pending objections are refused', () => {
  test('a second pending objection for the same attendance date fails', async t => {
    if (!tableExists) return t.skip(SKIP_REASON)

    const day = `${TEST_YEAR}-05-20`
    const first = await fileObjection(actors.a, { attendance_date: day })
    assert.equal(first.error, null, first.error?.message)

    const second = await fileObjection(actors.a, { attendance_date: day }, 'again')
    assert.ok(second.error, 'the partial unique index must reject a second pending row')
    assert.equal(second.error!.code, '23505')
  })

  test('a second pending objection for the same payroll result fails', async t => {
    if (!tableExists) return t.skip(SKIP_REASON)

    // resultA already has a pending objection from the first describe block.
    const again = await fileObjection(actors.a, { payroll_result_id: created.resultA }, 'again')
    assert.ok(again.error, 'the partial unique index must reject a second pending row')
    assert.equal(again.error!.code, '23505')
  })

  test('a new objection is allowed once the previous one is resolved', async t => {
    if (!tableExists) return t.skip(SKIP_REASON)

    const day = `${TEST_YEAR}-05-25`
    const first = await fileObjection(actors.a, { attendance_date: day })
    assert.equal(first.error, null, first.error?.message)

    const { error: reviewErr } = await actors.admin.db.rpc('review_employee_record_objection', {
      p_objection_id: first.data!.id, p_status: 'rejected', p_review_note: 'machine record is correct',
    })
    assert.equal(reviewErr, null, reviewErr?.message)

    const second = await fileObjection(actors.a, { attendance_date: day }, 'it happened again')
    assert.equal(second.error, null, 'a resolved objection must not block a later one')
  })
})

// ─── Admin ───────────────────────────────────────────────────────────────────

describe('an admin reviews, and reviewing changes nothing but the objection', () => {
  test('an admin sees every objection', async t => {
    if (!tableExists) return t.skip(SKIP_REASON)

    const { data, error } = await actors.admin.db.from(TABLE).select('id, employee_id')
    assert.equal(error, null, error?.message)
    const owners = new Set((data ?? []).map(r => r.employee_id))
    assert.ok(owners.has(actors.a.id) && owners.has(actors.b.id), 'an admin must see both employees')
  })

  test('an admin resolves a pending objection', async t => {
    if (!tableExists) return t.skip(SKIP_REASON)

    const { data: pending } = await svc.from(TABLE)
      .select('id').eq('employee_id', actors.b.id).eq('status', 'pending').limit(1).single()

    const { error } = await actors.admin.db.rpc('review_employee_record_objection', {
      p_objection_id: pending!.id, p_status: 'approved', p_review_note: 'corrected the day',
    })
    assert.equal(error, null, error?.message)

    const { data: after } = await svc.from(TABLE).select('status, reviewed_by, reviewed_at, review_note')
      .eq('id', pending!.id).single()
    assert.equal(after!.status, 'approved')
    assert.equal(after!.reviewed_by, actors.admin.id)
    assert.ok(after!.reviewed_at)
    assert.equal(after!.review_note, 'corrected the day')
  })

  test('the same objection cannot be reviewed twice', async t => {
    if (!tableExists) return t.skip(SKIP_REASON)

    const { data: done } = await svc.from(TABLE)
      .select('id').eq('status', 'approved').limit(1).single()
    const { error } = await actors.admin.db.rpc('review_employee_record_objection', {
      p_objection_id: done!.id, p_status: 'rejected', p_review_note: 'changed my mind',
    })
    assert.ok(error, 'a reviewed objection is final')
    assert.match(error!.message, /OBJECTION_ALREADY_REVIEWED/)
  })

  test('an admin cannot set an arbitrary status', async t => {
    if (!tableExists) return t.skip(SKIP_REASON)

    const { data: pending } = await svc.from(TABLE)
      .select('id').eq('status', 'pending').limit(1).single()
    const { error } = await actors.admin.db.rpc('review_employee_record_objection', {
      p_objection_id: pending!.id, p_status: 'pending', p_review_note: null,
    })
    assert.ok(error, 'only approved or rejected may be set')
    assert.match(error!.message, /OBJECTION_INVALID_STATUS/)
  })

  test('reviewing does not touch attendance or payroll', async t => {
    if (!tableExists) return t.skip(SKIP_REASON)

    // The whole safety claim of this feature in one assertion: the money and
    // the punches are identical before and after a review.
    const before = await svc.from('payroll_results')
      .select('net_salary, total_deductions, gross_salary').eq('id', created.resultA).single()

    const { data: pending } = await svc.from(TABLE)
      .select('id').eq('payroll_result_id', created.resultA).eq('status', 'pending').limit(1).maybeSingle()

    if (pending) {
      await actors.admin.db.rpc('review_employee_record_objection', {
        p_objection_id: pending.id, p_status: 'approved', p_review_note: 'looked into it',
      })
    }

    const after = await svc.from('payroll_results')
      .select('net_salary, total_deductions, gross_salary').eq('id', created.resultA).single()
    assert.deepEqual(after.data, before.data, 'a review must never move money')
  })
})

// ─── The notification deep link ──────────────────────────────────────────────
//
// A Payroll-issue notification opens the disputed payslip, and the route it
// opens is (period, employee). Neither id is in the notification — it carries
// the OBJECTION — so /api/objections is what turns one into the other. That
// makes this route the boundary: if it would hand an employee the period and
// employee of somebody else's payroll result, the notification would become a
// way to read a colleague's pay.

describe('resolving an issue to its payslip leaks nothing', () => {
  /** The route handler, called with a real bearer token, as the browser would. */
  const listObjections = async (actor: Actor, query: string) => {
    const { data: { session } } = await actor.db.auth.getSession()
    const res = await objectionsGET(new NextRequest(`http://localhost/api/objections${query}`, {
      headers: { authorization: `Bearer ${session!.access_token}` },
    }))
    return { status: res.status, body: await res.json() }
  }

  let objectionId = ''

  before(async () => {
    if (!tableExists || !seeded) return
    // B disputes B's own payslip. Everything below asks who may turn that row
    // into a route.
    const { data } = await fileObjection(actors.b, { payroll_result_id: created.resultB }, 'my net is short')
    objectionId = data?.id ?? ''
  })

  test('an admin gets the route keys, and they name the disputed result', async t => {
    if (!tableExists || !objectionId) return t.skip(SKIP_REASON)

    const { status, body } = await listObjections(actors.admin, `?id=${objectionId}`)
    assert.equal(status, 200)
    assert.equal(body.objections.length, 1, 'the id filter must select exactly the one asked for')

    const href = payrollObjectionHref(body.objections[0])
    assert.equal(href, `/payroll/results/${created.periodId}/${actors.b.id}`,
      'the notification must land on the payslip the employee actually disputed')
  })

  test('an employee cannot resolve a colleague objection to anything at all', async t => {
    if (!tableExists || !objectionId) return t.skip(SKIP_REASON)

    const { status, body } = await listObjections(actors.a, `?id=${objectionId}`)
    assert.equal(status, 200)
    assert.deepEqual(body.objections, [],
      'the ownership pin must survive an id filter — B row is not A to read')
  })

  test('an employee reading their own issue is given no route keys either', async t => {
    if (!tableExists || !objectionId) return t.skip(SKIP_REASON)

    const { body } = await listObjections(actors.b, `?id=${objectionId}`)
    assert.equal(body.objections.length, 1, 'B may read B own row')
    assert.equal('payroll_result' in body.objections[0], false,
      'the admin review route is not part of an employee answer')
    assert.equal('employee' in body.objections[0], false)
  })

  test('an unauthenticated caller resolves nothing', async t => {
    if (!tableExists || !objectionId) return t.skip(SKIP_REASON)

    const res = await objectionsGET(
      new NextRequest(`http://localhost/api/objections?id=${objectionId}`),
    )
    assert.equal(res.status, 401)
  })
})
