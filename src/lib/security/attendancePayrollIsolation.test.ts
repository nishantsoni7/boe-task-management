/**
 * Attendance & Payroll cross-employee isolation — proved against the real
 * database, with real authenticated sessions.
 *
 * Why this file exists
 * --------------------
 * Attendance and payroll hold the two most private facts BOE stores about a
 * person: when they were at their desk, and what they are paid. Every other
 * guard in this codebase — a hidden nav item, a role check inside a page, a
 * `.eq('employee_id', caller.id)` in one route — can be bypassed by someone who
 * opens the browser console and calls PostgREST directly with their own token.
 * The only boundary that survives that is RLS, so this suite asserts RLS
 * itself, with four separately-signed-in clients plus an anonymous one.
 *
 * It deliberately does NOT test UI visibility. Every assertion is a query or a
 * route handler invocation.
 *
 * Cast
 * ----
 *   Employee A / Employee B — role 'member'. A must never see B.
 *   Manager                 — role 'manager'. Gets no more than an employee.
 *   Admin                   — role 'admin'. Must retain everything.
 *   anon                    — the anon key with no session at all.
 *
 * Isolation of the test data itself
 * ---------------------------------
 * Four throwaway auth users (deleted in `after`), one payroll period in year
 * 2997 that can never collide with a real payroll month, and attendance dated
 * inside that same fictional month. Everything created is removed again, in
 * dependency order, even when assertions fail.
 *
 * Run:
 *   npx tsx --test src/lib/security/attendancePayrollIsolation.test.ts
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and
 * SUPABASE_SERVICE_ROLE_KEY in .env.local.
 */

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: '.env.local' })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON_KEY     = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const svc = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/** A far-future payroll month. Nothing real can ever live here. */
const TEST_YEAR  = 2997
const TEST_MONTH = 6
const DAY_A      = `${TEST_YEAR}-06-10`
const DAY_B      = `${TEST_YEAR}-06-11`

const STAMP    = Date.now()
const PASSWORD = `Isolation!${STAMP}`

type Actor = {
  label: string
  email: string
  id: string
  /** A client carrying this actor's own access token — exactly what a browser has. */
  db: SupabaseClient
  token: string
}

const actors: Record<'a' | 'b' | 'manager' | 'admin', Actor> = {} as never

/** The anon key with no session — a logged-out visitor. */
const anon = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const created = {
  periodId:      '',
  resultA:       '',
  resultB:       '',
  lineA:         '',
  lineB:         '',
  adjustmentA:   '',
  adjustmentB:   '',
  correctionA:   '',
  correctionB:   '',
  logA:          '',
  logB:          '',
  attendanceA:   '',
  attendanceB:   '',
}

let actorSeq = 0

/**
 * Every auth user this file creates, recorded the instant it exists rather than
 * when makeActor returns. If a later assertion in makeActor throws, the actor
 * never reaches `actors` — and without this list the auth account would survive
 * the run as an orphan with no profile.
 */
const createdAuthUserIds: string[] = []

async function makeActor(label: string, role: 'member' | 'manager' | 'admin'): Promise<Actor> {
  const email = `boe-isolation-${label}-${STAMP}@example.invalid`

  const { data: signUp, error: signUpErr } = await svc.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: `Isolation Test ${label.toUpperCase()}` },
  })
  assert.ok(!signUpErr, `could not create test auth user ${label}: ${signUpErr?.message}`)
  const id = signUp!.user.id
  createdAuthUserIds.push(id)

  // handle_new_auth_user() is supposed to mirror the auth row into public.users,
  // but it swallows every exception, so a failure there is silent. Upsert the
  // profile explicitly and assert it landed — an absent profile would make every
  // role-based policy below vacuously "pass".
  const { error: profileErr } = await svc
    .from('users')
    .upsert({
      id,
      full_name:      `Isolation Test ${label.toUpperCase()}`,
      email,
      // users.phone is UNIQUE and the trigger's default of '' collides with the
      // first real row that has one, so give each actor its own value.
      phone:          `+99${String(STAMP).slice(-8)}${actorSeq++}`,
      role,
      team:           'sales',
      is_active:      true,
      monthly_salary: 30000,
      payroll_active: true,
    }, { onConflict: 'id' })
  assert.ok(!profileErr, `could not create profile for ${label}: ${profileErr?.message}`)

  const { data: profile } = await svc.from('users').select('id, role').eq('id', id).single()
  assert.ok(profile, `profile row missing for ${label}`)
  assert.equal(profile!.role, role, `profile role not applied for ${label}`)

  const db = createClient(SUPABASE_URL!, ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: session, error: signInErr } = await db.auth.signInWithPassword({ email, password: PASSWORD })
  assert.ok(!signInErr, `could not sign in as ${label}: ${signInErr?.message}`)

  return { label, email, id, db, token: session!.session!.access_token }
}

