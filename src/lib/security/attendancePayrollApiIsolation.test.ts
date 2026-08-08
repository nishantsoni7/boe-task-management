/**
 * Attendance & Payroll API isolation — the service-role routes, called the way
 * an attacker would call them.
 *
 * Why this is separate from attendancePayrollIsolation.test.ts
 * -----------------------------------------------------------
 * That file proves RLS. This one proves the routes that *bypass* RLS. Every
 * attendance and payroll route runs on the service role, so for those the
 * database is not a second line of defence — the route's own identity check is
 * the only one there is. A route that reads `employee_id` from the query string
 * and passes it to a service-role query is a full read of that employee's data
 * for anyone with a token, no matter how correct the policies are.
 *
 * The handlers are invoked directly with a real bearer token rather than over
 * HTTP, so no dev server is required and the assertions are about the handler
 * itself rather than about routing.
 *
 * Run:
 *   npx tsx --test src/lib/security/attendancePayrollApiIsolation.test.ts
 */

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import { config } from 'dotenv'

import { GET as employeeRecords }      from '@/app/api/attendance/employee-records/route'
import { GET as attendanceRecords }    from '@/app/api/attendance/records/route'
import { GET as monthlyDetail }        from '@/app/api/attendance/employee-monthly-detail/route'
import { GET as monthlySummary }       from '@/app/api/attendance/monthly-summary/route'
import { GET as attendanceDashboard }  from '@/app/api/attendance/dashboard/route'
import { GET as payrollResults }       from '@/app/api/payroll/results/route'
import { GET as payrollResultDetail }  from '@/app/api/payroll/results/detail/route'
import { GET as myResult }             from '@/app/api/payroll/my-result/route'
import { istCurrentYearMonth, istToday } from '@/lib/attendance/monthAvailability'
import { monthRange, workingDatesInMonth } from '@/lib/attendance/monthCalendar'

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

// A sandbox month with no real data in it, so these actors cannot collide with
// production attendance or payroll.
//
// In the PAST rather than the future, because employee-monthly-detail now
// refuses a month that has not started yet — a future sandbox year would be
// rejected before any of the identity checks below could be exercised. See
// src/lib/attendance/monthAvailability.ts.
//
// 2021 rather than something older because payroll_periods carries
// CHECK (payroll_year >= 2020).
const TEST_YEAR  = 2021
const TEST_MONTH = 4
const DAY_A      = `${TEST_YEAR}-04-10`
const DAY_B      = `${TEST_YEAR}-04-11`

const STAMP    = Date.now()
const PASSWORD = `ApiIsolation!${STAMP}`

type Actor = { id: string; token: string; email: string }
const actors: Record<'a' | 'b' | 'manager' | 'admin', Actor> = {} as never
let actorSeq = 0

/** Recorded as soon as the auth user exists, so a later failure in makeActor
 *  cannot leave an orphaned account behind. */
const createdAuthUserIds: string[] = []

const created = { periodId: '', resultA: '', resultB: '', attendanceA: '', attendanceB: '', attendanceCurrent: '' }

// The CURRENT month, which is the only month where "imported" and "processed"
// can disagree. A is given one punch on its first day; the assertions below read
// the company-wide latest date back from the database rather than assuming this
// fixture is the newest row, so they hold whatever real attendance exists.
const CURRENT       = istCurrentYearMonth()
const CURRENT_FIRST = monthRange(CURRENT.year, CURRENT.month).from

