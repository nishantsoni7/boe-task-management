/**
 * When the attendance machine counts as stopped, and who is told. A false alarm
 * sends the owner to check a machine that is fine, and a missed one loses a day
 * before anybody notices: punches stopped for 12 days in October.
 *
 * Run:
 *   npm run test:file -- src/lib/minop/machineHealth.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemorySupabase } from '../attendance/testing/memorySupabase'
import {
  MACHINE_STOPPED_NOTIFICATION_TYPE,
  formatPunchMoment,
  isFullDayHoliday,
  judgeMachineHealth,
  machineStoppedMessage,
  punchLagLabel,
  readLatestPunch,
  readMachineHealth,
  sendMachineStoppedAlert,
  type LatestPunch,
} from './machineHealth'

/** A moment on the IST clock. */
const ist = (date: string, clock: string) => new Date(`${date}T${clock}:00+05:30`)
const punchAt = (date: string, clock: string) => ist(date, clock).toISOString()
const reached = (date: string, clock: string): LatestPunch => ({
  punchAt: punchAt(date, clock), reachedAt: punchAt(date, clock),
})

// 3 Nov 2026 is a Tuesday, 8 Nov a Sunday.
const TUESDAY = '2026-11-03'
const MONDAY = '2026-11-02'
const SUNDAY = '2026-11-08'

const stateAt = (now: Date, lastPunch: LatestPunch | null, isHoliday = false) =>
  judgeMachineHealth({ now, lastPunch, isHoliday }).state

test('a punch that reached BOE today means the machine is sending', () => {
  assert.equal(stateAt(ist(TUESDAY, '09:40'), reached(TUESDAY, '09:38')), 'sending')
  assert.equal(stateAt(ist(TUESDAY, '19:00'), reached(TUESDAY, '09:38')), 'sending')
})

test('a late punch from yesterday arriving today still proves it is connected', () => {
  const late = { punchAt: punchAt(MONDAY, '18:50'), reachedAt: punchAt(TUESDAY, '10:05') }
  assert.equal(stateAt(ist(TUESDAY, '11:30'), late), 'sending')
})

test('the machine has stopped from 11:00 on a working day, not a minute before', () => {
  const yesterday = reached(MONDAY, '18:52')
  assert.equal(stateAt(ist(TUESDAY, '10:59'), yesterday), 'waiting')
  assert.equal(stateAt(ist(TUESDAY, '11:00'), yesterday), 'stopped')
  assert.equal(stateAt(ist(TUESDAY, '23:59'), yesterday), 'stopped')
})

test('a machine nothing has ever arrived from has stopped too', () => {
  assert.equal(stateAt(ist(TUESDAY, '11:00'), null), 'stopped')
})

test('Sundays and holidays are days off, so nothing is expected', () => {
  assert.equal(stateAt(ist(SUNDAY, '15:00'), reached(MONDAY, '18:52')), 'day_off')
  assert.equal(stateAt(ist(TUESDAY, '15:00'), reached(MONDAY, '18:52'), true), 'day_off')
})

test('somebody working on a day off still shows the machine is sending', () => {
  assert.equal(stateAt(ist(SUNDAY, '15:00'), reached(SUNDAY, '14:58')), 'sending')
})

test('no alarm before the machine is the attendance source', () => {
  // Saturday 31 October: staff are still on the old machine.
  assert.equal(stateAt(ist('2026-10-31', '15:00'), reached('2026-10-30', '15:31')), 'waiting')
})

test('the IST date decides, so 00:30 IST is already the new day', () => {
  const health = judgeMachineHealth({ now: ist(TUESDAY, '00:30'), lastPunch: reached(MONDAY, '23:50'), isHoliday: false })
  assert.equal(health.today, TUESDAY)
  assert.equal(health.state, 'waiting')
})

test('only a full-day holiday is a day off', () => {
  assert.equal(isFullDayHoliday({ holiday_type: 'full_day' }), true)
  assert.equal(isFullDayHoliday({ holiday_type: null }), true)
  assert.equal(isFullDayHoliday({ holiday_type: 'half_day' }), false)
})

test('a punch reads by its clock today and by its date on any other day', () => {
  assert.match(formatPunchMoment(punchAt(TUESDAY, '10:42'), TUESDAY), /^10:42 am$/i)
  assert.match(formatPunchMoment(punchAt(MONDAY, '18:52'), TUESDAY), /^Mon 2 Nov, 06:52 pm$/i)
})