before(async () => {
  actors.a       = await makeActor('a',       'member')
  actors.b       = await makeActor('b',       'member')
  actors.manager = await makeActor('manager', 'manager')
  actors.admin   = await makeActor('admin',   'admin')

  // ── Payroll period (far-future, so it can never be a real month) ────────────
  const { data: period, error: periodErr } = await svc
    .from('payroll_periods')
    .insert({ payroll_month: TEST_MONTH, payroll_year: TEST_YEAR, status: 'draft' })
    .select('id')
    .single()
  assert.ok(!periodErr, `test period insert failed: ${periodErr?.message}`)
  created.periodId = period!.id

  // ── One payroll result each ────────────────────────────────────────────────
  for (const [key, actor, net] of [
    ['resultA', actors.a, 28111.11],
    ['resultB', actors.b, 29222.22],
  ] as const) {
    const { data, error } = await svc
      .from('payroll_results')
      .insert({
        payroll_period_id: created.periodId,
        employee_id:       actor.id,
        monthly_salary:    30000,
        gross_salary:      30000,
        total_deductions:  30000 - net,
        net_salary:        net,
      })
      .select('id')
      .single()
    assert.ok(!error, `test payroll result insert failed for ${actor.label}: ${error?.message}`)
    created[key] = data!.id
  }

  // ── One deduction line each ────────────────────────────────────────────────
  for (const [key, resultId, day] of [
    ['lineA', created.resultA, DAY_A],
    ['lineB', created.resultB, DAY_B],
  ] as const) {
    const { data, error } = await svc
      .from('payroll_deduction_lines')
      .insert({
        payroll_result_id: resultId,
        line_date:         day,
        deduction_type:    'late_arrival',
        hours_deducted:    1,
        amount_deducted:   117.65,
      })
      .select('id')
      .single()
    assert.ok(!error, `test deduction line insert failed: ${error?.message}`)
    created[key] = data!.id
  }

  // ── One pending adjustment each ────────────────────────────────────────────
  for (const [key, actor] of [
    ['adjustmentA', actors.a],
    ['adjustmentB', actors.b],
  ] as const) {
    const { data, error } = await svc
      .from('payroll_pending_adjustments')
      .insert({
        employee_id:     actor.id,
        description:     `isolation test adjustment ${actor.label}`,
        amount:          500,
        adjustment_type: 'addition',
        payroll_year:    TEST_YEAR,
        payroll_month:   TEST_MONTH,
        status:          'pending',
      })
      .select('id')
      .single()
    assert.ok(!error, `test adjustment insert failed: ${error?.message}`)
    created[key] = data!.id
  }

  // ── Raw attendance, one day each ───────────────────────────────────────────
  for (const [key, actor, day] of [
    ['attendanceA', actors.a, DAY_A],
    ['attendanceB', actors.b, DAY_B],
  ] as const) {
    const { data, error } = await svc
      .from('attendance_records')
      .insert({
        user_id:         actor.id,
        attendance_date: day,
        check_in_at:     `${day}T04:45:00Z`,
        check_out_at:    `${day}T13:00:00Z`,
        status:          'present',
      })
      .select('id')
      .single()
    assert.ok(!error, `test attendance insert failed: ${error?.message}`)
    created[key] = data!.id
  }

  // ── One admin correction each, with a remark ───────────────────────────────
  for (const [key, actor, day] of [
    ['correctionA', actors.a, DAY_A],
    ['correctionB', actors.b, DAY_B],
  ] as const) {
    const { data, error } = await svc
      .from('attendance_day_corrections')
      .insert({
        user_id:          actor.id,
        attendance_date:  day,
        day_treatment:    'full_day',
        remark:           `isolation test remark for ${actor.label}`,
        corrected_by:     actors.admin.id,
        payroll_period_id: created.periodId,
      })
      .select('id')
      .single()
    assert.ok(!error, `test correction insert failed: ${error?.message}`)
    created[key] = data!.id
  }

  // ── One import-correction log row each ─────────────────────────────────────
  for (const [key, actor, day] of [
    ['logA', actors.a, DAY_A],
    ['logB', actors.b, DAY_B],
  ] as const) {
    const { data, error } = await svc
      .from('attendance_correction_log')
      .insert({
        user_id:          actor.id,
        attendance_date:  day,
        new_check_in_at:  `${day}T04:45:00Z`,
        corrected_by:     actors.admin.id,
        source_file_name: 'isolation-test.xls',
      })
      .select('id')
      .single()
    assert.ok(!error, `test correction log insert failed: ${error?.message}`)
    created[key] = data!.id
  }
})

