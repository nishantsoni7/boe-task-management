// Route-level tests for /api/attendance-requests: authorisation, and the
// review → attendance correction → payroll draft effect.
//
// The handlers, the shared correction service, the payroll store functions and
// the payroll ENGINE all run for real; only the database is an in-memory stand-in
// (./testing/memorySupabase.ts). Nothing here reaches the linked Supabase
// project, so it is safe to run anywhere.

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { MemorySupabase } from './testing/memorySupabase'
import {
  listRequests, submitRequest, cancelRequest, decideRequest, requestHistory, getReconciliation, saveReview,
} from './requestHandlers'
import type { Caller } from '@/lib/security/attendancePayrollApiAuth'
import { DEFAULT_PAYROLL_SETTINGS } from '@/lib/payroll/settings'
import { generatePayrollForEmployee } from '@/lib/payroll/engine'
import {
  fetchPeriod, fetchEmployee, fetchAttendanceForPeriod, fetchHolidaysForPeriod, fetchPendingAdjustments,
  fetchCurrentCorrections, createGenerationRow, writeEngineResult,
} from '@/lib/payroll/store'
import { isSkip } from '@/lib/payroll/types'
import { applyAttendanceCorrection } from '@/lib/payroll/attendanceCorrectionService'
import { lockPayrollPeriod } from '@/lib/payroll/lockPeriod'
import { istClockToUtc } from '@/lib/istDate'
import type { ReconEvent, ReconResult } from './requestReconciliation'

const ADMIN_A = 'aaaaaaaa-0000-0000-0000-00000000000a'   // "Nishant"
const ADMIN_B = 'bbbbbbbb-0000-0000-0000-00000000000b'
const EMP     = 'eeeeeeee-0000-0000-0000-00000000000e'
const OTHER   = 'ffffffff-0000-0000-0000-00000000000f'
const PERIOD  = '99999999-0000-0000-0000-000000000099'
// The day after October ends: payroll for October may be generated and locked.
const TODAY   = '2026-11-01'

let db: MemorySupabase

const caller = (id: string, role: string): Caller =>
  ({ svc: db as unknown as Caller['svc'], id, role, team: null, isAdmin: role === 'admin' })
const nishant = () => caller(ADMIN_A, 'admin')
const secondAdmin = () => caller(ADMIN_B, 'admin')
const employee = () => caller(EMP, 'member')
const colleague = () => caller(OTHER, 'member')

/** October 2026: working days Mon–Sat. Everyone on time unless overridden. */
function month(userId: string, overrides: Record<string, [string, string] | null>) {
  const rows = []
  for (let d = 1; d <= 31; d++) {
    const date = `2026-10-${String(d).padStart(2, '0')}`
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) continue
    const o = date in overrides ? overrides[date] : ['09:55', '18:35']
    if (!o) continue
    rows.push({
      id: `${userId}-${date}`, user_id: userId, attendance_date: date,
      check_in_at: istClockToUtc(date, o[0]), check_out_at: istClockToUtc(date, o[1]),
      punch_direction_source: 'confirmed', status: 'present',
    })
  }
  return rows
}

function seed() {
  const user = (id: string, name: string, role: string, payroll: boolean) => ({
    id, full_name: name, role, is_active: true, is_deleted: false, employee_code: name.slice(0, 3).toUpperCase(),
    monthly_salary: 26000, payroll_active: payroll, joining_date: null, employment_type: 'permanent',
  })
  db = new MemorySupabase({
    users: [
      user(ADMIN_A, 'Nishant', 'admin', true),
      user(ADMIN_B, 'Second Admin', 'admin', false),
      user(EMP, 'Asha', 'member', true),
      user(OTHER, 'Bala', 'member', true),
    ],
    payroll_periods: [{
      id: PERIOD, payroll_month: 10, payroll_year: 2026, status: 'generated',
      settings_snapshot: DEFAULT_PAYROLL_SETTINGS,
    }],
    attendance_records: [
      // 1 Oct absent (paid leave will absorb it), 5 Oct 10:40 (informed),
      // 6 Oct 10:50 (company vehicle, reported late), 7–10 Oct late, uninformed.
      ...month(EMP, {
        '2026-10-01': null,
        '2026-10-05': ['10:40', '18:35'],
        '2026-10-06': ['10:50', '18:35'],
        '2026-10-07': ['10:35', '18:35'],
        '2026-10-08': ['10:35', '18:35'],
        '2026-10-09': ['10:35', '18:35'],
        '2026-10-10': ['10:35', '18:35'],
      }),
      ...month(OTHER, {}),
      ...month(ADMIN_A, { '2026-10-12': ['10:45', '18:35'] }),
    ],
    payroll_holidays: [], payroll_pending_adjustments: [], attendance_day_corrections: [],
    boe_credit_attendance_redemptions: [], payroll_settings: [], attendance_requests: [],
    attendance_request_events: [], attendance_day_reviews: [], notifications: [],
    payroll_results: [], payroll_deduction_lines: [], payroll_generation: [],
  })
}

