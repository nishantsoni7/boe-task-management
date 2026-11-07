/**
 * The punch-in strip: what a person is told about their own punch today, and,
 * above all, when it must say nothing. A red "No punch-in recorded" shown to
 * someone who did punch, or whose machine had stopped, would teach everybody to
 * ignore it, so every silent case is spelled out. readPunchStrip is then run on
 * MemorySupabase with the real reads.
 *
 * Run:
 *   npm run test:file -- src/lib/minop/punchStrip.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemorySupabase } from '../attendance/testing/memorySupabase'
import { DEFAULT_PAYROLL_SETTINGS } from '../payroll/settings'
import {
  judgePunchStrip,
  readPunchStrip,
  PUNCH_STRIP_SHOW_MINUTES,
  type PunchStripInput,
  type PunchStripPerson,
  type PunchStripPunch,
} from './punchStrip'

const TUESDAY = '2026-11-03'
const SUNDAY = '2026-11-08'

const ist = (date: string, clock: string) => new Date(`${date}T${clock}:00+05:30`)

const linked: PunchStripPerson = {
  minop_user_id: '4',
  is_active: true,
  is_deleted: false,
  joining_date: null,
  exit_date: null,
}

/** A punch at `clock`, received `lagSeconds` later. */
const punch = (date: string, clock: string, lagSeconds = 120): PunchStripPunch => ({
  punch_local: `${date} ${clock}:00`,
  punch_at: ist(date, clock).toISOString(),
  first_seen_at: new Date(ist(date, clock).getTime() + lagSeconds * 1000).toISOString(),
})

const judge = (over: Partial<PunchStripInput> & { at: string; date?: string }) => {
  const { at, date = TUESDAY, ...rest } = over
  return judgePunchStrip({
    now: ist(date, at),
    person: linked,
    punches: [],
    holiday: false,
    approved: false,
    machineStopped: false,
    settings: DEFAULT_PAYROLL_SETTINGS,
    ...rest,
  })
}

// ── Punched in ───────────────────────────────────────────────────────────────

test('on time: green, says when the note goes away, counts the time left', () => {
  const strip = judge({ at: '10:10', punches: [punch(TUESDAY, '10:04')] })
  assert.equal(strip.tone, 'on_time')
  assert.equal(strip.title, 'You punched in at 10:04 am')
  // Counted from when BOE received it (10:06), not from the punch.
  assert.equal(strip.detail, 'On time. This note goes away at 10:36 am.')
  assert.equal(strip.showForMs, 26 * 60_000)
  assert.equal(strip.today, TUESDAY)
})

test('late: amber, how late, counted from the start of the day', () => {
  const strip = judge({ at: '10:30', punches: [punch(TUESDAY, '10:27')] })
  assert.equal(strip.tone, 'late')
  assert.equal(strip.title, 'You punched in at 10:27 am')
  assert.equal(strip.detail, 'Late by 27 minutes, counted from 10:00 am. This note goes away at 10:59 am.')
})

test('the grace period ends at 10:15: on time at 10:15, 16 minutes late at 10:16', () => {
  assert.equal(judge({ at: '10:20', punches: [punch(TUESDAY, '10:15')] }).tone, 'on_time')
  const late = judge({ at: '10:20', punches: [punch(TUESDAY, '10:16')] })
  assert.equal(late.tone, 'late')
  assert.match(late.detail, /^Late by 16 minutes,/)
})

test('one minute late is "1 minute", not "1 minutes"', () => {
  const strip = judge({
    at: '10:10',
    punches: [punch(TUESDAY, '10:01')],
    settings: { ...DEFAULT_PAYROLL_SETTINGS, grace_end_minutes: 600 },
  })
  assert.match(strip.detail, /^Late by 1 minute, /)
})

test('shows for exactly 30 minutes: there at 29:59, gone at 30:00', () => {
  assert.equal(PUNCH_STRIP_SHOW_MINUTES, 30)
  const punches = [punch(TUESDAY, '10:04', 60)] // received 10:05
  const inside = judge({ at: '10:34', punches })
  assert.equal(inside.tone, 'on_time')
  assert.equal(inside.showForMs, 60_000)
  assert.equal(judge({ at: '10:35', punches }).tone, null)
  assert.equal(judge({ at: '10:36', punches }).tone, null)
})