after(async () => {
  // Child rows first, then parents, then the auth users themselves.
  await svc.from('attendance_correction_log').delete().in('id', [created.logA, created.logB].filter(Boolean))
  await svc.from('attendance_day_corrections').delete().in('id', [created.correctionA, created.correctionB].filter(Boolean))
  await svc.from('attendance_records').delete().in('id', [created.attendanceA, created.attendanceB].filter(Boolean))
  await svc.from('payroll_pending_adjustments').delete().in('id', [created.adjustmentA, created.adjustmentB].filter(Boolean))
  await svc.from('payroll_deduction_lines').delete().in('id', [created.lineA, created.lineB].filter(Boolean))
  await svc.from('payroll_results').delete().in('id', [created.resultA, created.resultB].filter(Boolean))
  if (created.periodId) await svc.from('payroll_periods').delete().eq('id', created.periodId)

  for (const id of createdAuthUserIds) {
    await svc.from('users').delete().eq('id', id)
    await svc.auth.admin.deleteUser(id)
  }
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** How many of these ids the client can actually see. RLS filters, it does not error. */
async function visibleIds(db: SupabaseClient, table: string, ids: string[]): Promise<string[]> {
  const { data } = await db.from(table).select('id').in('id', ids.filter(Boolean))
  return (data ?? []).map(r => r.id as string)
}

// ─── 1–2. Attendance ──────────────────────────────────────────────────────────

describe('attendance_records', () => {
  test('1. Employee A can read their own attendance', async () => {
    const seen = await visibleIds(actors.a.db, 'attendance_records', [created.attendanceA])
    assert.deepEqual(seen, [created.attendanceA])
  })

  test('2. Employee A cannot read Employee B attendance', async () => {
    const seen = await visibleIds(actors.a.db, 'attendance_records', [created.attendanceB])
    assert.deepEqual(seen, [], 'A must not see B raw attendance')
  })

  test('2b. A whole-table scan by Employee A returns nothing belonging to B', async () => {
    const { data } = await actors.a.db.from('attendance_records').select('id, user_id')
    for (const row of data ?? []) {
      assert.equal(row.user_id, actors.a.id, 'every visible attendance row must belong to the caller')
    }
  })
})

// ─── 3–5, 7. Payroll ──────────────────────────────────────────────────────────

describe('payroll_results', () => {
  test('3. Employee A can read their own payroll result', async () => {
    const seen = await visibleIds(actors.a.db, 'payroll_results', [created.resultA])
    assert.deepEqual(seen, [created.resultA])
  })

  test('4. Employee A cannot read Employee B payroll result', async () => {
    const seen = await visibleIds(actors.a.db, 'payroll_results', [created.resultB])
    assert.deepEqual(seen, [], 'A must not see B salary')
  })

  test('7. Employee A cannot reach Employee B through a direct result id', async () => {
    const { data } = await actors.a.db
      .from('payroll_results')
      .select('id, employee_id, net_salary')
      .eq('id', created.resultB)
      .maybeSingle()
    assert.equal(data, null, 'a known result id must not be a way in')
  })

  test('4b. A whole-table scan by Employee A returns only their own results', async () => {
    const { data } = await actors.a.db.from('payroll_results').select('id, employee_id')
    for (const row of data ?? []) {
      assert.equal(row.employee_id, actors.a.id)
    }
  })
})

describe('payroll_deduction_lines', () => {
  test('5. Employee A cannot read Employee B deduction lines', async () => {
    const seen = await visibleIds(actors.a.db, 'payroll_deduction_lines', [created.lineB])
    assert.deepEqual(seen, [])
  })

  test('5b. Employee A can read their own deduction lines', async () => {
    const seen = await visibleIds(actors.a.db, 'payroll_deduction_lines', [created.lineA])
    assert.deepEqual(seen, [created.lineA])
  })

  test('5c. A join from the parent cannot drag in another employee child rows', async () => {
    const { data } = await actors.a.db
      .from('payroll_results')
      .select('id, employee_id, payroll_deduction_lines(id)')
    for (const row of (data ?? []) as Array<{ employee_id: string }>) {
      assert.equal(row.employee_id, actors.a.id)
    }
  })
})

describe('payroll_pending_adjustments', () => {
  test('Employee A cannot read Employee B adjustments', async () => {
    const seen = await visibleIds(actors.a.db, 'payroll_pending_adjustments', [created.adjustmentB])
    assert.deepEqual(seen, [])
  })

  test('Employee A can read their own adjustments', async () => {
    const seen = await visibleIds(actors.a.db, 'payroll_pending_adjustments', [created.adjustmentA])
    assert.deepEqual(seen, [created.adjustmentA])
  })
})

// ─── 6. Corrections and remarks ───────────────────────────────────────────────

describe('attendance corrections', () => {
  test('6. Employee A cannot read Employee B corrections or remarks', async () => {
    const seen = await visibleIds(actors.a.db, 'attendance_day_corrections', [created.correctionB])
    assert.deepEqual(seen, [])
  })

  test('6b. Employee A can read the corrections applied to their own attendance', async () => {
    const seen = await visibleIds(actors.a.db, 'attendance_day_corrections', [created.correctionA])
    assert.deepEqual(seen, [created.correctionA])
  })

  test('6c. Employee A cannot read the import correction log at all', async () => {
    const seen = await visibleIds(actors.a.db, 'attendance_correction_log', [created.logA, created.logB])
    assert.deepEqual(seen, [], 'the import diff log is an admin audit surface')
  })
})

// ─── 10. Payroll period metadata ──────────────────────────────────────────────

describe('payroll_periods', () => {
  test('Employee A can read the period their own result belongs to (to label it)', async () => {
    const seen = await visibleIds(actors.a.db, 'payroll_periods', [created.periodId])
    assert.deepEqual(seen, [created.periodId])
  })

  test('Employee A cannot enumerate every payroll period in the company', async () => {
    const { data } = await actors.a.db.from('payroll_periods').select('id')
    const { data: mine } = await actors.a.db
      .from('payroll_results').select('payroll_period_id').eq('employee_id', actors.a.id)
    const allowed = new Set((mine ?? []).map(r => r.payroll_period_id as string))
    for (const row of data ?? []) {
      assert.ok(allowed.has(row.id as string), `period ${row.id} is visible without a result in it`)
    }
  })

  test('Employee A cannot read payroll generation runs', async () => {
    const { data } = await actors.a.db.from('payroll_generation').select('id')
    assert.deepEqual(data ?? [], [], 'generation runs name failed employees')
  })

  test('Employee A cannot read payroll period status events', async () => {
    const { data } = await actors.a.db.from('payroll_period_status_events').select('id')
    assert.deepEqual(data ?? [], [])
  })
})

// ─── 11–13. Writes ────────────────────────────────────────────────────────────

describe('employee writes are refused', () => {
  test('11. Employee A cannot write raw attendance', async () => {
    const { error } = await actors.a.db.from('attendance_records').insert({
      user_id: actors.a.id, attendance_date: `${TEST_YEAR}-06-20`, status: 'present',
    })
    assert.ok(error, 'inserting raw attendance must be refused')
  })

  test('11b. Employee A cannot update their own attendance row', async () => {
    const { data } = await actors.a.db
      .from('attendance_records')
      .update({ check_in_at: `${DAY_A}T03:00:00Z` })
      .eq('id', created.attendanceA)
      .select('id')
    assert.deepEqual(data ?? [], [], 'no row may be updated')
  })

  test('12. Employee A cannot write an approved correction', async () => {
    const { error } = await actors.a.db.from('attendance_day_corrections').insert({
      user_id: actors.a.id, attendance_date: DAY_A, day_treatment: 'full_day',
      remark: 'self-approved', corrected_by: actors.a.id,
    })
    assert.ok(error, 'employees must not be able to approve their own corrections')
  })

  test('13. Employee A cannot write a payroll result', async () => {
    const { error } = await actors.a.db.from('payroll_results').insert({
      payroll_period_id: created.periodId, employee_id: actors.a.id, monthly_salary: 999999,
    })
    assert.ok(error, 'employees must not be able to create payroll results')
  })

  test('13b. Employee A cannot raise their own net salary', async () => {
    const { data } = await actors.a.db
      .from('payroll_results')
      .update({ net_salary: 999999 })
      .eq('id', created.resultA)
      .select('id')
    assert.deepEqual(data ?? [], [], 'no payroll row may be updated by an employee')

    const { data: check } = await svc
      .from('payroll_results').select('net_salary').eq('id', created.resultA).single()
    assert.equal(Number(check!.net_salary), 28111.11, 'the stored salary must be untouched')
  })

  test('13c. Employee A cannot write a deduction line', async () => {
    const { error } = await actors.a.db.from('payroll_deduction_lines').insert({
      payroll_result_id: created.resultA, line_date: DAY_A,
      deduction_type: 'late_arrival', hours_deducted: 0, amount_deducted: 0,
    })
    assert.ok(error, 'employees must not be able to write the deduction ledger')
  })

  test('13d. Employee A cannot lock or unlock a payroll period', async () => {
    const { data } = await actors.a.db
      .from('payroll_periods').update({ status: 'locked' }).eq('id', created.periodId).select('id')
    assert.deepEqual(data ?? [], [])
  })

  test('13e. Employee A cannot write a payroll status event', async () => {
    const { error } = await actors.a.db.from('payroll_period_status_events').insert({
      payroll_period_id: created.periodId, event: 'unlocked',
      previous_status: 'locked', new_status: 'generated',
      actor_id: actors.a.id, reason: 'because I said so',
    })
    assert.ok(error, 'the audit trail is append-only through the service role')
  })
})

// ─── 14. Manager ──────────────────────────────────────────────────────────────

describe('manager has no team payroll or attendance access', () => {
  test('14. A manager cannot read another employee payroll result', async () => {
    const seen = await visibleIds(actors.manager.db, 'payroll_results', [created.resultA, created.resultB])
    assert.deepEqual(seen, [], 'being a manager is not a payroll grant')
  })

  test('14b. A manager cannot read another employee deduction lines', async () => {
    const seen = await visibleIds(actors.manager.db, 'payroll_deduction_lines', [created.lineA, created.lineB])
    assert.deepEqual(seen, [])
  })

  test('14c. A manager cannot read another employee attendance', async () => {
    const seen = await visibleIds(actors.manager.db, 'attendance_records', [created.attendanceA, created.attendanceB])
    assert.deepEqual(seen, [])
  })

  test('14d. A manager cannot review another employee corrections', async () => {
    const seen = await visibleIds(actors.manager.db, 'attendance_day_corrections', [created.correctionA, created.correctionB])
    assert.deepEqual(seen, [])
  })

  test('14e. A manager cannot read the import correction log', async () => {
    const seen = await visibleIds(actors.manager.db, 'attendance_correction_log', [created.logA, created.logB])
    assert.deepEqual(seen, [], 'correction review is not a manager capability')
  })
})

// ─── 15. Admin ────────────────────────────────────────────────────────────────

describe('admin retains expected access', () => {
  test('15. An admin can read every payroll result', async () => {
    const seen = await visibleIds(actors.admin.db, 'payroll_results', [created.resultA, created.resultB])
    assert.equal(seen.length, 2)
  })

  test('15b. An admin can read every deduction line', async () => {
    const seen = await visibleIds(actors.admin.db, 'payroll_deduction_lines', [created.lineA, created.lineB])
    assert.equal(seen.length, 2)
  })

  test('15c. An admin can read every adjustment', async () => {
    const seen = await visibleIds(actors.admin.db, 'payroll_pending_adjustments', [created.adjustmentA, created.adjustmentB])
    assert.equal(seen.length, 2)
  })

  test('15d. An admin can read every correction, and every attendance row', async () => {
    const corrections = await visibleIds(actors.admin.db, 'attendance_day_corrections', [created.correctionA, created.correctionB])
    assert.equal(corrections.length, 2)
    const attendance = await visibleIds(actors.admin.db, 'attendance_records', [created.attendanceA, created.attendanceB])
    assert.equal(attendance.length, 2)
  })

  test('15e. An admin can read the correction log and the period audit trail', async () => {
    const log = await visibleIds(actors.admin.db, 'attendance_correction_log', [created.logA, created.logB])
    assert.equal(log.length, 2)
    const { error } = await actors.admin.db.from('payroll_period_status_events').select('id').limit(1)
    assert.equal(error, null)
  })

  test('15f. An admin can still administer payroll periods', async () => {
    const { data, error } = await actors.admin.db
      .from('payroll_periods').update({ notes: 'isolation test touch' }).eq('id', created.periodId).select('id')
    assert.equal(error, null)
    assert.equal((data ?? []).length, 1, 'admin period administration must be preserved')
  })
})

// ─── 16. Anonymous ────────────────────────────────────────────────────────────

describe('anonymous access', () => {
  const tables = [
    'attendance_records',
    'attendance_day_corrections',
    'attendance_correction_log',
    'payroll_periods',
    'payroll_results',
    'payroll_deduction_lines',
    'payroll_pending_adjustments',
    'payroll_generation',
    'payroll_period_status_events',
  ]

  for (const table of tables) {
    test(`16. an anonymous client reads nothing from ${table}`, async () => {
      const { data } = await anon.from(table).select('id').limit(5)
      assert.deepEqual(data ?? [], [], `${table} must be closed to anon`)
    })
  }

  test('16b. an anonymous client cannot read the employee directory or salaries', async () => {
    const { data } = await anon.from('users').select('id, full_name, monthly_salary').limit(5)
    assert.deepEqual(data ?? [], [], 'the employee directory must require a session')
  })
})

// ─── 17. Generic module permissions ───────────────────────────────────────────

describe('generic module permission does not broaden row visibility', () => {
  test('17. granting payroll view + manage in the permission engine changes nothing', async () => {
    const { data: mod }    = await svc.from('permission_modules').select('id').eq('module_key', 'payroll').single()
    const { data: actions } = await svc.from('permission_actions').select('id, action_key').in('action_key', ['view', 'manage', 'export'])
    assert.ok(mod && actions?.length, 'the payroll permission module must exist to test this')

    const overrideIds: string[] = []
    try {
      for (const action of actions!) {
        const { data } = await svc.from('employee_permission_overrides').insert({
          user_id: actors.a.id, module_id: mod!.id, action_id: action.id,
          allowed: true, granted_by: actors.admin.id,
        }).select('id').single()
        if (data) overrideIds.push(data.id)
      }

      const resolved = await svc.rpc('resolve_permission', {
        p_user_id: actors.a.id, p_module_key: 'payroll', p_action_key: 'view',
      })
      assert.equal(resolved.data, true, 'the grant must actually have landed for this test to mean anything')

      const seen = await visibleIds(actors.a.db, 'payroll_results', [created.resultB])
      assert.deepEqual(seen, [], 'a generic module grant must not widen row visibility')

      const attendance = await visibleIds(actors.a.db, 'attendance_records', [created.attendanceB])
      assert.deepEqual(attendance, [], 'a generic module grant must not widen attendance visibility')
    } finally {
      if (overrideIds.length) await svc.from('employee_permission_overrides').delete().in('id', overrideIds)
    }
  })

  test('17b. flipping the app_modules visibility toggle does not widen row visibility', async () => {
    const { data: before } = await svc.from('app_modules').select('visibility_type').eq('module_key', 'payroll').single()
    try {
      await svc.from('app_modules').update({ visibility_type: 'live' }).eq('module_key', 'payroll')
      const seen = await visibleIds(actors.a.db, 'payroll_results', [created.resultB])
      assert.deepEqual(seen, [], 'Control Center visibility is navigation, never authorization')
    } finally {
      await svc.from('app_modules').update({ visibility_type: before!.visibility_type }).eq('module_key', 'payroll')
    }
  })
})

// ─── 19. RPCs ─────────────────────────────────────────────────────────────────

describe('RPCs do not leak cross-employee data', () => {
  test('19. resolve_effective_permissions for another user returns no payroll rows to Employee A', async () => {
    // The resolver is SECURITY DEFINER and takes a user id as an argument, so it
    // is the obvious candidate for a confused-deputy read. It returns only
    // permission flags — never attendance or salary — and that is what is asserted.
    const { data, error } = await actors.a.db.rpc('resolve_effective_permissions', {
      p_user_id: actors.b.id, p_module_key: 'payroll',
    })
    assert.equal(error, null)
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      assert.ok(!('net_salary' in row) && !('monthly_salary' in row), 'the resolver must expose no payroll figures')
    }
  })
})