/** Generate the October draft the way generation does, through the store. */
async function generateDraft(employeeId: string) {
  const svc = db as never
  const period = await fetchPeriod(svc, PERIOD)
  const emp = await fetchEmployee(svc, employeeId)
  const out = generatePayrollForEmployee(
    emp!, period,
    await fetchAttendanceForPeriod(svc, employeeId, 10, 2026),
    await fetchHolidaysForPeriod(svc, 10, 2026),
    await fetchPendingAdjustments(svc, employeeId, PERIOD, 10, 2026),
    await fetchCurrentCorrections(svc, employeeId, 10, 2026),
    DEFAULT_PAYROLL_SETTINGS,
  )
  assert.ok(!isSkip(out))
  const gen = await createGenerationRow(svc, PERIOD, ADMIN_B)
  await writeEngineResult(svc, gen, out)
  return out
}

const result = (id: string) => db.rows('payroll_results').find(r => r.employee_id === id)!
const linesOn = (id: string, date: string, type: string) => {
  const res = result(id)
  return db.rows('payroll_deduction_lines').filter(l => l.payroll_result_id === res.id && l.line_date === date && l.deduction_type === type)
}
const currentCorrections = (id: string, date: string) =>
  db.rows('attendance_day_corrections').filter(c => c.user_id === id && c.attendance_date === date && c.is_current)

async function review(): Promise<ReconResult> {
  const r = await getReconciliation(secondAdmin(), 2026, 10, false, TODAY)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body.result as ReconResult
}
async function eventOf(date: string, key: string, who = EMP): Promise<ReconEvent> {
  const ev = (await review()).employees.find(e => e.employee.id === who)!.events.find(e => e.date === date && e.event_key === key)
  assert.ok(ev, `no ${key} event on ${date}`)
  return ev!
}

beforeEach(seed)

// ─── Authorisation ───────────────────────────────────────────────────────────

describe('authorisation', () => {
  test('the route answers 401 before touching any database without a bearer token', async () => {
    const { GET } = await import('../../app/api/attendance-requests/route')
    const res = await GET(new NextRequest('http://localhost/api/attendance-requests?scope=queue'))
    assert.equal(res.status, 401)
    const rec = await import('../../app/api/attendance-requests/reconciliation/route')
    const res2 = await rec.POST(new NextRequest('http://localhost/api/attendance-requests/reconciliation', { method: 'POST', body: '{}' }))
    assert.equal(res2.status, 401)
  })

  test('an employee cannot read the queue, the payroll review, or decide anything', async () => {
    assert.equal((await listRequests(employee(), 'queue', 'all')).status, 403)
    assert.equal((await getReconciliation(employee(), 2026, 10, false, TODAY)).status, 403)
    assert.equal((await getReconciliation(employee(), 2026, 10, true, TODAY)).status, 403)
    assert.equal((await saveReview(employee(), { employee_id: EMP, attendance_date: '2026-10-05', event_key: 'late_arrival', pay_decision: 'paid_waived', decision_reason: 'x' }, TODAY)).status, 403)
    const sub = await submitRequest(colleague(), { request_type: 'late_arrival', start_date: '2026-10-20', reason_code: 'personal' }, '2026-10-19T12:00:00Z')
    const id = (sub.body.request as { id: string }).id
    assert.equal((await decideRequest(employee(), id, { status: 'approved' }, '2026-10-19T13:00:00Z')).status, 403)
  })

  test('an employee only ever reads, cancels and traces their OWN requests; the body cannot name someone else', async () => {
    const mine = await submitRequest(employee(), {
      request_type: 'late_arrival', start_date: '2026-10-20', reason_code: 'personal', employee_id: OTHER,
    }, '2026-10-19T12:00:00Z')
    assert.equal(mine.status, 201)
    assert.equal((mine.body.request as { employee_id: string }).employee_id, EMP, 'employee_id in the body is ignored')
    const theirs = await submitRequest(colleague(), { request_type: 'full_day_leave', start_date: '2026-10-22', reason_code: 'medical' }, '2026-10-19T12:00:00Z')
    const theirId = (theirs.body.request as { id: string }).id

    const list = await listRequests(employee(), null, null)
    assert.deepEqual((list.body.requests as { employee_id: string }[]).map(r => r.employee_id), [EMP])
    assert.equal((await cancelRequest(employee(), theirId, {}, '2026-10-19T13:00:00Z')).status, 404)
    assert.equal((await requestHistory(employee(), theirId)).status, 404, 'same answer as "does not exist"')
    assert.equal((await requestHistory(secondAdmin(), theirId)).status, 200)
  })

  test('an inactive employee cannot submit', async () => {
    db.rows('users').find(u => u.id === EMP)!.is_active = false
    assert.equal((await submitRequest(employee(), { request_type: 'late_arrival', start_date: '2026-10-20', reason_code: 'personal' }, '2026-10-19T12:00:00Z')).status, 403)
  })
})