test('a punch that reached BOE late still shows for 30 minutes from when it arrived', () => {
  // Punched at 09:55, the machine delivered it at 12:00.
  const strip = judge({ at: '12:10', punches: [punch(TUESDAY, '09:55', 125 * 60)] })
  assert.equal(strip.tone, 'on_time')
  assert.equal(strip.detail, 'On time. This note goes away at 12:30 pm.')
})

test('two taps a minute apart are one arrival, at the first', () => {
  const strip = judge({ at: '10:10', punches: [punch(TUESDAY, '10:02'), punch(TUESDAY, '10:03')] })
  assert.equal(strip.title, 'You punched in at 10:02 am')
})

test('a Sunday punch is never "late"', () => {
  const strip = judge({ at: '11:05', date: SUNDAY, punches: [punch(SUNDAY, '11:00')] })
  assert.equal(strip.tone, 'on_time')
})

test('a holiday punch is never "late"', () => {
  assert.equal(judge({ at: '11:05', holiday: true, punches: [punch(TUESDAY, '11:00')] }).tone, 'on_time')
})

test('a lone punch after 14:00 is a departure: no arrival to show, and not "no punch" either', () => {
  assert.equal(judge({ at: '15:05', punches: [punch(TUESDAY, '15:00')] }).tone, null)
})

// ── Not punched in ───────────────────────────────────────────────────────────

test('no punch from 10:15: red, stays until hidden, no countdown', () => {
  const strip = judge({ at: '10:15' })
  assert.equal(strip.tone, 'missing')
  assert.equal(strip.title, 'No punch-in recorded for you today')
  assert.equal(strip.detail, 'Office opened at 10:00 am. Punch on the machine; it shows here within a few minutes.')
  assert.equal(strip.showForMs, null)
  assert.equal(judge({ at: '23:30' }).tone, 'missing')
})

test('nothing before the grace period ends: a person who has just tapped is not told off', () => {
  assert.equal(judge({ at: '09:00' }).tone, null)
  assert.equal(judge({ at: '10:14' }).tone, null)
})

test('red turns into green the moment the punch arrives', () => {
  assert.equal(judge({ at: '10:40' }).tone, 'missing')
  assert.equal(judge({ at: '10:40', punches: [punch(TUESDAY, '10:38')] }).tone, 'late')
})

// ── Silent, because "no punch" cannot be said honestly ───────────────────────

test('silent when there is nobody to say it to', () => {
  const at = '12:00'
  assert.equal(judge({ at, person: { ...linked, minop_user_id: null } }).tone, null, 'no Machine ID')
  assert.equal(judge({ at, person: { ...linked, is_active: false } }).tone, null, 'inactive')
  assert.equal(judge({ at, person: { ...linked, is_deleted: true } }).tone, null, 'deleted')
  assert.equal(judge({ at, person: { ...linked, joining_date: '2026-11-04' } }).tone, null, 'not yet joined')
  assert.equal(judge({ at, person: { ...linked, joining_date: TUESDAY } }).tone, 'missing', 'joined today')
  assert.equal(judge({ at, person: { ...linked, exit_date: TUESDAY } }).tone, null, 'left today')
  assert.equal(judge({ at, person: { ...linked, exit_date: '2026-11-04' } }).tone, 'missing', 'leaves tomorrow')
})

test('silent on a Sunday, a holiday, and with an approved request', () => {
  assert.equal(judge({ at: '12:00', date: SUNDAY }).tone, null)
  assert.equal(judge({ at: '12:00', holiday: true }).tone, null)
  assert.equal(judge({ at: '12:00', approved: true }).tone, null)
})

test('silent when the machine has stopped sending: its fault, not theirs', () => {
  assert.equal(judge({ at: '12:00', machineStopped: true }).tone, null)
})

test('silent before the machine is the source of attendance (1 Nov 2026)', () => {
  assert.equal(judge({ at: '12:00', date: '2026-10-30' }).tone, null)
})

test('the date answered is the IST date, even in the small hours', () => {
  // 00:30 IST on Wednesday is still Tuesday in UTC.
  assert.equal(judge({ at: '00:30', date: '2026-11-04' }).today, '2026-11-04')
})

// ── readPunchStrip on the in-memory database ─────────────────────────────────

