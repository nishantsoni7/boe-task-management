// The Attendance request workflow around the form: a double tap or a retry never
// saves twice, legitimate same-day requests are all accepted, admins are
// notified once with a link to the request, the employee hears the decision,
// approval touches neither punches nor payroll, and an employee only ever sees
// their own requests.
//
// Handlers run for real against the in-memory database (./testing/memorySupabase).
// Nothing here reaches the linked Supabase project.

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MemorySupabase } from './testing/memorySupabase'
import { submitRequest, cancelRequest, decideRequest, listRequests, requestHistory } from './requestHandlers'
import { loadMonthRequests } from './requestsServer'
import { submissionTiming, RETRY_WINDOW_MS } from './requests'
import type { Caller } from '@/lib/security/attendancePayrollApiAuth'
import { istToday, istAddDays } from '@/lib/istDate'
import { getNotificationMeta } from '@/lib/notificationMeta'
import type { Notification } from '@/lib/types'

const NISHANT = 'aaaaaaaa-0000-0000-0000-00000000000a'
const SECOND  = 'bbbbbbbb-0000-0000-0000-00000000000b'
const EMP     = 'eeeeeeee-0000-0000-0000-00000000000e'
const OTHER   = 'ffffffff-0000-0000-0000-00000000000f'

let db: MemorySupabase
const caller = (id: string, role: string): Caller =>
  ({ svc: db as unknown as Caller['svc'], id, role, team: null, isAdmin: role === 'admin' })
const asEmployee = () => caller(EMP, 'member')
const asColleague = () => caller(OTHER, 'member')
const asNishant = () => caller(NISHANT, 'admin')

const NOW = new Date().toISOString()
const TODAY = istToday(new Date(NOW))
const TOMORROW = istAddDays(TODAY, 1)

const body = (over: Record<string, unknown> = {}) => ({
  request_type: 'late_arrival', start_date: TOMORROW, expected_arrival_time: '10:45',
  reason_code: 'personal', reason_note: null, ...over,
})

function seed() {
  const user = (id: string, name: string, role: string) => ({
    id, full_name: name, role, is_active: true, is_deleted: false, employee_code: name.slice(0, 3).toUpperCase(),
  })
  db = new MemorySupabase({
    users: [user(NISHANT, 'Nishant', 'admin'), user(SECOND, 'Second Admin', 'admin'), user(EMP, 'Asha', 'member'), user(OTHER, 'Bala', 'member')],
    payroll_settings: [], attendance_requests: [], attendance_request_events: [], notifications: [],
    attendance_records: [{ id: 'r1', user_id: EMP, attendance_date: TOMORROW, check_in_at: null, check_out_at: null, status: 'absent' }],
    attendance_day_corrections: [], payroll_results: [], payroll_periods: [],
  })
}

const live = (who = EMP) => db.rows('attendance_requests').filter(r => r.employee_id === who)
const notificationsOf = (type: string) => db.rows('notifications').filter(n => n.type === type)

beforeEach(seed)