// ─── Case 7: self-approval ───────────────────────────────────────────────────

describe('case 7 — an admin never decides their own request or attendance', () => {
  test('another admin must decide; with a second admin available the refusal says so', async () => {
    const sub = await submitRequest(nishant(), { request_type: 'late_arrival', start_date: '2026-10-20', reason_code: 'personal' }, '2026-10-19T12:00:00Z')
    const id = (sub.body.request as { id: string }).id
    const self = await decideRequest(nishant(), id, { status: 'approved' }, '2026-10-19T13:00:00Z')
    assert.equal(self.status, 403)
    assert.equal(self.body.other_admins, 1)
    assert.match(String(self.body.error), /Another admin must decide/)
    assert.equal((await decideRequest(secondAdmin(), id, { status: 'approved' }, '2026-10-19T13:00:00Z')).status, 200)
  })

  test('the only active admin is refused too, and told why — no bypass', async () => {
    db.rows('users').find(u => u.id === ADMIN_B)!.is_active = false
    const sub = await submitRequest(nishant(), { request_type: 'late_arrival', start_date: '2026-10-20', reason_code: 'personal' }, '2026-10-19T12:00:00Z')
    const r = await decideRequest(nishant(), (sub.body.request as { id: string }).id, { status: 'approved' }, '2026-10-19T13:00:00Z')
    assert.equal(r.status, 403)
    assert.equal(r.body.other_admins, 0)
    assert.match(String(r.body.error), /only active admin/)
  })

  test('the same rule holds in the payroll review', async () => {
    await generateDraft(ADMIN_A)
    const r = await saveReview(nishant(), { employee_id: ADMIN_A, attendance_date: '2026-10-12', event_key: 'late_arrival', pay_decision: 'paid_waived', decision_reason: 'mine' }, TODAY)
    assert.equal(r.status, 403)
    assert.equal(currentCorrections(ADMIN_A, '2026-10-12').length, 0, 'nothing was applied')
  })
})

// ─── Cases 1 & 2: review → correction → payroll ─────────────────────────────

