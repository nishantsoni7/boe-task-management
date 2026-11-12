// Day Close × attendance requests (owner, 2026-11-12): leave asked for while work is pending is still sent,
// is marked, and only the Day Close reviewer may approve it. The real handlers run over the in-memory
// database (../attendance/testing/memorySupabase.ts); nothing reaches the linked project.

import { beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { MemorySupabase } from '../attendance/testing/memorySupabase'
import { decideRequest, listRequests, submitRequest } from '../attendance/requestHandlers'
import type { Caller } from '@/lib/security/attendancePayrollApiAuth'
import { evaluateDay } from './server'

const OWNER = 'aaaaaaaa-0000-0000-0000-00000000000a'   // the reviewer
const ADMIN_B = 'bbbbbbbb-0000-0000-0000-00000000000b'
const DHRUV = 'eeeeeeee-0000-0000-0000-00000000000e'   // switched on, with an overdue task
const RAKESH = 'ffffffff-0000-0000-0000-00000000000f'  // switched on, nothing pending
const OTHER = 'cccccccc-0000-0000-0000-00000000000c'   // not switched on, with an overdue task
const NOW = '2026-11-13T05:00:00Z'                     // Friday 13 Nov, 10:30 IST

let db: MemorySupabase
const caller = (id: string, role: string): Caller =>
  ({ svc: db as unknown as Caller['svc'], id, role, team: null, isAdmin: role === 'admin' })

beforeEach(() => {
  const user = (id: string, name: string, role: string) => ({
    id, full_name: name, role, is_active: true, is_deleted: false, employee_code: name.slice(0, 3).toUpperCase(),
    minop_user_id: null,
  })
  db = new MemorySupabase({
    users: [user(OWNER, 'Nishant', 'admin'), user(ADMIN_B, 'Second Admin', 'admin'), user(DHRUV, 'Dhruv', 'member'),
      user(RAKESH, 'Rakesh', 'member'), user(OTHER, 'Other', 'member')],
    day_close_settings: [{ singleton: true, reviewer_id: OWNER, plan_due_minutes: 630, close_opens_minutes: 1080 }],
    day_close_members: [{ employee_id: DHRUV, active: true }, { employee_id: RAKESH, active: true }],
    tasks: [
      { id: 't1', title: 'Vendor report', status: 'working', due_date: '2026-11-11', assigned_to: DHRUV, created_by: OWNER },
      { id: 't2', title: 'Done already', status: 'completed', due_date: '2026-11-10', assigned_to: RAKESH, created_by: OWNER },
      { id: 't3', title: 'Old', status: 'pending', due_date: '2026-11-10', assigned_to: OTHER, created_by: OWNER },
    ],
  })
})

const leave = (who: string) =>
  submitRequest(caller(who, 'member'), { request_type: 'full_day_leave', start_date: '2026-11-16', reason_code: 'personal' }, NOW)

describe('leave while work is pending', () => {
  test('is still sent, with the reason, and marked', async () => {
    const r = await leave(DHRUV)
    assert.equal(r.status, 201)
    assert.equal(r.body.work_pending, '1 overdue task')
    const id = (r.body.request as { id: string }).id
    assert.equal(db.rows('day_close_leave_locks').length, 1)
    const queue = await listRequests(caller(ADMIN_B, 'admin'), 'queue', 'pending')
    assert.deepEqual(queue.body.work_pending, { [id]: '1 overdue task' })
  })

  test('another admin cannot approve it, and is told who can', async () => {
    const id = ((await leave(DHRUV)).body.request as { id: string }).id
    const r = await decideRequest(caller(ADMIN_B, 'admin'), id, { status: 'approved' }, NOW)
    assert.equal(r.status, 409)
    assert.match(String(r.body.error), /Work is pending \(1 overdue task\)\. Only Nishant can approve this leave\./)
    assert.equal(db.rows('attendance_requests')[0].status, 'pending')
  })

  test('another admin may still reject it', async () => {
    const id = ((await leave(DHRUV)).body.request as { id: string }).id
    assert.equal((await decideRequest(caller(ADMIN_B, 'admin'), id, { status: 'rejected', note: 'Finish the vendor report first' }, NOW)).status, 200)
  })

  test('the reviewer approves it, and the lock is released', async () => {
    const id = ((await leave(DHRUV)).body.request as { id: string }).id
    assert.equal((await decideRequest(caller(OWNER, 'admin'), id, { status: 'approved' }, NOW)).status, 200)
    assert.equal(db.rows('day_close_leave_locks')[0].released_by, OWNER)
    const queue = await listRequests(caller(ADMIN_B, 'admin'), 'queue', 'all')
    assert.deepEqual(queue.body.work_pending, {})
  })

  test('nothing pending, or not switched on, or not leave: no lock', async () => {
    assert.equal((await leave(RAKESH)).body.work_pending, undefined)
    assert.equal((await leave(OTHER)).body.work_pending, undefined)
    const late = await submitRequest(caller(DHRUV, 'member'), { request_type: 'late_arrival', start_date: '2026-11-16', reason_code: 'personal' }, NOW)
    assert.equal(late.status, 201)
    assert.equal(late.body.work_pending, undefined)
    assert.equal(db.rows('day_close_leave_locks').length, 0)
  })

  test('a day not closed in the last week counts as pending work', async () => {
    db.rows('tasks').length = 0
    db.tables.day_strikes = [{ employee_id: DHRUV, work_date: '2026-11-12', kind: 'day_not_closed', status: 'open' }]
    assert.equal((await leave(DHRUV)).body.work_pending, '1 day not closed')
  })

  test('a waived strike does not', async () => {
    db.rows('tasks').length = 0
    db.tables.day_strikes = [{ employee_id: DHRUV, work_date: '2026-11-12', kind: 'day_not_closed', status: 'waived' }]
    assert.equal((await leave(DHRUV)).body.work_pending, undefined)
  })
})

describe('the nightly check', () => {
  test('writes no strike for somebody with no machine ID (no punch is never a strike)', async () => {
    const r = await evaluateDay(db as unknown as Caller['svc'], '2026-11-13')
    assert.deepEqual(r, { date: '2026-11-13', judged: 0, written: 0 })
  })

  test('does nothing on a Sunday', async () => {
    assert.deepEqual(await evaluateDay(db as unknown as Caller['svc'], '2026-11-15'), { date: '2026-11-15', judged: 0, written: 0 })
  })

  test('came in, never filed, never closed: two strikes, written once', async () => {
    db.rows('users').find(u => u.id === DHRUV)!.minop_user_id = '17'
    db.tables.minop_punches = [
      { minop_user_id: '17', punch_at: '2026-11-13T04:32:00.000Z', punch_local: '2026-11-13 10:02:00', first_seen_at: '2026-11-13T04:32:30.000Z' },
      { minop_user_id: '17', punch_at: '2026-11-13T13:05:00.000Z', punch_local: '2026-11-13 18:35:00', first_seen_at: '2026-11-13T13:05:30.000Z' },
    ]
    const first = await evaluateDay(db as unknown as Caller['svc'], '2026-11-13')
    assert.equal(first.written, 2)
    assert.deepEqual(db.rows('day_strikes').map(s => s.kind).sort(), ['day_not_closed', 'no_plan'])
    await evaluateDay(db as unknown as Caller['svc'], '2026-11-13')
    assert.equal(db.rows('day_strikes').length, 2, 'a second run writes nothing new')
  })
})