const seeded = (rows: Record<string, Record<string, unknown>[]> = {}) => new MemorySupabase({
  users: [
    { id: 'a', minop_user_id: '4', is_active: true, is_deleted: false, joining_date: null, exit_date: null },
    { id: 'b', minop_user_id: '5', is_active: true, is_deleted: false, joining_date: null, exit_date: null },
    { id: 'c', minop_user_id: null, is_active: true, is_deleted: false, joining_date: null, exit_date: null },
  ],
  minop_punches: [
    { id: 1, minop_user_id: '4', ...punch(TUESDAY, '10:04') },
    { id: 2, minop_user_id: '5', ...punch(TUESDAY, '10:20') },
  ],
  payroll_holidays: [],
  attendance_requests: [],
  ...rows,
})

test('each person is told about their OWN punch only', async () => {
  const db = seeded()
  const a = await readPunchStrip(db as never, 'a', ist(TUESDAY, '10:30'))
  const b = await readPunchStrip(db as never, 'b', ist(TUESDAY, '10:30'))
  assert.equal(a.title, 'You punched in at 10:04 am')
  assert.equal(b.title, 'You punched in at 10:20 am')
  assert.equal(b.tone, 'late')
})

test('somebody else punching never covers for a person who has not', async () => {
  // Only b's punch exists today; a has none, and the machine is plainly sending.
  const db = seeded({ minop_punches: [{ id: 2, minop_user_id: '5', ...punch(TUESDAY, '10:01') }] })
  const a = await readPunchStrip(db as never, 'a', ist(TUESDAY, '11:30'))
  assert.equal(a.tone, 'missing')
})

test('nobody has punched today and it is past 11:00: the machine has stopped, so silence', async () => {
  const db = seeded({ minop_punches: [] })
  assert.equal((await readPunchStrip(db as never, 'a', ist(TUESDAY, '11:30'))).tone, null)
})

test('a person with no Machine ID, an unknown id, and a read that fails', async () => {
  const db = seeded()
  assert.equal((await readPunchStrip(db as never, 'c', ist(TUESDAY, '12:00'))).tone, null)
  assert.equal((await readPunchStrip(db as never, 'nobody', ist(TUESDAY, '12:00'))).tone, null)

  const broken = seeded()
  broken.failOn.set('minop_punches:select', 'boom')
  await assert.rejects(readPunchStrip(broken as never, 'a', ist(TUESDAY, '12:00')), /boom/)
})

test('an approved request or a holiday on the day keeps the red strip away', async () => {
  const none = { minop_punches: [{ id: 2, minop_user_id: '5', ...punch(TUESDAY, '10:01') }] }
  const leave = seeded({ ...none, attendance_requests: [{ id: 'r1', employee_id: 'a', status: 'approved', start_date: TUESDAY, end_date: TUESDAY }] })
  assert.equal((await readPunchStrip(leave as never, 'a', ist(TUESDAY, '11:30'))).tone, null)

  const rejected = seeded({ ...none, attendance_requests: [{ id: 'r1', employee_id: 'a', status: 'rejected', start_date: TUESDAY, end_date: TUESDAY }] })
  assert.equal((await readPunchStrip(rejected as never, 'a', ist(TUESDAY, '11:30'))).tone, 'missing')

  const someoneElse = seeded({ ...none, attendance_requests: [{ id: 'r1', employee_id: 'b', status: 'approved', start_date: TUESDAY, end_date: TUESDAY }] })
  assert.equal((await readPunchStrip(someoneElse as never, 'a', ist(TUESDAY, '11:30'))).tone, 'missing')

  const holiday = seeded({ ...none, payroll_holidays: [{ holiday_date: TUESDAY, holiday_type: 'full_day' }] })
  assert.equal((await readPunchStrip(holiday as never, 'a', ist(TUESDAY, '11:30'))).tone, null)
})

test('a punch time that cannot be real (received 40 days after it was stamped) is not a punch', async () => {
  const stamped = ist(TUESDAY, '09:30')
  const db = seeded({
    minop_punches: [
      {
        id: 9, minop_user_id: '4', punch_local: `${TUESDAY} 09:30:00`, punch_at: stamped.toISOString(),
        first_seen_at: new Date(stamped.getTime() + 40 * 24 * 3_600_000).toISOString(),
      },
      { id: 2, minop_user_id: '5', ...punch(TUESDAY, '10:01') },
    ],
  })
  assert.equal((await readPunchStrip(db as never, 'a', ist(TUESDAY, '11:30'))).tone, 'missing')
})