test('the delay reads in plain words at every size', () => {
  const lag = (minutes: number) => punchLagLabel({
    punchAt: '2026-11-03T05:00:00.000Z',
    reachedAt: new Date(Date.parse('2026-11-03T05:00:00.000Z') + minutes * 60_000).toISOString(),
  })
  assert.equal(lag(0), 'within a minute')
  assert.equal(lag(1), '1 minute later')
  assert.equal(lag(2), '2 minutes later')
  assert.equal(lag(60), '1 hour later')
  assert.equal(lag(142), '2 hours later')
  assert.equal(lag(3102), '2 days later')
})

test('Minop\'s sample message proves nothing about the machine', async () => {
  const db = new MemorySupabase({
    minop_punches: [
      { id: '1', punch_at: '2018-05-11T04:00:00.000Z', first_seen_at: punchAt(TUESDAY, '11:30') },
      { id: '2', punch_at: punchAt(MONDAY, '18:52'), first_seen_at: punchAt(MONDAY, '18:54') },
    ],
  })
  const latest = await readLatestPunch(db as never)
  assert.equal(latest?.reachedAt, punchAt(MONDAY, '18:54'))
})

test('the newest arrival is the one read, whatever time it was punched', async () => {
  const db = new MemorySupabase({
    minop_punches: [
      { id: '1', punch_at: punchAt(MONDAY, '18:52'), first_seen_at: punchAt(MONDAY, '18:54') },
      { id: '2', punch_at: punchAt(MONDAY, '10:00'), first_seen_at: punchAt(TUESDAY, '09:00') },
    ],
  })
  assert.equal((await readLatestPunch(db as never))?.punchAt, punchAt(MONDAY, '10:00'))
})

test('a half-day holiday still expects punches', async () => {
  const lastPunch = { id: '1', punch_at: punchAt(MONDAY, '18:52'), first_seen_at: punchAt(MONDAY, '18:54') }
  const halfDay = new MemorySupabase({
    minop_punches: [lastPunch],
    payroll_holidays: [{ holiday_date: TUESDAY, holiday_type: 'half_day' }],
  })
  assert.equal((await readMachineHealth(halfDay as never, ist(TUESDAY, '11:00'))).state, 'stopped')

  const fullDay = new MemorySupabase({
    minop_punches: [lastPunch],
    payroll_holidays: [{ holiday_date: TUESDAY, holiday_type: 'full_day' }],
  })
  assert.equal((await readMachineHealth(fullDay as never, ist(TUESDAY, '11:00'))).state, 'day_off')
})

test('the message says when the last punch was and what to check', () => {
  const health = judgeMachineHealth({ now: ist(TUESDAY, '11:05'), lastPunch: reached(MONDAY, '18:52'), isHoliday: false })
  const { title, body } = machineStoppedMessage(health)
  assert.equal(title, 'Machine has stopped sending')
  assert.match(body, /^No punch has reached BOE today\. Last one Mon 2 Nov, 06:52 pm\./i)
  assert.match(body, /power and Wi-Fi/)
  assert.match(body, /Minop subscription/)
})

const alertDb = (notifications: Record<string, unknown>[] = []) => new MemorySupabase({
  users: [
    { id: 'owner', role: 'admin', is_active: true },
    { id: 'gone', role: 'admin', is_active: false },
    { id: 'staff', role: 'employee', is_active: true },
  ],
  notifications,
})
const stopped = judgeMachineHealth({ now: ist(TUESDAY, '11:05'), lastPunch: reached(MONDAY, '18:52'), isHoliday: false })
const sent = (db: MemorySupabase) => db.rows('notifications').filter(n => n.type === MACHINE_STOPPED_NOTIFICATION_TYPE)

test('only active admins are told', async () => {
  const db = alertDb()
  assert.equal(await sendMachineStoppedAlert(db as never, stopped), 1)
  assert.deepEqual(sent(db).map(n => n.user_id), ['owner'])
})

test('a second run the same day tells nobody again', async () => {
  const db = alertDb()
  await sendMachineStoppedAlert(db as never, stopped)
  // The real table stamps created_at; this stand-in does not.
  for (const row of sent(db)) row.created_at = punchAt(TUESDAY, '11:05')
  assert.equal(await sendMachineStoppedAlert(db as never, stopped), 0)
  assert.equal(sent(db).length, 1)
})

test('still stopped the next day is a new alert', async () => {
  const db = alertDb([{
    id: 'n1', user_id: 'owner', type: MACHINE_STOPPED_NOTIFICATION_TYPE, created_at: punchAt(MONDAY, '11:05'),
  }])
  assert.equal(await sendMachineStoppedAlert(db as never, stopped), 1)
})

test('a machine that is fine tells nobody', async () => {
  const db = alertDb()
  for (const state of ['sending', 'waiting', 'day_off'] as const) {
    assert.equal(await sendMachineStoppedAlert(db as never, { ...stopped, state }), 0, state)
  }
  assert.equal(sent(db).length, 0)
})
