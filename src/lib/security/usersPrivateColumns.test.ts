/**
 * public.users — Admin-only HR columns, proved inaccessible to an end-user token.
 *
 * What this file is defending
 * ---------------------------
 * `monthly_salary` and `payroll_notes` sit in the same row as everybody's
 * display name, and every employee legitimately reads every other employee's
 * row (assignee pickers, task owners, order salespeople, asset custodians). RLS
 * filters rows, not columns, so no policy can separate those two facts. The
 * control is a PostgreSQL column privilege, and the thing that makes it real —
 * rather than a comment — is that `authenticated` no longer holds table-level
 * SELECT. This suite exists to prove that from the outside, with real sessions.
 *
 * The specific trap it checks for
 * ------------------------------
 * A column-level REVOKE is a no-op while the role still holds table-level
 * SELECT. A migration that only did `REVOKE SELECT (monthly_salary)` would look
 * correct, review clean, and change nothing. Tests 1–4 below would still pass
 * on the vulnerable schema if they only checked one shape, so they check four:
 * explicit column, `select('*')`, filtering on the column, and ordering by it.
 *
 * Cast: Employee A, Employee B, Manager, Admin (real signed-in sessions) and an
 * anonymous client. Four throwaway auth users, deleted afterwards.
 *
 * Run:
 *   npx tsx --test src/lib/security/usersPrivateColumns.test.ts
 */

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import { config } from 'dotenv'

import { GET as employeeList }     from '@/app/api/employee-list/route'
import { GET as adminProfile }     from '@/app/api/admin/employee-profile/route'
import { GET as myResult }         from '@/app/api/payroll/my-result/route'
import { GET as attendanceRecords } from '@/app/api/attendance/records/route'
import { PATCH as updateEmployee } from '@/app/api/update-employee/route'
import { USER_PROFILE_COLUMNS, USER_PRIVATE_COLUMNS } from '@/lib/users/safeColumns'
import { fetchAllPayrollActiveEmployees } from '@/lib/payroll/store'

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

const anon = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const STAMP    = Date.now()
const PASSWORD = `Columns!${STAMP}`
const SALARY_A = 41111
const SALARY_B = 52222
const NOTES_B  = 'B private payroll note — must never be readable by a peer'

type Actor = { id: string; email: string; token: string; db: SupabaseClient }
const actors: Record<'a' | 'b' | 'manager' | 'admin', Actor> = {} as never
const createdAuthUserIds: string[] = []
let actorSeq = 0

/** Postgres "permission denied for column/table". */
const PERMISSION_DENIED = '42501'

async function makeActor(
  label: string,
  role: 'member' | 'manager' | 'admin',
  salary: number,
  notes: string | null,
): Promise<Actor> {
  const email = `boe-usercols-${label}-${STAMP}@example.invalid`
  const { data: signUp, error } = await svc.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
    user_metadata: { full_name: `Column Test ${label.toUpperCase()}` },
  })
  assert.ok(!error, `could not create ${label}: ${error?.message}`)
  const id = signUp!.user.id
  createdAuthUserIds.push(id)

  const { error: profileErr } = await svc.from('users').upsert({
    id,
    full_name:      `Column Test ${label.toUpperCase()}`,
    email,
    phone:          `+97${String(STAMP).slice(-8)}${actorSeq++}`,
    role,
    team:           'sales',
    is_active:      true,
    monthly_salary: salary,
    payroll_notes:  notes,
    payroll_active: true,
  }, { onConflict: 'id' })
  assert.ok(!profileErr, `could not create profile for ${label}: ${profileErr?.message}`)

  const db = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: session, error: signInErr } = await db.auth.signInWithPassword({ email, password: PASSWORD })
  assert.ok(!signInErr, `could not sign in as ${label}: ${signInErr?.message}`)

  return { id, email, token: session!.session!.access_token, db }
}

type ReqInit = { method?: string; headers?: Record<string, string>; body?: string }