describe('cases 1 & 2 — the review decision changes the draft through the correction path', () => {
  test('informed 10:40 late arrival: approval alone does not pay it; Paid/waived does, once; Unpaid restores it', async () => {
    // Employee informs at 08:30 IST; a second admin approves.
    const sub = await submitRequest(employee(), { request_type: 'late_arrival', start_date: '2026-10-05', reason_code: 'personal' }, '2026-10-05T03:00:00Z')
    assert.equal((sub.body.request as { informed_before_shift: boolean }).informed_before_shift, true)
    await decideRequest(secondAdmin(), (sub.body.request as { id: string }).id, { status: 'approved' }, '2026-10-05T03:10:00Z')

    const draft = await generateDraft(EMP)
    const lateLine = linesOn(EMP, '2026-10-05', 'late_arrival')
    assert.equal(lateLine.length, 1)
    assert.equal(lateLine[0].hours_deducted, 1)
    const charged = Number(lateLine[0].amount_deducted)
    assert.equal(charged, 118, '1 h at ₹26,000 / 26 / 8.5, rounded to the rupee')

    // Approved and informed — but the 40 minutes are still charged until the
    // salary treatment says otherwise.
    let ev = await eventOf('2026-10-05', 'late_arrival')
    assert.equal(ev.informed, true)
    assert.equal(ev.request?.status, 'approved')
    assert.equal(ev.salary_status, 'needs_decision')
    assert.equal(ev.draft_amount, 118)
    // Item 1: what the review states is what the real engine wrote to the draft.
    assert.equal(ev.charge?.text, '40 minutes late · payroll rule charges 1 hour · ₹118 proposed in the draft')
    assert.equal(ev.charge?.rule_hours, Number(lateLine[0].hours_deducted))
    assert.equal(ev.charge?.draft_amount, Number(lateLine[0].amount_deducted))

    // Paid / waived → one correction, applied through the shared service.
    const saved = await saveReview(secondAdmin(), {
      employee_id: EMP, attendance_date: '2026-10-05', event_key: 'late_arrival',
      pay_decision: 'paid_waived', decision_reason: 'Informed; client visit overran',
    }, TODAY)
    assert.equal(saved.status, 201, JSON.stringify(saved.body))
    assert.equal(saved.body.application, 'apply')
    const applied = saved.body.applied as { before: { deduction_amount: number }; after: { deduction_amount: number }; net_salary: number }
    assert.equal(applied.before.deduction_amount, 118)
    assert.equal(applied.after.deduction_amount, 0)
    assert.equal(applied.net_salary, draft.net_salary + 118)
    assert.equal(Number(result(EMP).net_salary), draft.net_salary + 118, 'the stored draft moved')

    const corr = currentCorrections(EMP, '2026-10-05')
    assert.equal(corr.length, 1)
    assert.equal(corr[0].waive_late_arrival, true)
    assert.equal(corr[0].corrected_check_in_at, istClockToUtc('2026-10-05', '10:40'), 'the actual punch is preserved')
    assert.equal(corr[0].corrected_by, ADMIN_B)
    assert.match(String(corr[0].remark), /Payroll review: Paid \/ waived — Informed; client visit overran/)
    assert.equal(corr[0].original_deduction_amount, 118)
    assert.equal(corr[0].revised_deduction_amount, 0)

    ev = await eventOf('2026-10-05', 'late_arrival')
    assert.equal(ev.salary_status, 'resolved')
    assert.equal(ev.decision?.applied_correction_id, corr[0].id)

    // Saving the same decision again writes nothing: no second waiver.
    const again = await saveReview(secondAdmin(), {
      employee_id: EMP, attendance_date: '2026-10-05', event_key: 'late_arrival', pay_decision: 'paid_waived', decision_reason: 'Same',
    }, TODAY)
    assert.equal(again.body.application, 'none')
    assert.equal(db.rows('attendance_day_corrections').filter(c => c.user_id === EMP && c.attendance_date === '2026-10-05').length, 1)

    // A full regeneration keeps the waiver and does not double anything.
    await generateDraft(EMP)
    assert.equal(Number(result(EMP).net_salary), draft.net_salary + 118)
    assert.equal(linesOn(EMP, '2026-10-05', 'late_arrival').length, 0, 'a waived late arrival produces no line at all')

    // Unpaid actual time → a NEW correction version turns the waiver off; the
    // earlier one is kept as history.
    const unpaid = await saveReview(secondAdmin(), {
      employee_id: EMP, attendance_date: '2026-10-05', event_key: 'late_arrival', pay_decision: 'unpaid_actual', decision_reason: 'Policy',
    }, TODAY)
    assert.equal(unpaid.body.application, 'apply')
    assert.equal(Number(result(EMP).net_salary), draft.net_salary)
    const versions = db.rows('attendance_day_corrections').filter(c => c.user_id === EMP && c.attendance_date === '2026-10-05')
    assert.equal(versions.length, 2)
    assert.equal(versions.filter(v => v.is_current).length, 1)
    assert.equal(linesOn(EMP, '2026-10-05', 'late_arrival').length, 1, 'still exactly one late line')
    assert.equal((await eventOf('2026-10-05', 'late_arrival')).salary_status, 'resolved')
  })

  test('company vehicle reported after 10:00: excused AND waived; the review stops warning', async () => {
    const sub = await submitRequest(employee(), { request_type: 'late_arrival', start_date: '2026-10-06', reason_code: 'company_vehicle' }, '2026-10-06T05:00:00Z')
    assert.equal((sub.body.request as { informed_before_shift: boolean }).informed_before_shift, false, '10:30 IST is after the shift start')
    await generateDraft(EMP)

    let ev = await eventOf('2026-10-06', 'late_arrival')
    assert.equal(ev.informed, false)
    assert.equal(ev.company_exception, true)
    assert.equal(ev.counts_toward_policy, true)

    const saved = await saveReview(secondAdmin(), {
      employee_id: EMP, attendance_date: '2026-10-06', event_key: 'late_arrival',
      excused: true, excuse_reason: 'Company vehicle broke down; driver confirmed',
      pay_decision: 'paid_waived', decision_reason: 'Company vehicle delay',
    }, TODAY)
    assert.equal(saved.status, 201, JSON.stringify(saved.body))
    ev = await eventOf('2026-10-06', 'late_arrival')
    assert.equal(ev.excused, true)
    assert.equal(ev.counts_toward_policy, false)
    assert.equal(ev.salary_status, 'resolved')
    assert.equal(ev.action_note, null)
    assert.equal(ev.draft_amount, 0)
  })

  test('if the correction path fails, the decision is NOT recorded', async () => {
    await generateDraft(EMP)
    db.failOn.set('payroll_deduction_lines:insert', 'simulated write failure')
    const r = await saveReview(secondAdmin(), {
      employee_id: EMP, attendance_date: '2026-10-07', event_key: 'late_arrival', pay_decision: 'paid_waived', decision_reason: 'x',
    }, TODAY)
    assert.equal(r.status, 500)
    assert.match(String(r.body.error), /decision was not saved/)
    assert.equal(db.rows('attendance_day_reviews').length, 0)
    assert.equal(currentCorrections(EMP, '2026-10-07').length, 0, 'the correction was rolled back')
  })
})

// ─── Case 3: the monthly flag ────────────────────────────────────────────────

