/**
 * PATCH /api/payroll/settlement — who may write a settlement, and what a
 * refusal says.
 *
 * Why this file exists
 * --------------------
 * An admin reported "Forbidden" when saving a previous balance. The route was
 * answering four different conditions — no token, a token the auth server
 * rejected, no profile, and a genuine non-admin — with one bare 403. A stale
 * access token therefore looked exactly like a permission problem, and the
 * dialog told the admin they lacked a permission they held.
 *
 * So the assertions below are about the DISTINCTION as much as the refusal:
 * unauthenticated is 401, authenticated-but-not-admin is 403, and the two say
 * different things. A regression that collapses them again fails here.
 *
 * The handler is invoked directly with a real bearer token, as in
 * src/lib/security/attendancePayrollApiIsolation.test.ts — no dev server, and
 * the assertions are about the handler rather than about routing.
 *
 * Every actor, period and settlement row created here is torn down in `after`.
 * The sandbox period is 2021 (payroll_periods carries CHECK payroll_year >=
 * 2020) so nothing here can collide with real payroll.
 *
 * Run:
 *   npx tsx --test src/app/api/payroll/settlementAuth.test.ts
 */

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import { config } from 'dotenv'

import { PATCH as settlement } from '@/app/api/payroll/settlement/route'
import { GET as resultDetail } from '@/app/api/payroll/results/detail/route'

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

const TEST_YEAR   = 2021
const OPEN_MONTH  = 5
const LOCKED_MONTH = 6

const STAMP    = Date.now()
const PASSWORD = `SettlementAuth!${STAMP}`

type Actor = { id: string; token: string; email: string }
const actors: Record<'employee' | 'other' | 'admin', Actor> = {} as never
let actorSeq = 0

const createdAuthUserIds: string[] = []
const created = { openPeriod: '', lockedPeriod: '', result: '' }

// The stored totals the settlement figures are computed from. Chosen so every
// derived figure below is exact in two decimal places.
const GROSS      = 26_500
const DEDUCTIONS = 2_578.05
const AFTER_ATTENDANCE = GROSS - DEDUCTIONS   // 23,921.95