function req(url: string, token?: string, init: ReqInit = {}): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: init.method,
    body:   init.body,
    headers: {
      ...(init.headers ?? {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
}

before(async () => {
  actors.a       = await makeActor('a',       'member',  SALARY_A, 'A note')
  actors.b       = await makeActor('b',       'member',  SALARY_B, NOTES_B)
  actors.manager = await makeActor('manager', 'manager', 33333, 'manager note')
  actors.admin   = await makeActor('admin',   'admin',   44444, 'admin note')
})

after(async () => {
  for (const id of createdAuthUserIds) {
    await svc.from('users').delete().eq('id', id)
    await svc.auth.admin.deleteUser(id)
  }
})

// ─── 1–4. The four shapes a column privilege must refuse ─────────────────────

describe('an employee cannot read a colleague salary or payroll notes', () => {
  test('1. Employee A cannot select Employee B monthly_salary', async () => {
    const { data, error } = await actors.a.db
      .from('users').select('id, monthly_salary').eq('id', actors.b.id)
    assert.equal(data, null, 'no row may come back')
    assert.ok(error, 'the query must be refused, not merely return null')
    assert.equal(error!.code, PERMISSION_DENIED, `expected 42501, got ${error!.code}: ${error!.message}`)
  })

  test('2. Employee A cannot select Employee B payroll_notes', async () => {
    const { data, error } = await actors.a.db
      .from('users').select('id, payroll_notes').eq('id', actors.b.id)
    assert.equal(data, null)
    assert.equal(error?.code, PERMISSION_DENIED)
  })

  test("3. Employee A cannot obtain them via select('*')", async () => {
    // The trap this catches: a column REVOKE with table-level SELECT still
    // granted leaves `*` working and returning the salary.
    const { data, error } = await actors.a.db.from('users').select('*').limit(5)
    assert.equal(data, null, "select('*') must not return rows")
    assert.equal(error?.code, PERMISSION_DENIED)
  })

  test('4. Employee A cannot obtain their OWN salary either', async () => {
    // The grant is per-column, not per-row: there is no self-exception, and no
    // screen needs one. Stated explicitly so a future "just for yourself"
    // change has to break a test first.
    const { error } = await actors.a.db
      .from('users').select('id, monthly_salary').eq('id', actors.a.id)
    assert.equal(error?.code, PERMISSION_DENIED)
  })

  test('4b. Employee A cannot infer a salary by filtering on it', async () => {
    // A WHERE clause reads the column just as a projection does. Without this,
    // a binary search on `gt` would recover every salary without ever
    // selecting it.
    const { data, error } = await actors.a.db
      .from('users').select('id').gt('monthly_salary', SALARY_B - 1)
    assert.equal(data, null, 'filtering on a forbidden column must not answer')
    assert.equal(error?.code, PERMISSION_DENIED)
  })

  test('4c. Employee A cannot infer an ordering by salary', async () => {
    const { data, error } = await actors.a.db
      .from('users').select('id').order('monthly_salary', { ascending: false }).limit(3)
    assert.equal(data, null)
    assert.ok(error, 'ordering by a forbidden column must be refused')
  })

  test('4d. Employee A cannot reach the columns through an embedded join', async () => {
    const { data, error } = await actors.a.db
      .from('payroll_results').select('id, users!payroll_results_employee_id_fkey(monthly_salary)')
    assert.equal(data, null, 'an embedded resource is still a read of the column')
    assert.ok(error)
  })
})

// ─── 5. Manager ───────────────────────────────────────────────────────────────

describe('a manager is not exempt', () => {
  test('5. Manager cannot read team salaries', async () => {
    const { data, error } = await actors.manager.db.from('users').select('id, monthly_salary')
    assert.equal(data, null)
    assert.equal(error?.code, PERMISSION_DENIED)
  })

  test('5b. Manager cannot read team payroll notes', async () => {
    const { error } = await actors.manager.db.from('users').select('id, payroll_notes')
    assert.equal(error?.code, PERMISSION_DENIED)
  })

  test('5c. Manager cannot write another employee salary through the employee API', async () => {
    const res = await updateEmployee(req('/api/update-employee', actors.manager.token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: actors.b.id, monthly_salary: 999999 }),
    }))
    assert.equal(res.status, 403, 'setting pay is an admin act')

    const { data: check } = await svc.from('users').select('monthly_salary').eq('id', actors.b.id).single()
    assert.equal(Number(check!.monthly_salary), SALARY_B, 'the stored salary must be untouched')
  })

  test('5d. An employee cannot raise their own salary through the table', async () => {
    const { error } = await actors.a.db
      .from('users').update({ monthly_salary: 999999 }).eq('id', actors.a.id)
    assert.ok(error, 'the UPDATE grant is withdrawn, so this must fail outright')

    const { data: check } = await svc.from('users').select('monthly_salary').eq('id', actors.a.id).single()
    assert.equal(Number(check!.monthly_salary), SALARY_A, 'the stored salary must be untouched')
  })
})