describe('case 3 — four uninformed, unexcused late days: a flag, never a deduction', () => {
  test('the fourth is flagged; excusing an earlier one clears it; pay is untouched by both', async () => {
    await generateDraft(EMP)
    const net = Number(result(EMP).net_salary)
    // 5, 6, 7, 8, 9, 10 Oct are all late and nobody informed.
    let emp = (await review()).employees.find(e => e.employee.id === EMP)!
    assert.equal(emp.uninformed_late_count, 6)
    assert.deepEqual(emp.policy_flag_dates, ['2026-10-08', '2026-10-09', '2026-10-10'])

    for (const d of ['2026-10-05', '2026-10-06', '2026-10-07']) {
      const r = await saveReview(secondAdmin(), { employee_id: EMP, attendance_date: d, event_key: 'late_arrival', excused: true, excuse_reason: 'Emergency reported by phone' }, TODAY)
      assert.equal(r.status, 201)
    }
    emp = (await review()).employees.find(e => e.employee.id === EMP)!
    assert.equal(emp.uninformed_late_count, 3)
    assert.deepEqual(emp.policy_flag_dates, [], 'three is not more than three')
    assert.equal(Number(result(EMP).net_salary), net, 'an excuse is not a salary decision')
    assert.equal(db.rows('attendance_day_corrections').length, 0)
  })
})

// ─── Case 4: time out ────────────────────────────────────────────────────────

describe('case 4 — a personal time out with no mid-day punches', () => {
  test('cannot be decided as unpaid; "no deduction" writes no correction and invents no minutes', async () => {
    const sub = await submitRequest(employee(), {
      request_type: 'time_out', start_date: '2026-10-14', departure_time: '14:00', return_time: '15:30', work_kind: 'personal', reason_code: 'personal',
    }, '2026-10-14T03:00:00Z')
    const reqId = (sub.body.request as { id: string }).id
    await generateDraft(EMP)
    const net = Number(result(EMP).net_salary)

    const ev = await eventOf('2026-10-14', `request:${reqId}`)
    assert.match(ev.title, /actual time away unavailable/)
    assert.equal(ev.draft_amount, 0)

    const unpaid = await saveReview(secondAdmin(), { employee_id: EMP, attendance_date: '2026-10-14', event_key: `request:${reqId}`, pay_decision: 'unpaid_actual', decision_reason: '90 min' }, TODAY)
    assert.equal(unpaid.status, 400)
    assert.match(String(unpaid.body.error), /Actual time away is unavailable/)

    const none = await saveReview(secondAdmin(), { employee_id: EMP, attendance_date: '2026-10-14', event_key: `request:${reqId}`, pay_decision: 'paid_waived', decision_reason: 'Approved errand' }, TODAY)
    assert.equal(none.status, 201)
    assert.equal(none.body.application, 'none')
    assert.equal(db.rows('attendance_day_corrections').length, 0)
    assert.equal(Number(result(EMP).net_salary), net)
    assert.equal((await eventOf('2026-10-14', `request:${reqId}`)).salary_status, 'resolved')
  })
})

// ─── Case 5: automatic paid leave ────────────────────────────────────────────

describe('case 5 — automatic paid leave is reported as the engine\'s rule', () => {
  test('1 Oct absent is absorbed by earned paid leave; the review says so and offers no "use paid leave"', async () => {
    await generateDraft(EMP)
    const absent = linesOn(EMP, '2026-10-01', 'absent')
    assert.equal(absent.length, 1)
    assert.equal(Number(absent[0].amount_deducted), 0, 'the engine absorbed it')
    const ev = await eventOf('2026-10-01', 'absent')
    assert.match(ev.payroll_state, /automatic paid leave/)
    assert.match(ev.payroll_state, /not a manual choice/)
    assert.equal(ev.allowed_decisions.includes('use_paid_leave' as never), false)
    const bad = await saveReview(secondAdmin(), { employee_id: EMP, attendance_date: '2026-10-01', event_key: 'absent', pay_decision: 'use_paid_leave', decision_reason: 'x' }, TODAY)
    assert.equal(bad.status, 400)
  })

  test('an absence with a charge, decided Paid/waived, stays "Action required in payroll" until the payslip matches', async () => {
    // A second absence is not absorbed (one paid leave a month).
    db.tables.attendance_records = db.rows('attendance_records').filter(r => !(r.user_id === EMP && r.attendance_date === '2026-10-13'))
    await generateDraft(EMP)
    assert.ok(Number(linesOn(EMP, '2026-10-13', 'absent')[0].amount_deducted) > 0)
    const r = await saveReview(secondAdmin(), { employee_id: EMP, attendance_date: '2026-10-13', event_key: 'absent', pay_decision: 'paid_waived', decision_reason: 'Approved leave' }, TODAY)
    assert.equal(r.status, 201)
    assert.equal(r.body.application, 'action_required')
    const ev = await eventOf('2026-10-13', 'absent')
    assert.equal(ev.salary_status, 'action_required')
    assert.equal(ev.resolved, false)
    assert.match(ev.action_note!, /Open the payslip/)
    const summary = await getReconciliation(secondAdmin(), 2026, 10, true, TODAY)
    assert.ok((summary.body.totals as { conflicts: number }).conflicts >= 1, 'the lock step sees it')
  })
})