async function makeActor(label: string, role: 'member' | 'admin'): Promise<Actor> {
  const email = `boe-settlement-auth-${label}-${STAMP}@example.invalid`
  const { data: signUp, error } = await svc.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
    user_metadata: { full_name: `Settlement Auth ${label.toUpperCase()}` },
  })
  assert.ok(!error, `could not create ${label}: ${error?.message}`)
  const id = signUp!.user.id
  createdAuthUserIds.push(id)

  const { error: profileErr } = await svc.from('users').upsert({
    id,
    full_name:      `Settlement Auth ${label.toUpperCase()}`,
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
  const { data: session, error: signInErr } = await db.auth.signInWithPassword({ email, password: PASSWORD })
  assert.ok(!signInErr, `could not sign in as ${label}: ${signInErr?.message}`)

  return { id, email, token: session!.session!.access_token }
}

/** A PATCH exactly as the browser sends it: JSON body and a bearer token. */
function patch(body: unknown, token?: string): NextRequest {
  return new NextRequest('http://localhost/api/payroll/settlement', {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

const carryForward = (periodId: string, employeeId: string, amount: number, remark: string) =>
  ({ payroll_period_id: periodId, employee_id: employeeId, action: 'carry_forward', amount, remark })

/** The settlement row as the database holds it, or null. */
async function readSettlement(periodId: string, employeeId: string) {
  const { data } = await svc
    .from('payroll_settlements')
    .select('id, carry_forward_amount, carry_forward_is_manual, carry_forward_remark, carry_forward_set_by')
    .eq('payroll_period_id', periodId)
    .eq('employee_id', employeeId)
    .maybeSingle()
  return data
}

before(async () => {
  actors.employee = await makeActor('employee', 'member')
  actors.other    = await makeActor('other',    'member')
  actors.admin    = await makeActor('admin',    'admin')

  for (const [key, month, status] of [
    ['openPeriod',   OPEN_MONTH,   'generated'],
    ['lockedPeriod', LOCKED_MONTH, 'locked'],
  ] as const) {
    const { data, error } = await svc.from('payroll_periods')
      .insert({ payroll_month: month, payroll_year: TEST_YEAR, status })
      .select('id').single()
    assert.ok(!error, `period insert failed: ${error?.message}`)
    created[key] = data!.id
  }

  // A stored result in the open period, so the settlement figures have
  // something to be computed against.
  const { data: row, error: resultErr } = await svc.from('payroll_results').insert({
    payroll_period_id:        created.openPeriod,
    employee_id:              actors.employee.id,
    monthly_salary:           30_000,
    gross_salary:             GROSS,
    total_deductions:         DEDUCTIONS,
    pending_adjustment_total: 0,
    days_present:             20,
    net_salary:               AFTER_ATTENDANCE,
  }).select('id').single()
  assert.ok(!resultErr, `result insert failed: ${resultErr?.message}`)
  created.result = row!.id
})

after(async () => {
  if (created.result) await svc.from('payroll_results').delete().eq('id', created.result)
  for (const periodId of [created.openPeriod, created.lockedPeriod].filter(Boolean)) {
    // Events cascade from the settlement row; the settlements are deleted
    // before the period so no foreign key holds the period back.
    await svc.from('payroll_settlements').delete().eq('payroll_period_id', periodId)
    await svc.from('payroll_periods').delete().eq('id', periodId)
  }
  for (const id of createdAuthUserIds) {
    await svc.from('users').delete().eq('id', id)
    await svc.auth.admin.deleteUser(id)
  }
})

// ─── 1 & 2. Unauthenticated is not the same as unauthorised ───────────────────

describe('the settlement route separates "not signed in" from "not allowed"', () => {
  test('1. no bearer token is 401, and says the session is the problem', async () => {
    const res = await settlement(patch(carryForward(created.openPeriod, actors.employee.id, -200, 'advance')))
    assert.equal(res.status, 401, 'a missing session must not be reported as a permission failure')

    const body = await res.json()
    assert.match(body.error, /session has expired/i)
    assert.equal(body.error.includes('Forbidden'), false, 'the bare "Forbidden" must not come back')
  })

  test('1b. a token the auth server rejects is 401, not 403', async () => {
    // The exact condition an expired access token produces. It is a session
    // problem and must never be dressed up as a missing permission.
    const res = await settlement(patch(
      carryForward(created.openPeriod, actors.employee.id, -200, 'advance'),
      'not-a-real-jwt',
    ))
    assert.equal(res.status, 401)
    assert.match((await res.json()).error, /session has expired/i)
  })

  test('2. an ordinary employee is 403 with the permission sentence', async () => {
    const res = await settlement(patch(
      carryForward(created.openPeriod, actors.employee.id, -200, 'advance'),
      actors.employee.token,
    ))
    assert.equal(res.status, 403)

    const body = await res.json()
    assert.equal(body.error, 'You do not have permission to update payroll settlement details.')

    assert.equal(
      await readSettlement(created.openPeriod, actors.employee.id), null,
      'a refused write must not leave a settlement row behind',
    )
  })

  test('7. one employee cannot move a colleague’s balance', async () => {
    const res = await settlement(patch(
      carryForward(created.openPeriod, actors.employee.id, -5000, 'not mine to set'),
      actors.other.token,
    ))
    assert.equal(res.status, 403)
    assert.equal(await readSettlement(created.openPeriod, actors.employee.id), null)
  })
})

// ─── 3 & 4. The admin path, and the sign the modal produces ───────────────────

describe('an authorised payroll admin can record a previous balance', () => {
  test('3 & 4. “Employee received in advance” ₹200 is stored as −200, manual, with its reason', async () => {
    // What the dialog sends: direction 'advance' + magnitude 200 → amount -200.
    const res = await settlement(patch(
      carryForward(created.openPeriod, actors.employee.id, -200, 'Received in advance'),
      actors.admin.token,
    ))
    assert.equal(res.status, 200, `admin save must succeed, got ${JSON.stringify(await res.clone().json())}`)

    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(Number(body.carry_forward_amount), -200)
    assert.equal(body.is_manual, true)

    // 5. The stored state, which is what survives a refresh.
    const row = await readSettlement(created.openPeriod, actors.employee.id)
    assert.ok(row, 'the settlement row must exist after a successful save')
    assert.equal(Number(row!.carry_forward_amount), -200, 'an advance is a NEGATIVE carry-forward')
    assert.equal(row!.carry_forward_is_manual, true, 'the manual flag drives the "set manually" notice')
    assert.equal(row!.carry_forward_remark, 'Received in advance', 'the reason must persist, not just the amount')
    assert.equal(row!.carry_forward_set_by, actors.admin.id)
  })

  test('9. retrying the same save does not create a second settlement row', async () => {
    await settlement(patch(
      carryForward(created.openPeriod, actors.employee.id, -200, 'Received in advance'),
      actors.admin.token,
    ))

    const { data, error } = await svc
      .from('payroll_settlements')
      .select('id')
      .eq('payroll_period_id', created.openPeriod)
      .eq('employee_id', actors.employee.id)
    assert.ok(!error)
    assert.equal(data!.length, 1, 'ensureSettlement must find the existing row, not insert another')
  })

  test('a manual override still requires a reason', async () => {
    const res = await settlement(patch(
      { ...carryForward(created.openPeriod, actors.employee.id, -200, ''), remark: '   ' },
      actors.admin.token,
    ))
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /remark is required/i)
  })
})

// ─── The response the page now renders from ───────────────────────────────────

describe('a successful write answers with the confirmed settlement figures', () => {
  test('the block carries the recomputed figures, so no second request is needed', async () => {
    const res = await settlement(patch(
      carryForward(created.openPeriod, actors.employee.id, -200, 'Received in advance'),
      actors.admin.token,
    ))
    assert.equal(res.status, 200)

    const { settlement: block } = await res.json()
    assert.ok(block, 'the write must answer with the block the page renders from')

    // The ₹200 advance, all the way through the arithmetic.
    assert.equal(block.figures.carry_forward,   -200)
    assert.equal(block.figures.net_adjustments, -200, 'no other adjustments, so this is the carry-forward alone')
    assert.equal(block.figures.salary_after_attendance, AFTER_ATTENDANCE)
    assert.equal(block.figures.salary_payable, AFTER_ATTENDANCE - 200)

    // Nothing has been paid, so there is no closing balance yet — unknown is
    // not zero, and the page must not be handed a manufactured debt.
    assert.equal(block.figures.amount_paid,     null)
    assert.equal(block.figures.closing_balance, null)
    assert.equal(block.figures.payment_status,  'not_recorded')

    // What the "set manually" notice and the Restore control are driven by.
    assert.equal(block.carry_forward.is_manual, true)
    assert.equal(block.carry_forward.remark,    'Received in advance')
    assert.equal(block.payment, null)
  })

  test('it is the SAME block the detail endpoint serves — the two cannot drift', async () => {
    // The whole point of answering from the write is that the page skips the
    // reload. That is only safe while both come from one builder, so this
    // compares them field for field.
    const saved = await settlement(patch(
      carryForward(created.openPeriod, actors.employee.id, -200, 'Received in advance'),
      actors.admin.token,
    ))
    const { settlement: fromWrite } = await saved.json()

    const detail = await resultDetail(new NextRequest(
      `http://localhost/api/payroll/results/detail?period_id=${created.openPeriod}&employee_id=${actors.employee.id}`,
      { headers: { authorization: `Bearer ${actors.admin.token}` } },
    ))
    assert.equal(detail.status, 200)
    const { settlement: fromReload } = await detail.json()

    assert.deepEqual(fromWrite.figures,       fromReload.figures)
    assert.deepEqual(fromWrite.carry_forward, fromReload.carry_forward)
    assert.deepEqual(fromWrite.payment,       fromReload.payment)
    assert.equal(fromWrite.sentence,          fromReload.sentence)

    // adjustments_balance belongs to the payload, not to the write — a
    // settlement change cannot affect it, so the page keeps its existing value.
    assert.equal('adjustments_balance' in fromWrite, false)
    assert.equal(typeof fromReload.adjustments_balance, 'boolean')
  })

  test('recording a payment answers with the closing balance it produces', async () => {
    const res = await settlement(patch({
      payroll_period_id: created.openPeriod,
      employee_id:       actors.employee.id,
      action:            'payment',
      amount_paid:       20_000,
      payment_date:      `${TEST_YEAR}-05-31`,
    }, actors.admin.token))
    assert.equal(res.status, 200)

    const { settlement: block } = await res.json()
    assert.equal(block.figures.amount_paid, 20_000)
    assert.equal(block.figures.closing_balance, AFTER_ATTENDANCE - 200 - 20_000)
    assert.equal(block.figures.payment_status, 'recorded')
    assert.equal(block.payment.payment_date, `${TEST_YEAR}-05-31`)
  })
})

// ─── 8. A locked period is immutable, for the admin too ───────────────────────

describe('locked payroll cannot be settled', () => {
  test('8. the admin is refused with 422, and nothing is written', async () => {
    const res = await settlement(patch(
      carryForward(created.lockedPeriod, actors.employee.id, -200, 'Received in advance'),
      actors.admin.token,
    ))
    assert.equal(res.status, 422, 'a locked period is a state refusal, not an authorisation one')

    assert.equal(
      await readSettlement(created.lockedPeriod, actors.employee.id), null,
      'the lock guard must run before ensureSettlement materialises a row',
    )
  })
})
