/**
 * What the machine is allowed to write into attendance_records, and what it must
 * leave alone. planMachineDays is the whole decision with no database, so the
 * rules are exercised directly. The source pins at the end hold the boundary.
 *
 * Run:
 *   npm run test:file -- src/lib/minop/machineAttendance.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { machineRangeOf, machineSyncFrom, planMachineDays, rebuildMachineDays, syncMachineAttendance } from './machineAttendance'
import { deviceTimeToUtcIso, mergePunchRows } from './punches'
import { MemorySupabase } from '../attendance/testing/memorySupabase'

const SEEN = '2026-11-02T13:30:00.000Z'
const punch = (minop_user_id: string, punch_local: string, first_seen_at = SEEN) => ({
  minop_user_id, punch_local, punch_at: deviceTimeToUtcIso(punch_local)!, first_seen_at,
})
const person = (id: string, minop_user_id: string, over: Partial<{ is_active: boolean; is_deleted: boolean }> = {}) => ({
  id, minop_user_id, is_active: true, is_deleted: false, ...over,
})
const plan = (input: Partial<Parameters<typeof planMachineDays>[0]>) =>
  planMachineDays({ punches: [], users: [person('u-4', '4')], lockedMonths: new Set(), existing: [], ...input })

const day = [punch('4', '2026-11-02 10:02:00'), punch('4', '2026-11-02 18:40:00')]

test('a linked person\'s day becomes one row, marked as coming from the machine', () => {
  const { writes, result } = plan({ punches: day })
  assert.deepEqual(writes, [{
    user_id: 'u-4',
    attendance_date: '2026-11-02',
    check_in_at: '2026-11-02T04:32:00.000Z',
    check_out_at: '2026-11-02T13:10:00.000Z',
    status: 'present',
    punch_direction_source: 'confirmed',
    source: 'minop',
  }])
  assert.equal(result.written, 1)
})

test('nothing before 1 November is ever written', () => {
  const { writes } = plan({ punches: [punch('4', '2026-10-31 18:00:00', '2026-10-31T12:30:00.000Z')] })
  assert.deepEqual(writes, [])
})

test('Minop\'s 2018 sample and a punch with an impossible time are not attendance', () => {
  const { writes } = plan({ punches: [punch('4', '2026-11-02 10:00:00', '2027-06-01T00:00:00.000Z')] })
  assert.deepEqual(writes, [])
})

test('a machine ID linked to nobody writes nothing and is reported', () => {
  const { writes, result } = plan({ punches: [punch('3', '2026-11-02 10:00:00'), ...day] })
  assert.equal(writes.length, 1)
  assert.deepEqual(result.unlinked, ['3'])
})

test('an inactive person\'s ID writes nothing: someone using a leaver\'s finger never makes them present', () => {
  const { writes, result } = plan({
    punches: [punch('2', '2026-11-02 12:59:24')],
    users: [person('u-2', '2', { is_active: false })],
  })
  assert.deepEqual(writes, [])
  assert.equal(result.skippedInactive, 1)
})

test('a deleted person\'s ID writes nothing', () => {
  const { writes } = plan({ punches: day, users: [person('u-4', '4', { is_deleted: true })] })
  assert.deepEqual(writes, [])
})

test('a locked payroll month is never changed; the next month still is', () => {
  const { writes, result } = plan({
    punches: [...day, punch('4', '2026-12-01 10:00:00', '2026-12-01T05:00:00.000Z')],
    lockedMonths: new Set(['2026-11']),
  })
  assert.deepEqual(writes.map(w => w.attendance_date), ['2026-12-01'])
  assert.equal(result.skippedLocked, 1)
})

const stored = {
  user_id: 'u-4',
  attendance_date: '2026-11-02',
  check_in_at: '2026-11-02 04:32:00+00',
  check_out_at: '2026-11-02 13:10:00+00',
  punch_direction_source: 'confirmed',
  source: 'minop',
}

test('a day that would not change is not written, however the database spells the time', () => {
  const { writes, result } = plan({ punches: day, existing: [stored] })
  assert.deepEqual(writes, [])
  assert.equal(result.unchanged, 1)
})

test('a late punch moves the day: the departure arrives after an arrival was written', () => {
  const { writes } = plan({
    punches: [...day, punch('4', '2026-11-02 19:10:00')],
    existing: [stored],
  })
  assert.equal(writes.length, 1)
  assert.equal(writes[0].check_out_at, '2026-11-02T13:40:00.000Z')
})

test('punches arriving out of order give the same day as punches arriving in order', () => {
  const forward = plan({ punches: day }).writes
  const backward = plan({ punches: [...day].reverse() }).writes
  assert.deepEqual(forward, backward)
})

test('a day an upload wrote takes the machine\'s values and is marked as the machine\'s', () => {
  const { writes } = plan({ punches: day, existing: [{ ...stored, source: null }] })
  assert.equal(writes[0].source, 'minop')
})

test('a message becomes a range of its machine dates and people, or nothing', () => {
  assert.deepEqual(machineRangeOf({ trans: [
    { punchId: 4, txnDateTime: '2026-11-03 10:00:00' },
    { punchId: '5', txnDateTime: '2026-11-02 18:00:00' },
    { punchId: 4, txnDateTime: '2026-10-31 18:00:00' },
  ] }), { from: '2026-11-02', to: '2026-11-03', minopUserIds: ['4', '5'] })
  assert.equal(machineRangeOf({ trans: [{ punchId: 4, txnDateTime: '2026-10-31 18:00:00' }] }), null)
  assert.equal(machineRangeOf({ dvcSrNo: 'say hello' }), null)
})

test('the nightly sync reaches back to last month, never before the start date', () => {
  assert.equal(machineSyncFrom('2026-11-02'), '2026-11-01')
  assert.equal(machineSyncFrom('2026-12-15'), '2026-11-01')
  assert.equal(machineSyncFrom('2027-01-15'), '2026-12-01')
  assert.equal(machineSyncFrom('2027-03-01'), '2027-02-01')
})

test('several messages carrying one punch merge to one row with the earliest receipt', () => {
  const row = { dvc_id: '1', minop_user_id: '4', punch_local: '2026-11-02 10:00:00', punch_at: 'x', txn_id: '9', mode: '8' }
  assert.deepEqual(mergePunchRows([
    { ...row, first_seen_at: '2026-11-02T06:00:00.000Z' },
    { ...row, first_seen_at: '2026-11-02T05:00:00.000Z' },
    { ...row, minop_user_id: '5', first_seen_at: '2026-11-02T07:00:00.000Z' },
  ]).map(r => [r.minop_user_id, r.first_seen_at]), [
    ['4', '2026-11-02T05:00:00.000Z'],
    ['5', '2026-11-02T07:00:00.000Z'],
  ])
})

test('a range wholly before the start date reads nothing at all', async () => {
  const svc = { from: () => { throw new Error('must not reach the database') } }
  // @ts-expect-error a fake that proves no call happens
  const result = await rebuildMachineDays(svc, { from: '2026-10-01', to: '2026-10-31' })
  assert.equal(result.written, 0)
})

/** The real reads and writes, on the in-memory database the attendance suites use. */
function database(extra: Record<string, Record<string, unknown>[]> = {}) {
  return new MemorySupabase({
    users: [
      { id: 'u-4', minop_user_id: '4', is_active: true, is_deleted: false },
      { id: 'u-5', minop_user_id: '5', is_active: true, is_deleted: false },
      { id: 'u-2', minop_user_id: '2', is_active: false, is_deleted: false },
    ],
    minop_punches: [],
    minop_webhook_deliveries: [],
    attendance_records: [],
    payroll_periods: [],
    ...extra,
  })
}
const stored_punch = (id: string, minopUserId: string, local: string) => ({ id, ...punch(minopUserId, local) })
const RANGE = { from: '2026-11-02', to: '2026-11-02' }
const asService = (db: MemorySupabase) => db as never
const attendanceWrites = (db: MemorySupabase) => db.log.filter(l => l.table === 'attendance_records' && l.op === 'upsert').length

