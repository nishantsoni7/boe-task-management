/**
 * The admin's Today tab: what each person's row says, and what it must never say.
 * The worst outcome is calling somebody absent because the machine went quiet, so
 * those cases are spelled out. readMachineDay is then run on MemorySupabase with
 * the real reads.
 *
 * Run:
 *   npm run test:file -- src/lib/minop/machineDayView.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemorySupabase } from '../attendance/testing/memorySupabase'
import { DEFAULT_PAYROLL_SETTINGS } from '../payroll/settings'
import {
  buildMachineDayEntries,
  clockLabel,
  countMachineDay,
  earliestMachineDay,
  findStrayPunches,
  isMachineDayParam,
  readMachineDay,
  type MachineDayInput,
  type MachineDayPerson,
  type MachineDayPunch,
  type MachineDayRequest,
} from './machineDayView'

const TUESDAY = '2026-11-03'
const MONDAY = '2026-11-02'
const SUNDAY = '2026-11-08'

const ist = (date: string, clock: string) => new Date(`${date}T${clock}:00+05:30`)

const person = (id: string, minop_user_id: string | null, more: Partial<MachineDayPerson> = {}): MachineDayPerson => ({
  id,
  full_name: id,
  minop_user_id,
  is_active: true,
  is_deleted: false,
  payroll_active: true,
  joining_date: null,
  exit_date: null,
  ...more,
})

const punch = (minopId: string, date: string, clock: string): MachineDayPunch => ({
  minop_user_id: minopId,
  punch_local: `${date} ${clock}:00`,
  punch_at: ist(date, clock).toISOString(),
  first_seen_at: new Date(ist(date, clock).getTime() + 120_000).toISOString(),
})

const request = (employee_id: string, more: Partial<MachineDayRequest>): MachineDayRequest => ({
  employee_id,
  request_type: 'late_arrival',
  expected_arrival_time: null,
  departure_time: null,
  return_time: null,
  half_session: null,
  ...more,
})

const input = (over: Partial<MachineDayInput>): MachineDayInput => ({
  date: TUESDAY,
  today: TUESDAY,
  nowMinutes: 11 * 60 + 20,
  people: [person('a', '1')],
  punches: [],
  requests: [],
  isHoliday: false,
  machineStopped: false,
  settings: DEFAULT_PAYROLL_SETTINGS,
  ...over,
})

const only = (over: Partial<MachineDayInput>) => {
  const entries = buildMachineDayEntries(input(over))
  assert.equal(entries.length, 1)
  return entries[0]
}

test('one morning punch today is in the office', () => {
  const entry = only({ punches: [punch('1', TUESDAY, '09:52')] })
  assert.equal(entry.status, 'in_office')
  assert.equal(entry.group, 'in_office')
  assert.ok(entry.checkInAt)
  assert.equal(entry.checkOutAt, null)
  assert.equal(entry.hoursWorked, null)
})

test('two punches is a person who has left, with the hours after lunch', () => {
  const entry = only({ punches: [punch('1', TUESDAY, '09:52'), punch('1', TUESDAY, '18:41')] })
  assert.equal(entry.status, 'left')
  // 8h 49m on the clock, less the lunch hour.
  assert.equal(Math.round(entry.hoursWorked! * 60), 7 * 60 + 49)
})

test('a double tap is one punch, not a one-minute day', () => {
  const entry = only({ punches: [punch('1', TUESDAY, '10:02'), punch('1', TUESDAY, '10:03')] })
  assert.equal(entry.status, 'in_office')
  assert.equal(entry.hoursWorked, null)
})

test('one afternoon punch is a missing morning punch', () => {
  const entry = only({ punches: [punch('1', TUESDAY, '18:36')] })
  assert.equal(entry.status, 'morning_missing')
  assert.equal(entry.group, 'needs_look')
  assert.equal(entry.checkInAt, null)
  assert.match(entry.note!, /counts as leaving/)
})

test('one morning punch on a finished day is a missing evening punch', () => {
  const entry = only({ date: MONDAY, punches: [punch('1', MONDAY, '10:42')] })
  assert.equal(entry.status, 'evening_missing')
  assert.equal(entry.group, 'needs_look')
  assert.match(entry.note!, /counts as arriving/)
})

test('no punch yet today names when the office opened', () => {
  const entry = only({ punches: [punch('2', TUESDAY, '09:52')] })
  assert.equal(entry.status, 'no_punch_yet')
  assert.equal(entry.group, 'no_punch')
  assert.equal(entry.note, 'Office opened at 10:00 am')
})

test('before the office opens the note says so', () => {
  assert.equal(only({ nowMinutes: 9 * 60 }).note, 'Office opens at 10:00 am')
})

test('no punch on a finished day says what Monthly Review will show', () => {
  const entry = only({ date: MONDAY, punches: [punch('2', MONDAY, '09:52')] })
  assert.equal(entry.status, 'no_punch')
  assert.equal(entry.note, 'Shows absent in Monthly Review')
})

test('nobody is called absent today while the machine has stopped', () => {
  const entry = only({ machineStopped: true })
  assert.equal(entry.status, 'cant_tell')
  assert.equal(entry.group, 'no_punch')
  assert.equal(entry.note, null)
})

test('nobody is called absent on a past day the machine sent nothing for', () => {
  assert.equal(only({ date: MONDAY, punches: [] }).status, 'cant_tell')
})

test('a past day with one punch from anybody reads as no punch for the rest', () => {
  assert.equal(only({ date: MONDAY, punches: [punch('2', MONDAY, '10:00')] }).status, 'no_punch')
})

test('a Sunday is a day off, under no filter', () => {
  const entry = only({ date: SUNDAY, today: SUNDAY })
  assert.equal(entry.status, 'day_off')
  assert.equal(entry.group, null)
})

test('a holiday is a day off', () => {
  assert.equal(only({ isHoliday: true }).status, 'day_off')
})

test('somebody who works a Sunday still shows, and is not late', () => {
  const entry = only({ date: SUNDAY, today: SUNDAY, punches: [punch('1', SUNDAY, '11:30')] })
  assert.equal(entry.status, 'in_office')
  assert.equal(entry.lateMinutes, null)
})

test('approved leave is on leave, even while the machine has stopped', () => {
  const leave = request('a', { request_type: 'full_day_leave' })
  const entry = only({ requests: [leave], machineStopped: true })
  assert.equal(entry.status, 'on_leave')
  assert.equal(entry.note, 'Approved full-day leave')
  assert.equal(entry.approved, true)
})

test('a punch on a leave day shows what happened, with the leave as the note', () => {
  const entry = only({ requests: [request('a', { request_type: 'full_day_leave' })], punches: [punch('1', TUESDAY, '10:00')] })
  assert.equal(entry.status, 'in_office')
  assert.equal(entry.note, 'Approved full-day leave')
})

test('an approved late arrival replaces the office-hours note', () => {
  const entry = only({ requests: [request('a', { expected_arrival_time: '12:00:00' })] })
  assert.equal(entry.status, 'no_punch_yet')
  assert.equal(entry.approved, true)
  assert.equal(entry.note, 'Approved late arrival, until 12:00 pm')
})

test('every kind of approved request has words', () => {
  const noteFor = (r: Partial<MachineDayRequest>) => only({ requests: [request('a', r)] }).note
  assert.equal(noteFor({ request_type: 'early_departure', departure_time: '16:30' }), 'Approved early departure, at 04:30 pm')
  assert.equal(noteFor({ request_type: 'half_day', half_session: 'first_half' }), 'Approved half day, first half')
  assert.equal(noteFor({ request_type: 'half_day', half_session: 'second_half' }), 'Approved half day, second half')
  assert.equal(
    noteFor({ request_type: 'time_out', departure_time: '13:00', return_time: '15:30' }),
    'Approved time out, 01:00 pm to 03:30 pm',
  )
})

test('late is the payroll rule: past 10:15, counted from 10:00', () => {
  const lateAt = (clock: string) => only({ punches: [punch('1', TUESDAY, clock)] }).lateMinutes
  assert.equal(lateAt('10:15'), null)
  assert.equal(lateAt('10:16'), 16)
  assert.equal(lateAt('10:42'), 42)
})

test('a person with no Machine ID is flagged whatever else is true', () => {
  const entry = only({ people: [person('a', null)], requests: [request('a', { request_type: 'full_day_leave' })] })
  assert.equal(entry.status, 'no_machine_id')
  assert.equal(entry.group, 'needs_look')
  assert.match(entry.note!, /shows absent/)
})

test('dates outside someone\'s employment are not theirs', () => {
  assert.equal(buildMachineDayEntries(input({ people: [person('a', '1', { joining_date: '2026-11-04' })] })).length, 0)
  assert.equal(buildMachineDayEntries(input({ people: [person('a', '1', { exit_date: TUESDAY })] })).length, 0)
  assert.equal(buildMachineDayEntries(input({ people: [person('a', '1', { joining_date: TUESDAY })] })).length, 1)
})

test('the list leads with who needs a look, in the mockup\'s order', () => {
  const entries = buildMachineDayEntries(input({
    people: [
      person('no-id', null),
      person('leave', '11'),
      person('early', '1'),
      person('later', '4'),
      person('late', '7'),
      person('excused', '8'),
      person('missing', '9'),
    ],
    punches: [punch('1', TUESDAY, '09:52'), punch('4', TUESDAY, '10:03'), punch('7', TUESDAY, '10:42')],
    requests: [
      request('leave', { request_type: 'full_day_leave' }),
      request('excused', { expected_arrival_time: '12:00' }),
    ],
  }))
  assert.deepEqual(entries.map(e => e.userId), ['missing', 'excused', 'late', 'early', 'later', 'leave', 'no-id'])
})

test('the counts add up to everyone but days off', () => {
  const entries = buildMachineDayEntries(input({
    date: MONDAY,
    people: [person('a', '1'), person('b', '2'), person('c', '3'), person('d', '4'), person('e', null)],
    punches: [punch('1', MONDAY, '09:52'), punch('1', MONDAY, '18:41'), punch('2', MONDAY, '10:42')],
    requests: [request('d', { request_type: 'full_day_leave' })],
  }))
  assert.deepEqual(countMachineDay(entries), { all: 5, in_office: 0, left: 1, no_punch: 1, on_leave: 1, needs_look: 2 })
})

test('a stray names the leaver who owns the ID, or says nobody does', () => {
  const people = [person('Rohan Das', '12', { is_active: false })]
  const strays = findStrayPunches(
    [punch('12', TUESDAY, '09:47'), punch('12', TUESDAY, '15:31'), punch('3', TUESDAY, '10:02'), punch('1', TUESDAY, '09:52')],
    new Set(['1']),
    people,
  )
  assert.deepEqual(strays.map(s => s.machineId), ['3', '12'])
  assert.equal(strays[0].message, 'Machine ID 3 punched at 10:02 am. It is not linked to anyone, so nobody gets attendance from it.')
  assert.equal(
    strays[1].message,
    'Machine ID 12 punched at 09:47 am and 03:31 pm. It belongs to Rohan Das, who is marked inactive, so nobody gets attendance from it.',
  )
})

test('the clock reads the way the module does', () => {
  assert.equal(clockLabel(0), '12:00 am')
  assert.equal(clockLabel(9 * 60 + 5), '09:05 am')
  assert.equal(clockLabel(12 * 60), '12:00 pm')
  assert.equal(clockLabel(18 * 60 + 41), '06:41 pm')
})

test('the first day the arrows reach', () => {
  assert.equal(earliestMachineDay('2026-10-30'), '2026-10-30')
  assert.equal(earliestMachineDay(TUESDAY), '2026-11-01')
})

test('only a real date the machine covers is accepted', () => {
  assert.equal(isMachineDayParam(TUESDAY, TUESDAY), true)
  assert.equal(isMachineDayParam('2026-11-01', TUESDAY), true)
  assert.equal(isMachineDayParam('2026-10-31', TUESDAY), false)
  assert.equal(isMachineDayParam('2026-11-04', TUESDAY), false)
  assert.equal(isMachineDayParam('2026-02-31', '2026-12-01'), false)
  assert.equal(isMachineDayParam('2026-11-3', TUESDAY), false)
  assert.equal(isMachineDayParam("2026-11-03' or 1=1", TUESDAY), false)
})

const seeded = (rows: Record<string, Record<string, unknown>[]> = {}) => new MemorySupabase({
  users: [
    { id: 'a', full_name: 'Aarav', minop_user_id: '1', is_active: true, is_deleted: false, payroll_active: true, joining_date: null, exit_date: null },
    { id: 'b', full_name: 'Neha', minop_user_id: null, is_active: true, is_deleted: false, payroll_active: true, joining_date: null, exit_date: null },
    { id: 'c', full_name: 'Rohan', minop_user_id: '12', is_active: false, is_deleted: false, payroll_active: true, joining_date: null, exit_date: null },
    { id: 'd', full_name: 'Founder', minop_user_id: '2', is_active: true, is_deleted: false, payroll_active: false, joining_date: null, exit_date: null },
    { id: 'e', full_name: 'Test user', minop_user_id: null, is_active: true, is_deleted: false, payroll_active: false, joining_date: null, exit_date: null },
  ],
  minop_punches: [
    { id: 1, ...punch('1', TUESDAY, '09:52') },
    { id: 2, ...punch('12', TUESDAY, '09:47') },
    // Minop's sample message, stored with today's arrival time.
    { id: 3, minop_user_id: '1000', punch_local: '2018-05-11 09:30:00', punch_at: '2018-05-11T04:00:00.000Z', first_seen_at: ist(TUESDAY, '09:00').toISOString() },
    // Yesterday's punch must not appear on today's list.
    { id: 4, ...punch('2', MONDAY, '18:00') },
  ],
  ...rows,
})

test('the day reads the real tables: who is listed, who is not, and the strays', async () => {
  const view = await readMachineDay(seeded() as never, TUESDAY, ist(TUESDAY, '11:20'))
  assert.equal(view.today, TUESDAY)
  assert.equal(view.earliest, '2026-11-01')
  assert.equal(view.health.state, 'sending')

  const byName = Object.fromEntries(view.entries.map(e => [e.name, e.status]))
  assert.deepEqual(byName, { Aarav: 'in_office', Founder: 'no_punch_yet', Neha: 'no_machine_id' })
  assert.deepEqual(view.strays.map(s => s.machineId), ['12'])
  assert.equal(view.strays[0].ownerName, 'Rohan')
  assert.deepEqual(view.counts, { all: 3, in_office: 1, left: 0, no_punch: 1, on_leave: 0, needs_look: 1 })
})

test('only an approved request covering the date counts', async () => {
  const db = seeded({
    attendance_requests: [
      { employee_id: 'd', request_type: 'full_day_leave', status: 'pending', start_date: TUESDAY, end_date: TUESDAY },
      { employee_id: 'a', request_type: 'full_day_leave', status: 'approved', start_date: MONDAY, end_date: MONDAY },
    ],
  })
  const view = await readMachineDay(db as never, TUESDAY, ist(TUESDAY, '11:20'))
  assert.equal(view.entries.find(e => e.name === 'Founder')?.status, 'no_punch_yet')
  assert.equal(view.entries.find(e => e.name === 'Aarav')?.note, null)
})

test('a leave spanning several days covers the day in the middle', async () => {
  const db = seeded({
    attendance_requests: [
      { employee_id: 'd', request_type: 'full_day_leave', status: 'approved', start_date: MONDAY, end_date: '2026-11-04' },
    ],
  })
  const view = await readMachineDay(db as never, TUESDAY, ist(TUESDAY, '11:20'))
  assert.equal(view.entries.find(e => e.name === 'Founder')?.status, 'on_leave')
})

test('a stopped machine reaches every no-punch row', async () => {
  const db = seeded({ minop_punches: [{ id: 4, ...punch('2', MONDAY, '18:00') }] })
  const view = await readMachineDay(db as never, TUESDAY, ist(TUESDAY, '11:20'))
  assert.equal(view.health.state, 'stopped')
  assert.deepEqual(view.entries.filter(e => e.machineId).map(e => e.status), ['cant_tell', 'cant_tell'])
})

test('a past day keeps its own rows while the strip stays live', async () => {
  const view = await readMachineDay(seeded() as never, MONDAY, ist(TUESDAY, '11:20'))
  assert.equal(view.date, MONDAY)
  assert.equal(view.health.state, 'sending')
  assert.equal(view.entries.find(e => e.name === 'Founder')?.status, 'morning_missing')
})