// ─── 6. Anonymous ─────────────────────────────────────────────────────────────

describe('anonymous access', () => {
  test('6. an anonymous client cannot read users at all', async () => {
    const { data } = await anon.from('users').select(USER_PROFILE_COLUMNS).limit(5)
    assert.deepEqual(data ?? [], [], 'the directory requires a session')
  })

  test('6b. an anonymous client cannot read the private columns', async () => {
    const { data, error } = await anon.from('users').select('id, monthly_salary').limit(5)
    assert.deepEqual(data ?? [], [])
    if (error) assert.equal(error.code, PERMISSION_DENIED)
  })
})

// ─── 7–11. The directory the app actually needs still works ───────────────────

describe('the safe employee directory still works', () => {
  test('7. Employee A can read the safe directory columns for everyone', async () => {
    const { data, error } = await actors.a.db.from('users').select(USER_PROFILE_COLUMNS)
    assert.equal(error, null, `safe columns must remain readable: ${error?.message}`)
    assert.ok((data ?? []).length >= 4)
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>
    const b = rows.find(u => u.id === actors.b.id)!
    assert.ok(b, 'a colleague must still be visible in the directory')
    assert.equal(b.full_name, 'Column Test B')
    assert.ok(!('monthly_salary' in b), 'the payload must not carry salary')
    assert.ok(!('payroll_notes' in b),  'the payload must not carry payroll notes')
  })

  test('8. task assignee selection still works', async () => {
    // The exact shape src/app/tasks/create/page.tsx uses for its picker.
    const { data, error } = await actors.a.db
      .from('users')
      .select('id, full_name, team, role, email, phone, is_active, created_at')
      .eq('is_active', true).order('full_name')
    assert.equal(error, null)
    assert.ok((data ?? []).length >= 4)
  })

  test('9. Assets employee selection still works', async () => {
    // src/app/assets-access/page.tsx
    const { data, error } = await actors.a.db.from('users').select('id, full_name, role, team')
    assert.equal(error, null)
    assert.ok((data ?? []).length >= 4)
  })

  test('10. attendance employee name display still works', async () => {
    // src/app/attendance/records/page.tsx
    const { data, error } = await actors.admin.db.from('users').select('id, full_name, employee_code')
    assert.equal(error, null)
    assert.ok((data ?? []).length >= 4)
  })

  test('11. performance employee labels still work', async () => {
    const { data, error } = await actors.a.db.from('users').select('id, full_name')
    assert.equal(error, null)
    assert.ok((data ?? []).length >= 4)
  })

  test('7b. a self-profile fetch with the shared column list succeeds', async () => {
    const { data, error } = await actors.a.db
      .from('users').select(USER_PROFILE_COLUMNS).eq('id', actors.a.id).single()
    assert.equal(error, null, `the shared list must match the granted columns: ${error?.message}`)
    assert.equal((data as unknown as Record<string, unknown>).full_name, 'Column Test A')
  })

  test('7c. even an admin browser session cannot select salary from the table', async () => {
    // Admin authority is asserted by a server route, never by the browser's own
    // grant — an admin's token is still `authenticated`.
    const { error } = await actors.admin.db.from('users').select('id, monthly_salary').limit(1)
    assert.equal(error?.code, PERMISSION_DENIED)
  })
})

// ─── 12–14. Admin and payroll paths still function ────────────────────────────