describe('duplicate submissions', () => {
  test('a double tap saves ONE request and notifies the admins ONCE', async () => {
    const a = await submitRequest(asEmployee(), body(), NOW)
    const b = await submitRequest(asEmployee(), body(), NOW)
    assert.equal(a.status, 201)
    assert.equal(b.status, 200, 'the repeat is answered, not refused')
    assert.equal(b.body.duplicate, true)
    assert.equal((b.body.request as { id: string }).id, (a.body.request as { id: string }).id)
    assert.equal(live().length, 1)
    // Two active admins, each told once; nobody twice.
    const told = notificationsOf('attendance_request_submitted')
    assert.equal(told.length, 2)
    assert.deepEqual(told.map(n => n.user_id).sort(), [NISHANT, SECOND].sort())
    assert.ok(told.every(n => n.entity_id === (a.body.request as { id: string }).id))
  })

  test('a retry after a lost response (same content, a minute later) is the same request', async () => {
    const a = await submitRequest(asEmployee(), body({ reason_note: '  Doctor  ', reason_code: 'medical' }), NOW)
    const later = new Date(Date.parse(NOW) + 60_000).toISOString()
    const b = await submitRequest(asEmployee(), body({ reason_note: 'Doctor', reason_code: 'medical' }), later)
    assert.equal(b.status, 200)
    assert.equal(live().length, 1)
    assert.equal((b.body.request as { id: string }).id, (a.body.request as { id: string }).id)
  })

  test('the same content long afterwards is refused as a conflict, not saved twice', async () => {
    await submitRequest(asEmployee(), body(), NOW)
    const later = new Date(Date.parse(NOW) + RETRY_WINDOW_MS + 60_000).toISOString()
    const again = await submitRequest(asEmployee(), body(), later)
    assert.equal(again.status, 409)
    assert.equal(live().length, 1)
  })

  test('a different request on the same date is NOT a duplicate', async () => {
    const first = await submitRequest(asEmployee(), body(), NOW)
    const changed = await submitRequest(asEmployee(), body({ expected_arrival_time: '11:15' }), NOW)
    assert.equal(first.status, 201)
    assert.equal(changed.status, 409, 'a second late arrival that day is a conflict (edit it instead)')
    assert.equal(live().length, 1)
  })

  test('two racing identical submissions: the database refuses the second and the winner is returned', async () => {
    let armed = true
    const realFrom = db.from.bind(db)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(db as any).from = (table: string) => {
      const q = realFrom(table)
      if (table === 'attendance_requests' && armed) {
        q.insert = ((rows: Record<string, unknown>) => {
          armed = false
          // The other tab's insert lands first, so this one hits the unique index.
          return { select: () => ({ single: async () => {
            await realFrom('attendance_requests').insert({ ...rows, id: 'winner-id' })
            return { data: null, error: { message: 'duplicate key value violates unique constraint "attendance_requests_live_single_day"', code: '23505' } }
          } }) }
        }) as never
      }
      return q
    }
    const res = await submitRequest(asEmployee(), body(), NOW)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.duplicate, true)
    assert.equal((res.body.request as { id: string }).id, 'winner-id')
    assert.equal(notificationsOf('attendance_request_submitted').length, 0, 'the loser sends nothing')
  })
})

describe('legitimate requests on one date are all accepted', () => {
  test('late arrival + early departure + a time out on the same day', async () => {
    const results = [
      await submitRequest(asEmployee(), body(), NOW),
      await submitRequest(asEmployee(), body({ request_type: 'early_departure', expected_arrival_time: null, departure_time: '17:00' }), NOW),
      await submitRequest(asEmployee(), body({
        request_type: 'time_out', expected_arrival_time: null, departure_time: '13:00', return_time: '14:00', work_kind: 'personal',
      }), NOW),
      // A second, non-overlapping time out the same day.
      await submitRequest(asEmployee(), body({
        request_type: 'time_out', expected_arrival_time: null, departure_time: '15:00', return_time: '15:30', work_kind: 'company',
      }), NOW),
    ]
    assert.deepEqual(results.map(r => r.status), [201, 201, 201, 201], JSON.stringify(results.map(r => r.body)))
    assert.equal(live().length, 4)
  })

  test('an overlapping time out, and leave over an existing request, are still refused', async () => {
    await submitRequest(asEmployee(), body({
      request_type: 'time_out', expected_arrival_time: null, departure_time: '13:00', return_time: '14:00', work_kind: 'personal',
    }), NOW)
    const overlap = await submitRequest(asEmployee(), body({
      request_type: 'time_out', expected_arrival_time: null, departure_time: '13:30', return_time: '14:30', work_kind: 'personal',
    }), NOW)
    assert.equal(overlap.status, 409)
    const leave = await submitRequest(asEmployee(), body({ request_type: 'full_day_leave', expected_arrival_time: null }), NOW)
    assert.equal(leave.status, 409)
  })

  test('invalid times are refused by the server whatever the form sent', async () => {
    const backwards = await submitRequest(asEmployee(), body({
      request_type: 'time_out', expected_arrival_time: null, departure_time: '15:00', return_time: '14:00', work_kind: 'personal',
    }), NOW)
    assert.equal(backwards.status, 400)
    const noReason = await submitRequest(asEmployee(), body({ reason_code: '' }), NOW)
    assert.equal(noReason.status, 400)
    const otherNoNote = await submitRequest(asEmployee(), body({ reason_code: 'other' }), NOW)
    assert.equal(otherNoNote.status, 400)
    assert.equal(live().length, 0)
  })
})