async function makeActor(label: string, role: 'member' | 'manager' | 'admin'): Promise<Actor> {
  const email = `boe-api-isolation-${label}-${STAMP}@example.invalid`
  const { data: signUp, error } = await svc.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
    user_metadata: { full_name: `API Isolation ${label.toUpperCase()}` },
  })
  assert.ok(!error, `could not create ${label}: ${error?.message}`)
  const id = signUp!.user.id
  createdAuthUserIds.push(id)

  const { error: profileErr } = await svc.from('users').upsert({
    id,
    full_name:      `API Isolation ${label.toUpperCase()}`,
    email,
    phone:          `+98${String(STAMP).slice(-8)}${actorSeq++}`,
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

/** A request exactly as the browser would send it: a URL and a bearer token. */
function req(url: string, token?: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

before(async () => {
  actors.a       = await makeActor('a',       'member')
  actors.b       = await makeActor('b',       'member')
  actors.manager = await makeActor('manager', 'manager')
  actors.admin   = await makeActor('admin',   'admin')

  const { data: period, error: periodErr } = await svc.from('payroll_periods')
    .insert({ payroll_month: TEST_MONTH, payroll_year: TEST_YEAR, status: 'draft' })
    .select('id').single()
  assert.ok(!periodErr, `period insert failed: ${periodErr?.message}`)
  created.periodId = period!.id

  for (const [key, actor, net] of [
    ['resultA', actors.a, 27000.5],
    ['resultB', actors.b, 28000.5],
  ] as const) {
    const { data, error } = await svc.from('payroll_results').insert({
      payroll_period_id: created.periodId, employee_id: actor.id,
      monthly_salary: 30000, gross_salary: 30000, net_salary: net, total_deductions: 30000 - net,
    }).select('id').single()
    assert.ok(!error, `result insert failed: ${error?.message}`)
    created[key] = data!.id
  }

  for (const [key, actor, day] of [
    ['attendanceA', actors.a, DAY_A],
    ['attendanceB', actors.b, DAY_B],
  ] as const) {
    const { data, error } = await svc.from('attendance_records').insert({
      user_id: actor.id, attendance_date: day,
      check_in_at: `${day}T04:45:00Z`, check_out_at: `${day}T13:00:00Z`, status: 'present',
    }).select('id').single()
    assert.ok(!error, `attendance insert failed: ${error?.message}`)
    created[key] = data!.id
  }

  // One punch on the 1st of the current month: an import that has started but
  // certainly has not reached the end of the month.
  const { data: currentRow, error: currentErr } = await svc.from('attendance_records').insert({
    user_id: actors.a.id, attendance_date: CURRENT_FIRST,
    check_in_at: `${CURRENT_FIRST}T04:45:00Z`, check_out_at: `${CURRENT_FIRST}T13:00:00Z`, status: 'present',
  }).select('id').single()
  assert.ok(!currentErr, `current-month attendance insert failed: ${currentErr?.message}`)
  created.attendanceCurrent = currentRow!.id
})

after(async () => {
  await svc.from('attendance_records').delete()
    .in('id', [created.attendanceA, created.attendanceB, created.attendanceCurrent].filter(Boolean))
  await svc.from('payroll_results').delete().in('id', [created.resultA, created.resultB].filter(Boolean))
  if (created.periodId) await svc.from('payroll_periods').delete().eq('id', created.periodId)
  for (const id of createdAuthUserIds) {
    await svc.from('users').delete().eq('id', id)
    await svc.auth.admin.deleteUser(id)
  }
})

// ─── 9 & 18. Client-supplied employee ids on service-role routes ──────────────

describe('service-role attendance routes reject a mismatched employee identity', () => {
  test('18. /api/attendance/employee-records refuses Employee B id from Employee A', async () => {
    const res = await employeeRecords(req(`/api/attendance/employee-records?employee_id=${actors.b.id}`, actors.a.token))
    assert.equal(res.status, 403)
    const body = await res.json()
    assert.equal(body.error, 'Forbidden', 'the error must not confirm that the employee exists')
  })

  test('9. Employee A calling employee-records for themselves gets only their own rows', async () => {
    const res = await employeeRecords(req(`/api/attendance/employee-records?employee_id=${actors.a.id}`, actors.a.token))
    assert.equal(res.status, 200)
    const { records } = await res.json()

    // This route takes no date bounds, so it answers with every month A has —
    // the sandbox day below and the current-month fixture used by the coverage
    // tests further down. What it must never contain is a day of B's.
    const dates = (records as { id: string; attendance_date: string }[]).map(r => r.attendance_date)
    assert.ok(dates.includes(DAY_A), 'A own sandbox day must be returned')
    assert.equal(dates.includes(DAY_B), false, 'B day must never appear in A answer')
    const ids = (records as { id: string }[]).map(r => r.id)
    assert.equal(ids.includes(created.attendanceB), false)
  })

  test('9b. Employee A omitting employee_id is scoped to themselves, not to everyone', async () => {
    const res = await attendanceRecords(req(`/api/attendance/records?from=${TEST_YEAR}-04-01&to=${TEST_YEAR}-04-30`, actors.a.token))
    assert.equal(res.status, 200)
    const { records } = await res.json()
    for (const r of records) assert.equal(r.user_id, actors.a.id)
  })

  test('9c. the CSV export cannot be pointed at another employee', async () => {
    const res = await attendanceRecords(req(`/api/attendance/records?format=csv&employee_id=${actors.b.id}`, actors.a.token))
    assert.equal(res.status, 403)
  })

  test('18b. employee-monthly-detail refuses another employee id', async () => {
    const res = await monthlyDetail(req(
      `/api/attendance/employee-monthly-detail?employee_id=${actors.b.id}&year=${TEST_YEAR}&month=${TEST_MONTH}`,
      actors.a.token,
    ))
    assert.equal(res.status, 403)
  })

  test('18c. employee-monthly-detail answers for the caller themselves', async () => {
    const res = await monthlyDetail(req(
      `/api/attendance/employee-monthly-detail?employee_id=${actors.a.id}&year=${TEST_YEAR}&month=${TEST_MONTH}`,
      actors.a.token,
    ))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.employee.id, actors.a.id)
  })

  test('a fabricated employee id is refused the same way a real one is', async () => {
    const res = await employeeRecords(req(
      '/api/attendance/employee-records?employee_id=00000000-0000-0000-0000-000000000000',
      actors.a.token,
    ))
    assert.equal(res.status, 403, 'a nonexistent id must not answer differently from a real colleague')
  })
})

describe('company-wide attendance routes are admin only', () => {
  test('monthly-summary refuses an employee', async () => {
    const res = await monthlySummary(req(`/api/attendance/monthly-summary?year=${TEST_YEAR}&month=${TEST_MONTH}`, actors.a.token))
    assert.equal(res.status, 403)
  })

  test('14f. monthly-summary refuses a manager', async () => {
    const res = await monthlySummary(req(`/api/attendance/monthly-summary?year=${TEST_YEAR}&month=${TEST_MONTH}`, actors.manager.token))
    assert.equal(res.status, 403, 'a manager is not a payroll or attendance reviewer')
  })

  test('monthly-summary answers an admin', async () => {
    const res = await monthlySummary(req(`/api/attendance/monthly-summary?year=${TEST_YEAR}&month=${TEST_MONTH}`, actors.admin.token))
    assert.equal(res.status, 200)
  })

  test('the attendance dashboard refuses an employee and answers an admin', async () => {
    assert.equal((await attendanceDashboard(req('/api/attendance/dashboard', actors.a.token))).status, 403)
    assert.equal((await attendanceDashboard(req('/api/attendance/dashboard', actors.admin.token))).status, 200)
  })
})

// ─── Uploaded vs not uploaded ─────────────────────────────────────────────────
//
// The distinction the calendar alone cannot make. April 2021 has punches (the
// fixtures above); March 2021 has none for anybody, which is what "nobody has
// uploaded the sheet" looks like.

describe('a month nobody has imported is not a month of absences', () => {
  const detail = (year: number, month: number, actor = actors.a) =>
    monthlyDetail(req(
      `/api/attendance/employee-monthly-detail?employee_id=${actor.id}&year=${year}&month=${month}`,
      actor.token,
    ))

  test('a future month is refused rather than generated', async () => {
    const next = new Date()
    next.setUTCMonth(next.getUTCMonth() + 2)
    const res = await detail(next.getUTCFullYear(), next.getUTCMonth() + 1)
    assert.equal(res.status, 400, 'a month that has not started must not be answered')
  })

  test('a month with no company-wide import reports month_imported false and no rows', async () => {
    const res = await detail(TEST_YEAR, 3)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.month_imported, false)
    assert.deepEqual(body.records, [], 'an unimported month must not assert a single absence')
  })

  test('an imported month reports month_imported true', async () => {
    const res = await detail(TEST_YEAR, TEST_MONTH)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.month_imported, true)
  })

  // The 21 July regression, in test form: once a month IS imported, the
  // calendar still supplies every working day, and a day this employee has no
  // punch for is a real absence that must keep showing.
  test('an imported month still builds missing working days from the calendar', async () => {
    const res = await detail(TEST_YEAR, TEST_MONTH)
    const body = await res.json()

    const punched = body.records.find((r: { attendance_date: string }) => r.attendance_date === DAY_A)
    assert.ok(punched, 'the punched day must be present')
    assert.equal(punched.effective_status, 'present')

    // 12 April 2021 is a Monday, and A has no punch on it.
    const absent = body.records.find((r: { attendance_date: string }) => r.attendance_date === `${TEST_YEAR}-04-12`)
    assert.ok(absent, 'a working day with no punch must still appear')
    assert.equal(absent.effective_status, 'absent')

    assert.ok(body.records.length > 2, 'the month is built from the calendar, not from the two fixture rows')
  })

  test('the not-imported answer is still scoped to the caller', async () => {
    const res = await monthlyDetail(req(
      `/api/attendance/employee-monthly-detail?employee_id=${actors.b.id}&year=${TEST_YEAR}&month=3`,
      actors.a.token,
    ))
    assert.equal(res.status, 403, 'the upload state must not become a way to probe a colleague')
  })
})