// ─── Case 6: locked month ────────────────────────────────────────────────────

describe('case 6 — a locked month refuses every new review and correction write', () => {
  test('saveReview and the correction service both refuse; nothing is written', async () => {
    await generateDraft(EMP)
    const net = Number(result(EMP).net_salary)
    db.rows('payroll_periods')[0].status = 'locked'

    const r = await saveReview(secondAdmin(), { employee_id: EMP, attendance_date: '2026-10-05', event_key: 'late_arrival', pay_decision: 'paid_waived', decision_reason: 'x' }, TODAY)
    assert.equal(r.status, 422)
    const excuse = await saveReview(secondAdmin(), { employee_id: EMP, attendance_date: '2026-10-05', event_key: 'late_arrival', excused: true, excuse_reason: 'x' }, TODAY)
    assert.equal(excuse.status, 422)

    const direct = await applyAttendanceCorrection(db, {
      periodId: PERIOD, employeeId: EMP, actorId: ADMIN_B, today: TODAY,
      correction: {
        attendance_date: '2026-10-05', corrected_check_in_at: istClockToUtc('2026-10-05', '10:40'),
        corrected_check_out_at: istClockToUtc('2026-10-05', '18:35'), day_treatment: 'auto',
        waive_late_arrival: true, waive_early_checkout: false, waive_missing_punch: false, remark: 'x',
      },
    })
    assert.equal(direct.ok, false)
    assert.equal(db.rows('attendance_day_corrections').length, 0)
    assert.equal(db.rows('attendance_day_reviews').length, 0)
    assert.equal(Number(result(EMP).net_salary), net)
  })
})

// ─── The correction service now uses the period's pinned settings ───────────

describe('the shared correction service', () => {
  test('recalculates with the settings pinned to the period, not the defaults', async () => {
    // Pin a 30-minute grace end (10:30): a 10:35 arrival is 35 min late → 1 h.
    // Pin a different divisor so the rate visibly differs from the defaults.
    db.rows('payroll_periods')[0].settings_snapshot = { ...DEFAULT_PAYROLL_SETTINGS, per_day_divisor: 30 }
    const out = await applyAttendanceCorrection(db, {
      periodId: PERIOD, employeeId: EMP, actorId: ADMIN_B, today: TODAY,
      correction: {
        attendance_date: '2026-10-07', corrected_check_in_at: istClockToUtc('2026-10-07', '10:35'),
        corrected_check_out_at: istClockToUtc('2026-10-07', '18:35'), day_treatment: 'auto',
        waive_late_arrival: false, waive_early_checkout: false, waive_missing_punch: false, remark: 'confirm punches',
      },
    })
    assert.ok(out.ok)
    // 1 h at 26,000 / 30 / 8.5 = ₹102, not the default divisor's ₹118.
    assert.equal(out.ok && out.after.deduction_amount, 102)
  })

  const correct7th = () => applyAttendanceCorrection(db, {
    periodId: PERIOD, employeeId: EMP, actorId: ADMIN_B, today: TODAY,
    correction: {
      attendance_date: '2026-10-07', corrected_check_in_at: istClockToUtc('2026-10-07', '10:35'),
      corrected_check_out_at: istClockToUtc('2026-10-07', '18:35'), day_treatment: 'auto',
      waive_late_arrival: true, waive_early_checkout: false, waive_missing_punch: false, remark: 'waive',
    },
  })
  const fullGeneration = async (settings: typeof DEFAULT_PAYROLL_SETTINGS) => {
    const svc = db as never
    const out = generatePayrollForEmployee(
      (await fetchEmployee(svc, EMP))!, await fetchPeriod(svc, PERIOD),
      await fetchAttendanceForPeriod(svc, EMP, 10, 2026), await fetchHolidaysForPeriod(svc, 10, 2026),
      await fetchPendingAdjustments(svc, EMP, PERIOD, 10, 2026), await fetchCurrentCorrections(svc, EMP, 10, 2026), settings,
    )
    assert.ok(!isSkip(out))
    return out
  }

  test('a correction recalculates to exactly what full generation of the period produces (non-default snapshot)', async () => {
    const snapshot = { ...DEFAULT_PAYROLL_SETTINGS, per_day_divisor: 30 }
    db.rows('payroll_periods')[0].settings_snapshot = snapshot
    const out = await correct7th()
    assert.ok(out.ok)
    const regenerated = await fullGeneration(snapshot)
    assert.equal(out.ok && out.net_salary, regenerated.net_salary, 'the next regeneration will not move the figure')
  })

  test('production today (2026-09-27, read-only check): every unlocked period\'s snapshot equals the defaults, so old and new behaviour agree', async () => {
    db.rows('payroll_periods')[0].settings_snapshot = { ...DEFAULT_PAYROLL_SETTINGS }
    const out = await correct7th()
    assert.ok(out.ok)
    // The old route recalculated with DEFAULT_PAYROLL_SETTINGS.
    assert.equal(out.ok && out.net_salary, (await fullGeneration(DEFAULT_PAYROLL_SETTINGS)).net_salary)
  })
})