describe('notification → decision → employee', () => {
  test('the admin notification links to the request; the decision notifies the employee with a link', async () => {
    const sent = await submitRequest(asEmployee(), body(), NOW)
    const id = (sent.body.request as { id: string }).id

    const adminNote = notificationsOf('attendance_request_submitted').find(n => n.user_id === NISHANT)!
    assert.ok(adminNote, 'Nishant is notified through the ordinary admin recipients — no hard-coded identity')
    assert.match(String(adminNote.title), /Asha submitted a late arrival request/)
    const adminMeta = getNotificationMeta(adminNote as unknown as Notification)
    assert.equal(adminMeta.href, `/attendance/requests?request=${id}`)

    const decided = await decideRequest(asNishant(), id, { status: 'approved', note: '' }, NOW)
    assert.equal(decided.status, 200, JSON.stringify(decided.body))
    const empNote = notificationsOf('attendance_request_decided').find(n => n.user_id === EMP)!
    assert.match(String(empNote.title), /was approved/)
    assert.equal(getNotificationMeta(empNote as unknown as Notification).href, `/my-attendance?request=${id}#my-requests`)
    assert.equal(notificationsOf('attendance_request_decided').length, 1)
  })

  test('a rejection needs a short reason, is recorded with actor and time, and the employee is told', async () => {
    const id = ((await submitRequest(asEmployee(), body(), NOW)).body.request as { id: string }).id
    const noReason = await decideRequest(asNishant(), id, { status: 'rejected', note: '' }, NOW)
    assert.equal(noReason.status, 400)
    const rejected = await decideRequest(asNishant(), id, { status: 'rejected', note: 'Client visit that day' }, NOW)
    assert.equal(rejected.status, 200)
    const row = live()[0]
    assert.equal(row.status, 'rejected')
    assert.equal(row.decided_by, NISHANT)
    assert.ok(row.decided_at)
    assert.equal(row.decision_note, 'Client visit that day')
    assert.match(String(notificationsOf('attendance_request_decided')[0].body), /Client visit that day/)
  })

  test('an employee cannot decide; the requesting admin cannot decide their own', async () => {
    const id = ((await submitRequest(asEmployee(), body(), NOW)).body.request as { id: string }).id
    assert.equal((await decideRequest(asEmployee(), id, { status: 'approved' }, NOW)).status, 403)
    const own = ((await submitRequest(asNishant(), body({ start_date: istAddDays(TODAY, 2) }), NOW)).body.request as { id: string }).id
    assert.equal((await decideRequest(asNishant(), own, { status: 'approved' }, NOW)).status, 403)
    assert.equal((await decideRequest(caller(SECOND, 'admin'), own, { status: 'approved' }, NOW)).status, 200)
  })
})

describe('approval is permission on record, nothing more', () => {
  test('approving writes no punch, correction or payroll row and leaves the day absent', async () => {
    const id = ((await submitRequest(asEmployee(), body(), NOW)).body.request as { id: string }).id
    const before = JSON.stringify([db.rows('attendance_records'), db.rows('attendance_day_corrections'), db.rows('payroll_results'), db.rows('payroll_periods')])
    await decideRequest(asNishant(), id, { status: 'approved' }, NOW)
    const after = JSON.stringify([db.rows('attendance_records'), db.rows('attendance_day_corrections'), db.rows('payroll_results'), db.rows('payroll_periods')])
    assert.equal(after, before)
    assert.equal(db.rows('attendance_records')[0].status, 'absent')
  })

  test('a locked payroll month is untouched by an approval', async () => {
    db.tables.payroll_periods.push({ id: 'p', payroll_month: 10, payroll_year: 2026, status: 'locked' })
    const id = ((await submitRequest(asEmployee(), body(), NOW)).body.request as { id: string }).id
    const before = JSON.stringify(db.rows('payroll_periods'))
    const res = await decideRequest(asNishant(), id, { status: 'approved' }, NOW)
    assert.equal(res.status, 200)
    assert.equal(JSON.stringify(db.rows('payroll_periods')), before)
  })
})

describe('withdrawing', () => {
  test('a pending request can be withdrawn; the row and its audit stay', async () => {
    const id = ((await submitRequest(asEmployee(), body(), NOW)).body.request as { id: string }).id
    const res = await cancelRequest(asEmployee(), id, { reason: 'Plans changed' }, NOW)
    assert.equal(res.status, 200)
    const row = live()[0]
    assert.equal(row.status, 'cancelled')
    assert.equal(row.cancel_reason, 'Plans changed')
    assert.equal(live().length, 1, 'nothing is deleted')
  })

  test('an approved request can be withdrawn only before its shift starts, and is never deleted', async () => {
    const id = ((await submitRequest(asEmployee(), body(), NOW)).body.request as { id: string }).id
    await decideRequest(asNishant(), id, { status: 'approved' }, NOW)
    assert.equal((await cancelRequest(asEmployee(), id, {}, NOW)).status, 200)
    assert.equal(live()[0].status, 'cancelled')
    // A different approved request whose shift has begun cannot be withdrawn.
    const id2 = ((await submitRequest(asEmployee(), body({ start_date: istAddDays(TODAY, 3) }), NOW)).body.request as { id: string }).id
    await decideRequest(asNishant(), id2, { status: 'approved' }, NOW)
    const afterShift = new Date(Date.parse(String(live().find(r => r.id === id2)!.shift_start_at)) + 3_600_000).toISOString()
    assert.equal((await cancelRequest(asEmployee(), id2, {}, afterShift)).status, 409)
  })
})