// ─── The current month is only classified as far as the import reached ────────
//
// The gap this closes: "the month has been imported" was decided by a row COUNT,
// so one punch anywhere in August marked August imported and the calendar then
// produced every remaining working day of it as an absence — including days
// nobody had uploaded, and days that had not happened. The cut-off is now the
// company-wide latest attendance_date in the month, capped at today.
//
// These assertions read that latest date back from the database instead of
// hard-coding one, so they mean the same thing on the 1st and on the 31st, and
// whatever real attendance the environment happens to hold.

describe('an unprocessed or future day in the current month is never an absence', () => {
  const detail = (actor = actors.a) =>
    monthlyDetail(req(
      `/api/attendance/employee-monthly-detail?employee_id=${actor.id}` +
      `&year=${CURRENT.year}&month=${CURRENT.month}`,
      actor.token,
    ))

  /** The newest attendance_date anyone in the company has this month. */
  const companyLatest = async (): Promise<string> => {
    const { from, to } = monthRange(CURRENT.year, CURRENT.month)
    const { data } = await svc.from('attendance_records')
      .select('attendance_date')
      .gte('attendance_date', from).lte('attendance_date', to)
      .order('attendance_date', { ascending: false }).limit(1)
    return data![0].attendance_date
  }

  /** The working days the routes themselves would build, up to the cut-off. */
  const coveredWorkingDates = async (cut: string): Promise<string[]> => {
    const { from, to } = monthRange(CURRENT.year, CURRENT.month)
    const { data } = await svc.from('payroll_holidays')
      .select('holiday_date').gte('holiday_date', from).lte('holiday_date', to)
    return workingDatesInMonth(CURRENT.year, CURRENT.month, {
      holidays: (data ?? []).map(h => h.holiday_date),
    }).filter(d => d <= cut)
  }

  test('2. the response names how far the import has reached, and stops there', async () => {
    const res = await detail()
    assert.equal(res.status, 200)
    const body = await res.json()

    assert.equal(body.month_imported, true, 'the fixture punch means this month IS imported')
    assert.equal(body.coverage_through, await companyLatest(),
      'the cut-off must be the latest date actually imported, not the end of the month')

    for (const r of body.records as { attendance_date: string }[]) {
      assert.ok(r.attendance_date <= body.coverage_through,
        `${r.attendance_date} is past the imported-through date and must not be returned`)
    }
  })

  test('3. days after the imported-through date are absent from the response entirely', async () => {
    const body = await (await detail()).json()
    const cut  = body.coverage_through as string
    const returned = new Set((body.records as { attendance_date: string }[]).map(r => r.attendance_date))

    // Every working day of the month that falls after the cut-off — none may
    // appear, as an absence or as anything else.
    for (const date of workingDatesInMonth(CURRENT.year, CURRENT.month)) {
      if (date <= cut) continue
      assert.equal(returned.has(date), false,
        `${date} has not been processed and must not be classified at all`)
    }
  })

  test('4. no future date is returned, and none is marked Absent', async () => {
    const today = istToday()
    const body  = await (await detail()).json()

    for (const r of body.records as { attendance_date: string; effective_status: string }[]) {
      assert.ok(r.attendance_date <= today,
        `${r.attendance_date} has not happened yet and must never appear`)
      assert.ok(!(r.attendance_date > today && r.effective_status === 'absent'),
        'a day that has not happened can never be an absence')
    }
    assert.ok(body.coverage_through <= today, 'the cut-off itself must never be in the future')
  })

  test('6. inside the covered range a working day with no punch is still Absent', async () => {
    const body = await (await detail()).json()
    const cut  = body.coverage_through as string

    // Every covered working day is answered for — that is the 21 July rule —
    // and the ones A has no punch on are absences, not omissions.
    const byDate = new Map(
      (body.records as { attendance_date: string; effective_status: string }[])
        .map(r => [r.attendance_date, r.effective_status]),
    )
    const covered = await coveredWorkingDates(cut)

    for (const date of covered) {
      assert.ok(byDate.has(date), `${date} is inside the import and must be answered for`)
      if (date !== CURRENT_FIRST) {
        assert.equal(byDate.get(date), 'absent', `A has no punch on ${date}, which is a real absence`)
      }
    }
    if (covered.includes(CURRENT_FIRST)) {
      assert.equal(byDate.get(CURRENT_FIRST), 'present', 'the day A did punch must read as present')
    }
  })

  test('7. the cut-off is not a way to read a colleague current month', async () => {
    const res = await monthlyDetail(req(
      `/api/attendance/employee-monthly-detail?employee_id=${actors.b.id}` +
      `&year=${CURRENT.year}&month=${CURRENT.month}`,
      actors.a.token,
    ))
    assert.equal(res.status, 403, 'the current month is no more readable than any other')
  })

  test('the admin monthly summary applies the same cut-off', async () => {
    const res = await monthlySummary(req(
      `/api/attendance/monthly-summary?year=${CURRENT.year}&month=${CURRENT.month}`,
      actors.admin.token,
    ))
    assert.equal(res.status, 200)
    const body = await res.json()

    const cut = await companyLatest()
    assert.equal(body.coverage_through, cut)

    // The denominator is the COVERED working days — not the whole month, which
    // is what made every employee look absent for the rest of it.
    const expected = (await coveredWorkingDates(cut)).length
    for (const s of body.summaries as { total_records: number }[]) {
      assert.equal(s.total_records, expected,
        'an admin must be shown the same month the employee is')
    }
  })
})