describe('admin and payroll server paths keep their salary access', () => {
  test('12. Admin salary read works through the intended admin route', async () => {
    const res = await adminProfile(req(`/api/admin/employee-profile?employee_id=${actors.b.id}`, actors.admin.token))
    assert.equal(res.status, 200)
    const { employee } = await res.json()
    assert.equal(Number(employee.monthly_salary), SALARY_B)
    assert.equal(employee.payroll_notes, NOTES_B)
  })

  test('12b. that route refuses an employee and a manager', async () => {
    assert.equal((await adminProfile(req(`/api/admin/employee-profile?employee_id=${actors.b.id}`, actors.a.token))).status, 403)
    assert.equal((await adminProfile(req(`/api/admin/employee-profile?employee_id=${actors.b.id}`, actors.manager.token))).status, 403)
    assert.equal((await adminProfile(req(`/api/admin/employee-profile?employee_id=${actors.b.id}`))).status, 401)
  })

  test('13. payroll generation still reads salary correctly', async () => {
    // The engine's own loader, on the service role, exactly as
    // /api/payroll/generate calls it.
    const employees = await fetchAllPayrollActiveEmployees(svc)
    const b = employees.find(e => e.id === actors.b.id)
    assert.ok(b, 'a payroll-active employee must be visible to the engine')
    assert.equal(Number(b!.monthly_salary), SALARY_B, 'the engine must still see real pay')
  })

  test('14. the admin employee list carries salary for an admin only', async () => {
    const asAdmin = await employeeList(req('/api/employee-list', actors.admin.token))
    assert.equal(asAdmin.status, 200)
    const adminRow = (await asAdmin.json()).employees.find((e: { id: string }) => e.id === actors.b.id)
    assert.equal(Number(adminRow.monthly_salary), SALARY_B, 'admin must still see the master list salary')

    const asEmployee = await employeeList(req('/api/employee-list', actors.a.token))
    assert.equal(asEmployee.status, 200)
    const employees = (await asEmployee.json()).employees
    for (const row of employees) {
      assert.ok(!('monthly_salary' in row), `employee-list leaked salary for ${row.id}`)
      assert.ok(!('payroll_notes' in row),  `employee-list leaked payroll notes for ${row.id}`)
    }
    assert.ok(employees.length >= 4, 'the list itself must still be readable by an employee')
  })
})

// ─── 15–17. Serialization boundaries ──────────────────────────────────────────

describe('employee-facing responses never serialize the private columns', () => {
  const forbidden = (body: string) =>
    USER_PRIVATE_COLUMNS.filter(c => body.includes(`"${c}"`))

  test('15. /api/payroll/my-result carries no users-table salary or notes', async () => {
    // NOTE: the payload does contain a `monthly_salary` KEY — it is the snapshot
    // stored on the employee's own payroll_results row, which is their own pay
    // and the whole point of a payslip. What must not appear is payroll_notes,
    // or any figure belonging to somebody else.
    const res  = await myResult(req('/api/payroll/my-result', actors.a.token))
    const body = await res.text()
    assert.ok(!body.includes('payroll_notes'), 'payroll notes must never reach an employee')
    assert.ok(!body.includes(String(SALARY_B)), "another employee's salary must never appear")
  })

  test('16. the employee directory response body contains neither column name', async () => {
    const res  = await employeeList(req('/api/employee-list', actors.a.token))
    assert.deepEqual(forbidden(await res.text()), [])
  })

  test('17. the attendance CSV export contains neither column', async () => {
    const res  = await attendanceRecords(req('/api/attendance/records?format=csv', actors.admin.token))
    const body = await res.text()
    assert.ok(!body.includes('monthly_salary'))
    assert.ok(!body.includes('payroll_notes'))
    assert.ok(!body.includes(String(SALARY_B)))
  })
})

// ─── 18. Module permissions ───────────────────────────────────────────────────

describe('generic module permissions do not broaden column access', () => {
  test('18. granting every payroll action changes nothing', async () => {
    const { data: mod }     = await svc.from('permission_modules').select('id').eq('module_key', 'payroll').single()
    const { data: actions } = await svc.from('permission_actions').select('id').in('action_key', ['view', 'manage', 'export', 'admin'])
    assert.ok(mod && actions?.length)

    const ids: string[] = []
    try {
      for (const action of actions!) {
        const { data } = await svc.from('employee_permission_overrides').insert({
          user_id: actors.a.id, module_id: mod!.id, action_id: action.id,
          allowed: true, granted_by: actors.admin.id,
        }).select('id').single()
        if (data) ids.push(data.id)
      }

      const { error } = await actors.a.db.from('users').select('id, monthly_salary').eq('id', actors.b.id)
      assert.equal(error?.code, PERMISSION_DENIED, 'a permission grant is not a column privilege')
    } finally {
      if (ids.length) await svc.from('employee_permission_overrides').delete().in('id', ids)
    }
  })

  test('18b. flipping the Control Center module toggle changes nothing', async () => {
    const { data: before } = await svc.from('app_modules').select('visibility_type').eq('module_key', 'payroll').single()
    try {
      await svc.from('app_modules').update({ visibility_type: 'live' }).eq('module_key', 'payroll')
      const { error } = await actors.a.db.from('users').select('id, payroll_notes').eq('id', actors.b.id)
      assert.equal(error?.code, PERMISSION_DENIED)
    } finally {
      await svc.from('app_modules').update({ visibility_type: before!.visibility_type }).eq('module_key', 'payroll')
    }
  })
})