test('end to end: punches become a row, and running it again writes nothing', async () => {
  const db = database({ minop_punches: [stored_punch('p1', '4', '2026-11-02 10:02:00'), stored_punch('p2', '4', '2026-11-02 18:40:00')] })

  const first = await rebuildMachineDays(asService(db), RANGE)
  assert.equal(first.written, 1)
  assert.equal(db.rows('attendance_records').length, 1)
  assert.equal(db.rows('attendance_records')[0].source, 'minop')

  const second = await rebuildMachineDays(asService(db), RANGE)
  assert.equal(second.written, 0)
  assert.equal(second.unchanged, 1)
  assert.equal(attendanceWrites(db), 1, 'a re-run must not touch updated_at, or a generated payroll month reads as stale')
})

test('end to end: a late punch updates the same row, it never adds a second one', async () => {
  const db = database({ minop_punches: [stored_punch('p1', '4', '2026-11-02 10:02:00')] })
  await rebuildMachineDays(asService(db), RANGE)
  assert.equal(db.rows('attendance_records')[0].check_out_at, null)

  db.rows('minop_punches').push(stored_punch('p2', '4', '2026-11-02 18:40:00'))
  await rebuildMachineDays(asService(db), RANGE)
  assert.equal(db.rows('attendance_records').length, 1)
  assert.equal(db.rows('attendance_records')[0].check_out_at, '2026-11-02T13:10:00.000Z')
  assert.equal(db.rows('attendance_records')[0].status, 'present')
})