// ─── Payroll routes ───────────────────────────────────────────────────────────

describe('payroll admin routes', () => {
  test('14g. the period results list refuses an employee and a manager', async () => {
    assert.equal((await payrollResults(req(`/api/payroll/results?period_id=${created.periodId}`, actors.a.token))).status, 403)
    assert.equal((await payrollResults(req(`/api/payroll/results?period_id=${created.periodId}`, actors.manager.token))).status, 403)
  })

  test('15g. the period results list answers an admin with every employee', async () => {
    const res = await payrollResults(req(`/api/payroll/results?period_id=${created.periodId}`, actors.admin.token))
    assert.equal(res.status, 200)
    const { results } = await res.json()
    assert.equal(results.length, 2)
  })

  test('the per-employee result detail refuses a non-admin pointed at anyone', async () => {
    const mine = await payrollResultDetail(req(
      `/api/payroll/results/detail?period_id=${created.periodId}&employee_id=${actors.a.id}`, actors.a.token))
    assert.equal(mine.status, 403, 'even for their own id, this is the admin review surface')

    const theirs = await payrollResultDetail(req(
      `/api/payroll/results/detail?period_id=${created.periodId}&employee_id=${actors.b.id}`, actors.a.token))
    assert.equal(theirs.status, 403)
  })
})