// ─── Item 2: locking with open attendance items ─────────────────────────────

describe('item 2 — the lock checks open attendance items on the server and records the acknowledgement', () => {
  const lock = (body: Record<string, unknown>) =>
    lockPayrollPeriod(db, { id: ADMIN_B, name: 'Second Admin' }, { payroll_period_id: PERIOD, ...body }, TODAY)

  // What 20270215000000's lock_payroll_period_with_attendance_ack() does, in one step.
  const emulateLockFunction = () => {
    db.rpcHandlers.lock_payroll_period_with_attendance_ack = (a, d) => {
      const p = d.rows('payroll_periods').find(r => r.id === a.p_period_id)!
      if (p.status === 'locked') return { data: null, error: { message: 'PAYROLL_LOCK_ALREADY' } }
      const ack = {
        id: `ack-${d.rows('payroll_lock_attendance_acknowledgements').length + 1}`,
        payroll_period_id: a.p_period_id, actor_id: a.p_actor_id, acknowledged_at: new Date().toISOString(),
        unresolved_count: a.p_unresolved, conflict_count: a.p_conflicts, fingerprint: a.p_fingerprint,
        summary: a.p_summary, reason: a.p_reason,
      }
      ;(d.tables.payroll_lock_attendance_acknowledgements ??= []).push(ack)
      Object.assign(p, { status: 'locked', locked_by: a.p_actor_id, locked_at: new Date().toISOString() })
      return { data: ack.id, error: null }
    }
    db.tables.payroll_lock_attendance_acknowledgements = []
    db.tables.payroll_period_status_events = []
  }
  const period = () => db.rows('payroll_periods')[0]

  test('a month with nothing open keeps the simple lock: no acknowledgement asked, none recorded', async () => {
    emulateLockFunction()
    for (const u of db.rows('users')) if (u.id !== OTHER) u.payroll_active = false   // only Bala, always on time
    await generateDraft(OTHER)
    const r = await lock({})
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(period().status, 'locked')
    assert.equal(db.rows('payroll_lock_attendance_acknowledgements').length, 0)
    assert.equal(db.rows('payroll_period_status_events').length, 1)
  })

  test('open items: a direct lock call without an acknowledgement is refused and nothing is locked', async () => {
    emulateLockFunction()
    await generateDraft(EMP)
    const r = await lock({})
    assert.equal(r.status, 409)
    assert.equal(r.body.code, 'attendance_unresolved')
    assert.ok((r.body.unresolved as number) > 0)
    assert.match(String(r.body.fingerprint), /^[0-9a-f]{64}$/)
    assert.equal(period().status, 'generated')
  })

  test('acknowledging the current state with a reason locks and records actor, time, counts, fingerprint and summary', async () => {
    emulateLockFunction()
    await generateDraft(EMP)
    const first = await lock({})
    const r = await lock({ attendance_acknowledgement: { fingerprint: first.body.fingerprint, reason: 'Reviewed with accounts; late days settled next month' } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.locked_with_open_items, true)
    assert.equal(period().status, 'locked')
    const [ack] = db.rows('payroll_lock_attendance_acknowledgements')
    assert.equal(ack.actor_id, ADMIN_B)
    assert.equal(ack.unresolved_count, first.body.unresolved)
    assert.equal(ack.conflict_count, first.body.conflicts)
    assert.equal(ack.fingerprint, first.body.fingerprint)
    assert.match(String(ack.reason), /Reviewed with accounts/)
    const summary = ack.summary as Record<string, unknown>[]
    assert.ok(summary.length > 0)
    for (const e of summary) assert.deepEqual(Object.keys(e).sort(), ['conflicts', 'employee_id', 'unresolved'], 'counts only — no names or amounts')
    assert.equal(db.rows('payroll_period_status_events').length, 1)
  })

  test('if the review changes between looking and locking, the stale acknowledgement is refused', async () => {
    emulateLockFunction()
    await generateDraft(EMP)
    const first = await lock({})
    // Another admin settles one item in the meantime.
    await saveReview(secondAdmin(), { employee_id: EMP, attendance_date: '2026-10-07', event_key: 'late_arrival', pay_decision: 'unpaid_actual', decision_reason: 'Policy' }, TODAY)
    const r = await lock({ attendance_acknowledgement: { fingerprint: first.body.fingerprint, reason: 'ok' } })
    assert.equal(r.status, 409)
    assert.equal(r.body.code, 'attendance_ack_stale')
    assert.notEqual(r.body.fingerprint, first.body.fingerprint)
    assert.equal(period().status, 'generated')
    assert.equal(db.rows('payroll_lock_attendance_acknowledgements').length, 0)
    // …and the fresh acknowledgement then works.
    const again = await lock({ attendance_acknowledgement: { fingerprint: r.body.fingerprint, reason: 'Re-reviewed' } })
    assert.equal(again.status, 200)
  })

  test('an acknowledgement without a reason is refused', async () => {
    emulateLockFunction()
    await generateDraft(EMP)
    const first = await lock({})
    const r = await lock({ attendance_acknowledgement: { fingerprint: first.body.fingerprint, reason: '  ' } })
    assert.equal(r.status, 400)
    assert.equal(period().status, 'generated')
  })

  test('UNREADABLE review: the lock fails with a retryable 503 and nothing — not even an acknowledgement with a reason — locks it', async () => {
    emulateLockFunction()
    await generateDraft(EMP)
    const known = await lock({})                     // read successfully first, to hold a valid fingerprint
    assert.equal(known.body.code, 'attendance_unresolved')
    db.failOn.set('attendance_day_reviews:select', 'connection reset by peer')
    for (const body of [
      {},
      { attendance_acknowledgement: { fingerprint: known.body.fingerprint, reason: 'I know what is open' } },
      { attendance_acknowledgement: { unverified: true, reason: 'override please' } },
    ]) {
      const r = await lock(body)
      assert.equal(r.status, 503, JSON.stringify(body))
      assert.equal(r.body.code, 'attendance_review_unavailable')
      assert.equal(r.body.retryable, true)
    }
    assert.equal(period().status, 'generated')
    assert.equal(db.rows('payroll_lock_attendance_acknowledgements').length, 0)
    assert.equal(db.rows('payroll_period_status_events').length, 0)
    // Once the read works again, the ordinary acknowledgement path applies.
    db.failOn.clear()
    const r = await lock({ attendance_acknowledgement: { fingerprint: known.body.fingerprint, reason: 'Reviewed' } })
    assert.equal(r.status, 200)
  })

  test('READ review with open items: the acknowledgement is accepted and recorded (the separate, legitimate path)', async () => {
    emulateLockFunction()
    await generateDraft(EMP)
    const first = await lock({})
    assert.equal(first.status, 409)
    assert.equal(first.body.code, 'attendance_unresolved')
    const r = await lock({ attendance_acknowledgement: { fingerprint: first.body.fingerprint, reason: 'Known items; settled next month' } })
    assert.equal(r.status, 200)
    assert.equal(db.rows('payroll_lock_attendance_acknowledgements')[0].fingerprint, first.body.fingerprint)
  })

  test('a month that has not ended cannot be locked, even with nothing open and a generated draft', async () => {
    emulateLockFunction()
    await generateDraft(EMP)
    const r = await lockPayrollPeriod(db, { id: ADMIN_B, name: 'Second Admin' }, { payroll_period_id: PERIOD }, '2026-10-27')
    assert.equal(r.status, 422)
    assert.equal(r.body.code, 'payroll_month_in_progress')
    assert.match(String(r.body.error), /October 2026 has not ended yet[\s\S]*from 1 Nov \(IST\)/)
    assert.equal(period().status, 'generated')
  })

  test('an already locked month is refused as before', async () => {
    emulateLockFunction()
    period().status = 'locked'
    assert.equal((await lock({})).status, 422)
  })
})

describe('item 1 — an in-progress month', () => {
  test('a waiver decision mid-month is refused before anything is written; an excuse (no pay effect) is still recorded', async () => {
    await generateDraft(EMP)
    const MID = '2026-10-20'
    const r = await saveReview(secondAdmin(), { employee_id: EMP, attendance_date: '2026-10-05', event_key: 'late_arrival', pay_decision: 'paid_waived', decision_reason: 'x' }, MID)
    assert.equal(r.status, 422)
    assert.match(String(r.body.error), /October 2026 has not ended yet/)
    assert.equal(db.rows('attendance_day_corrections').length, 0)
    assert.equal(db.rows('attendance_day_reviews').length, 0)
    const excuse = await saveReview(secondAdmin(), { employee_id: EMP, attendance_date: '2026-10-05', event_key: 'late_arrival', excused: true, excuse_reason: 'Reported by phone' }, MID)
    assert.equal(excuse.status, 201)
    assert.equal(db.rows('attendance_day_corrections').length, 0)
  })
})