test('end to end: limiting to one person leaves everyone else alone', async () => {
  const db = database({ minop_punches: [stored_punch('p1', '4', '2026-11-02 10:02:00'), stored_punch('p2', '5', '2026-11-02 10:03:00')] })
  await rebuildMachineDays(asService(db), { ...RANGE, minopUserIds: ['4'] })
  assert.deepEqual(db.rows('attendance_records').map(r => r.user_id), ['u-4'])
})

test('end to end: a leaver\'s ID and a locked month write nothing', async () => {
  const db = database({
    minop_punches: [stored_punch('p1', '2', '2026-11-02 12:59:24'), stored_punch('p2', '4', '2026-11-02 10:02:00')],
    payroll_periods: [{ id: 'nov', payroll_year: 2026, payroll_month: 11, status: 'locked' }],
  })
  const result = await rebuildMachineDays(asService(db), RANGE)
  assert.equal(db.rows('attendance_records').length, 0)
  assert.equal(result.skippedInactive, 1)
  assert.equal(result.skippedLocked, 1)
})

test('end to end: a failed write is reported, never swallowed here', async () => {
  const db = database({ minop_punches: [stored_punch('p1', '4', '2026-11-02 10:02:00')] })
  db.failOn.set('attendance_records:upsert', 'database down')
  await assert.rejects(rebuildMachineDays(asService(db), RANGE), /Could not write attendance/)
})

test('the nightly sync recovers a punch that only reached the raw messages', async () => {
  const db = database({
    minop_webhook_deliveries: [{
      id: 'd1',
      received_at: '2026-11-02T13:20:00.000Z',
      processing_status: 'received',
      payload: { trans: [
        { txnId: '60', dvcId: '1', punchId: 4, txnDateTime: '2026-11-02 10:02:00', mode: '8' },
        { txnId: '61', dvcId: '1', punchId: 4, txnDateTime: '2026-11-02 18:40:00', mode: '8' },
      ] },
    }],
  })
  const result = await syncMachineAttendance(asService(db), '2026-11-03')
  assert.equal(result.punchesRecorded, 2)
  assert.equal(db.rows('minop_punches').length, 2)
  assert.equal(result.written, 1)
  assert.equal(db.rows('attendance_records')[0].check_in_at, '2026-11-02T04:32:00.000Z')
})

test('the nightly sync before the start date changes nothing', async () => {
  const db = database({
    minop_punches: [stored_punch('p1', '4', '2026-10-30 12:59:24')],
    minop_webhook_deliveries: [{
      id: 'd1',
      received_at: '2026-10-30T07:36:17.000Z',
      processing_status: 'received',
      payload: { trans: [{ txnId: '60', dvcId: '1', punchId: 4, txnDateTime: '2026-10-30 12:59:24', mode: '8' }] },
    }],
  })
  const result = await syncMachineAttendance(asService(db), '2026-10-31')
  assert.equal(result.written, 0)
  assert.equal(db.rows('attendance_records').length, 0)
  assert.equal(db.rows('minop_punches').length, 1)
})

test('source pins: it writes one table, and nothing but a locked-month read touches payroll', () => {
  const source = readFileSync('src/lib/minop/machineAttendance.ts', 'utf8')
  const code = source.replace(/^\s*\/\/.*$/gm, '')
  assert.deepEqual(code.match(/\.upsert\(/g)?.length, 2)
  assert.match(code, /\.from\('attendance_records'\)\.upsert\(writes, \{ onConflict: 'user_id,attendance_date' \}\)/)
  assert.doesNotMatch(code, /\.delete\(|\.rpc\(|\.insert\(/)
  assert.deepEqual([...new Set(code.match(/payroll_[a-z]+/g))].sort(), ['payroll_month', 'payroll_periods', 'payroll_year'])
  assert.doesNotMatch(code, /createClient\(|SUPABASE_SERVICE_ROLE_KEY/)
})