describe('the employee payroll route derives identity from the session', () => {
  test('3/4. /api/payroll/my-result returns the caller own result and nobody else', async () => {
    const res = await myResult(req(`/api/payroll/my-result?period_id=${created.periodId}`, actors.a.token))
    assert.equal(res.status, 200)
    const { result } = await res.json()
    assert.equal(result.id, created.resultA)
    assert.equal(Number(result.net_salary), 27000.5, 'A must see A figures')
  })

  test('8. tampering with the URL period id cannot surface another employee', async () => {
    // The route takes a PERIOD id, never an employee id, and always pairs it
    // with the caller's own id — so a guessed or stolen id can only ever return
    // the caller's own row for that month, or nothing.
    const res = await myResult(req(`/api/payroll/my-result?period_id=${created.periodId}`, actors.b.token))
    const { result } = await res.json()
    assert.equal(result.id, created.resultB)
    assert.notEqual(result.id, created.resultA)
  })

  // The employee's detail view now renders the same workspace an admin sees,
  // which means it needs the same payload. What must NOT come with it is any
  // authority: same document, same figures, no edit path.
  test('the employee detail payload is the shared one, with editing off', async () => {
    const res = await myResult(req(`/api/payroll/my-result?period_id=${created.periodId}`, actors.a.token))
    assert.equal(res.status, 200)
    const body = await res.json()

    for (const key of ['period', 'result', 'deduction_days', 'considered_days', 'corrections']) {
      assert.ok(key in body, `the employee payload is missing ${key}`)
    }
    assert.equal(body.can_edit, false, 'an employee must never be handed can_edit true')
    assert.equal(body.result.employee_id, actors.a.id, 'and only ever their own result')
  })

  test('the figures an employee sees are the ones the engine stored', async () => {
    const res  = await myResult(req(`/api/payroll/my-result?period_id=${created.periodId}`, actors.a.token))
    const body = await res.json()

    const { data: stored } = await svc.from('payroll_results')
      .select('gross_salary, total_deductions, net_salary')
      .eq('id', created.resultA).single()

    assert.equal(Number(body.result.gross_salary),     Number(stored!.gross_salary))
    assert.equal(Number(body.result.total_deductions), Number(stored!.total_deductions))
    assert.equal(Number(body.result.net_salary),       Number(stored!.net_salary),
      'the page must render what the engine settled, never a recalculation')
  })

  test('10. an employee with no result in a period gets a not-found, not a colleague row', async () => {
    const res = await myResult(req(`/api/payroll/my-result?period_id=${created.periodId}`, actors.manager.token))
    assert.ok(res.status === 404 || res.status === 500, `expected no result, got ${res.status}`)
    const body = await res.json()
    assert.ok(!('result' in body), 'no payroll row may be returned')
  })

  test('16c. an unauthenticated call is refused', async () => {
    assert.equal((await myResult(req('/api/payroll/my-result'))).status, 401)
    assert.equal((await employeeRecords(req(`/api/attendance/employee-records?employee_id=${actors.a.id}`))).status, 401)
    assert.equal((await monthlySummary(req(`/api/attendance/monthly-summary?year=${TEST_YEAR}&month=${TEST_MONTH}`))).status, 401)
  })

  test('a garbage bearer token is refused', async () => {
    const res = await employeeRecords(req(`/api/attendance/employee-records?employee_id=${actors.a.id}`, 'not-a-real-token'))
    assert.equal(res.status, 401)
  })
})