describe('an employee sees only their own requests', () => {
  test('list, history and withdrawal are pinned to the caller; the month read is per employee', async () => {
    const mine = ((await submitRequest(asEmployee(), body(), NOW)).body.request as { id: string }).id
    await submitRequest(asColleague(), body({ expected_arrival_time: '11:00' }), NOW)

    const list = await listRequests(asColleague(), null, null)
    assert.deepEqual((list.body.requests as { employee_id: string }[]).map(r => r.employee_id), [OTHER])
    assert.equal((await requestHistory(asColleague(), mine)).status, 404)
    assert.equal((await cancelRequest(asColleague(), mine, {}, NOW)).status, 404)
    assert.equal((await listRequests(asColleague(), 'queue', null)).status, 403)

    const month = await loadMonthRequests(db as never, EMP, TODAY.slice(0, 8) + '01', istAddDays(TODAY, 40))
    assert.equal(month.error, null)
    assert.deepEqual(month.requests.map(r => r.employee_id), [EMP])
  })
})

describe('the month read behind the attendance views', () => {
  test('returns approved and pending requests with their decision even when NO attendance exists for the month', async () => {
    db.tables.attendance_records = []                       // the import has not arrived
    const a = ((await submitRequest(asEmployee(), body(), NOW)).body.request as { id: string }).id
    await submitRequest(asEmployee(), body({ request_type: 'full_day_leave', expected_arrival_time: null, start_date: istAddDays(TODAY, 5), end_date: istAddDays(TODAY, 6) }), NOW)
    await decideRequest(asNishant(), a, { status: 'approved', note: 'OK' }, NOW)

    const { requests, error } = await loadMonthRequests(db as never, EMP, TODAY.slice(0, 8) + '01', istAddDays(TODAY, 40))
    assert.equal(error, null)
    assert.equal(requests.length, 2)
    const approved = requests.find(r => r.id === a)!
    assert.equal(approved.status, 'approved')
    assert.equal(approved.decided_by, NISHANT)
    assert.equal(approved.decision_note, 'OK')
    assert.ok(requests.some(r => r.status === 'pending'))
  })

  test('the employee-monthly-detail route returns them in BOTH the not-imported and the imported answers', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/app/api/attendance/employee-monthly-detail/route.ts', 'utf8')
    assert.match(src, /loadMonthRequests\(svc, employeeId, from, to\)/, 'read for the token-authorised employee')
    assert.equal((src.match(/\.\.\.requestsPart/g) ?? []).length, 2, 'spread into the not-imported and the imported responses')
    assert.ok(src.indexOf('loadMonthRequests') < src.indexOf('if (!monthImported)'), 'read before the not-imported early return')
  })
})

describe('after-the-event submissions are identified', () => {
  const at = (submitted: string, start: string, informed: boolean) =>
    submissionTiming({ submitted_at: submitted, start_date: start, informed_before_shift: informed })
  test('before shift / after shift start / after the date (IST)', () => {
    assert.equal(at('2026-10-05T03:00:00Z', '2026-10-05', true), 'before_shift')
    assert.equal(at('2026-10-05T06:00:00Z', '2026-10-05', false), 'after_shift')
    assert.equal(at('2026-10-06T04:00:00Z', '2026-10-05', false), 'after_date')
  })
  test('the IST date decides, not the UTC date', () => {
    // 19:00 UTC on the 5th is 00:30 IST on the 6th.
    assert.equal(at('2026-10-05T19:00:00Z', '2026-10-05', false), 'after_date')
    assert.equal(at('2026-10-05T18:00:00Z', '2026-10-05', false), 'after_shift')
  })
  test('a retrospective request is still accepted within the existing window, and notified as after the event', async () => {
    const yesterday = istAddDays(TODAY, -1)
    const res = await submitRequest(asEmployee(), body({ start_date: yesterday }), NOW)
    assert.equal(res.status, 201)
    assert.match(String(notificationsOf('attendance_request_submitted')[0].body), /after the date/i)
  })
})
