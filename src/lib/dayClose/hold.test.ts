// The attendance hold (owner, 2026-11-18), over MemorySupabase: the nightly check, the hold clearing itself,
// the punch messages, the owner's lift, and the pure rules.

import { beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { MemorySupabase } from '../attendance/testing/memorySupabase'
import type { Caller } from '@/lib/security/attendancePayrollApiAuth'
import { isOpenOn, liftHold, myHold, nextWorkingDay, onPunches, refreshHolds, writeHolds, MESSAGES } from './hold'

const OWNER = 'aaaaaaaa-0000-0000-0000-00000000000a'
const DHRUV = 'eeeeeeee-0000-0000-0000-00000000000e'   // came in, left a task open
const RAKESH = 'ffffffff-0000-0000-0000-00000000000f'  // came in, nothing open
const JASVI = 'cccccccc-0000-0000-0000-00000000000c'   // never punched
const WED = '2026-11-18'
const THU = '2026-11-19'
const ist = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`)

let db: MemorySupabase
const svc = () => db as unknown as Caller['svc']
const caller = (id: string, role: string): Caller =>
  ({ svc: svc(), id, role, team: null, isAdmin: role === 'admin' })
const punch = (minop: string, date: string, hhmm: string, seen = `${date}T${hhmm}:30+05:30`) => ({
  minop_user_id: minop, punch_at: ist(date, hhmm).toISOString(), punch_local: `${date} ${hhmm}:00`, first_seen_at: new Date(seen).toISOString(),
})
const notes = (who: string) => db.rows('notifications').filter(n => n.user_id === who).map(n => String(n.title))

beforeEach(() => {
  const user = (id: string, name: string, role: string, minop: string | null) =>
    ({ id, full_name: name, role, is_active: true, is_deleted: false, minop_user_id: minop })
  db = new MemorySupabase({
    users: [user(OWNER, 'Nishant', 'admin', null), user(DHRUV, 'Dhruv', 'member', '17'), user(RAKESH, 'Rakesh', 'member', '18'), user(JASVI, 'Jasvi', 'member', '19')],
    day_close_settings: [{ singleton: true, reviewer_id: OWNER, plan_due_minutes: 630, close_opens_minutes: 1080, team_live: true, live_since: null }],
    day_close_members: [{ employee_id: DHRUV, active: true }, { employee_id: RAKESH, active: true }, { employee_id: JASVI, active: true }],
    tasks: [
      { id: 't1', title: 'Vendor report', status: 'working', due_date: WED, assigned_to: DHRUV, created_by: OWNER },
      { id: 't2', title: 'Old one', status: 'pending', due_date: '2026-11-16', assigned_to: DHRUV, created_by: OWNER },
      { id: 't3', title: 'Done', status: 'completed', due_date: WED, assigned_to: RAKESH, created_by: OWNER },
      { id: 't4', title: 'Jasvi task', status: 'working', due_date: WED, assigned_to: JASVI, created_by: OWNER },
    ],
    minop_punches: [punch('17', WED, '10:02'), punch('17', WED, '18:40'), punch('18', WED, '09:58')],
    payroll_holidays: [], attendance_requests: [], notifications: [], day_close_holds: [],
  })
})

describe('the rules', () => {
  test('open = due on or before the day and not handed in or cancelled', () => {
    assert.equal(isOpenOn({ status: 'working', due_date: WED }, WED), true)
    assert.equal(isOpenOn({ status: 'working', due_date: THU }, WED), false, 'moved to a later date')
    for (const status of ['completed', 'cancelled', 'pending_approval']) assert.equal(isOpenOn({ status, due_date: WED }, WED), false)
  })
  test('the next working day skips Sundays and holidays', () => {
    assert.equal(nextWorkingDay(WED, new Set()), THU)
    assert.equal(nextWorkingDay('2026-11-21', new Set()), '2026-11-23', 'Saturday -> Monday')
    assert.equal(nextWorkingDay(WED, new Set([THU])), '2026-11-20')
  })
})

describe('the nightly check', () => {
  test('came in and left work open: tomorrow on hold, told once; nothing open or no punch: no hold', async () => {
    const r = await writeHolds(svc(), WED)
    assert.deepEqual(r, { date: WED, judged: 2, written: 1 })
    const holds = db.rows('day_close_holds')
    assert.equal(holds.length, 1)
    assert.equal(holds[0].employee_id, DHRUV)
    assert.equal(holds[0].held_date, THU)
    assert.equal(holds[0].open_tasks, 2, 'today\'s task and the overdue one')
    assert.deepEqual(notes(DHRUV), [MESSAGES.held(2, THU).title])
    assert.deepEqual(notes(JASVI), [], 'no punch is never a hold')
    assert.equal((await writeHolds(svc(), WED)).written, 0, 'a second run writes nothing new')
    assert.equal(notes(DHRUV).length, 1)
  })
  test('nothing while the team switch is off, on a Sunday, or for approved full-day leave', async () => {
    db.rows('day_close_settings')[0].team_live = false
    assert.equal((await writeHolds(svc(), WED)).written, 0)
    db.rows('day_close_settings')[0].team_live = true
    assert.equal((await writeHolds(svc(), '2026-11-22')).written, 0)
    db.tables.attendance_requests = [{ employee_id: DHRUV, status: 'approved', request_type: 'full_day_leave', start_date: WED, end_date: WED }]
    assert.equal((await writeHolds(svc(), WED)).written, 0)
  })
})

describe('clearing', () => {
  test('finishing or moving the work clears the hold by itself, and today is counted', async () => {
    await writeHolds(svc(), WED)
    const morning = ist(THU, '10:05')
    assert.ok(await myHold(svc(), DHRUV, morning), 'still on hold')
    db.rows('tasks').find(t => t.id === 't1')!.status = 'completed'
    db.rows('tasks').find(t => t.id === 't2')!.due_date = '2026-11-21'
    assert.deepEqual(await refreshHolds(svc(), DHRUV, morning), [])
    assert.ok(db.rows('day_close_holds')[0].cleared_at)
    assert.equal(db.rows('day_close_holds')[0].cleared_by, undefined)
    assert.ok(notes(DHRUV).includes(MESSAGES.cleared().title))
    assert.equal(await myHold(svc(), DHRUV, morning), null)
  })
  test('the owner lifts a hold with a reason; staff cannot', async () => {
    await writeHolds(svc(), WED)
    const id = String(db.rows('day_close_holds')[0].id)
    const at = ist(THU, '11:00')
    assert.equal((await liftHold(caller(RAKESH, 'member'), id, { reason: 'please' }, at)).status, 403)
    assert.equal((await liftHold(caller(OWNER, 'admin'), id, { reason: 'x' }, at)).status, 400)
    assert.equal((await liftHold(caller(OWNER, 'admin'), id, { reason: 'Hospital visit' }, at)).status, 200)
    assert.equal(db.rows('day_close_holds')[0].cleared_by, OWNER)
    assert.equal((await liftHold(caller(OWNER, 'admin'), id, { reason: 'Hospital visit' }, at)).status, 409)
  })
  test('no holds table yet (the migration not applied): no hold, no error', async () => {
    delete db.tables.day_close_holds
    db.failOn.set('day_close_holds:select', 'relation "day_close_holds" does not exist')
    assert.equal(await myHold(svc(), DHRUV, ist(THU, '10:00')), null)
  })
})

describe('at a punch', () => {
  test('the punch-in on a held day: "not counted", once', async () => {
    await writeHolds(svc(), WED)
    const seen = ist(THU, '10:04').toISOString()
    db.tables.minop_punches.push({ ...punch('17', THU, '10:04'), first_seen_at: seen })
    assert.equal(await onPunches(svc(), seen, ist(THU, '10:04')), 1)
    assert.ok(notes(DHRUV).includes(MESSAGES.punch(ist(THU, '10:04').toISOString()).title))
    assert.ok(db.rows('day_close_holds')[0].punch_notice_at)
    assert.equal(await onPunches(svc(), seen, ist(THU, '10:05')), 0, 'told once')
  })
  test('the punch-out with work open: "you left with work open", once a day; nothing open: nothing', async () => {
    const seen = ist(WED, '18:40').toISOString()
    db.tables.minop_punches = [{ ...punch('17', WED, '18:40'), first_seen_at: seen }, { ...punch('18', WED, '18:41'), first_seen_at: seen }]
    assert.equal(await onPunches(svc(), seen, ist(WED, '18:41')), 1)
    assert.deepEqual(notes(DHRUV), [MESSAGES.left(2).title])
    assert.deepEqual(notes(RAKESH), [])
    assert.equal(await onPunches(svc(), seen, ist(WED, '18:45')), 0)
  })
  test('nothing at all while the team switch is off', async () => {
    db.rows('day_close_settings')[0].team_live = false
    const seen = ist(WED, '18:40').toISOString()
    db.tables.minop_punches = [{ ...punch('17', WED, '18:40'), first_seen_at: seen }]
    assert.equal(await onPunches(svc(), seen, ist(WED, '18:41')), 0)
  })
})
