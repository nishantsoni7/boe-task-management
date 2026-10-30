/**
 * One person's machine punches on one day → that day's attendance row. The
 * day's meaning must match the Excel import, so the engine and every screen
 * treat a machine day exactly as they treat an uploaded one.
 *
 * Run:
 *   npm run test:file -- src/lib/minop/machineDay.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DOUBLE_TAP_MINUTES,
  MACHINE_ATTENDANCE_FROM,
  buildMachineDay,
  isMachineDate,
  machineDateOf,
} from './machineDay'
import { deviceTimeToUtcIso } from './punches'
import { classifyAttendanceDay } from '../attendance/classification'

const punch = (time: string, date = '2026-11-02') => {
  const punch_local = `${date} ${time}`
  return { punch_local, punch_at: deviceTimeToUtcIso(punch_local)! }
}

test('the start date is 1 November 2026, and only dates from it are the machine\'s', () => {
  assert.equal(MACHINE_ATTENDANCE_FROM, '2026-11-01')
  assert.equal(isMachineDate('2026-10-31'), false)
  assert.equal(isMachineDate('2026-11-01'), true)
  assert.equal(isMachineDate('2027-01-01'), true)
})

test('the date comes from the machine\'s own clock, with either separator', () => {
  assert.equal(machineDateOf('2026-11-02 00:10:00'), '2026-11-02')
  assert.equal(machineDateOf('2026-11-02T00:10:00'), '2026-11-02')
})

test('no punches is no row', () => {
  assert.equal(buildMachineDay([]), null)
})

test('two punches are the arrival and the departure, confirmed', () => {
  assert.deepEqual(buildMachineDay([punch('10:02:11'), punch('18:40:05')]), {
    check_in_at: '2026-11-02T04:32:11.000Z',
    check_out_at: '2026-11-02T13:10:05.000Z',
    status: 'present',
    punch_direction_source: 'confirmed',
    source: 'minop',
  })
})

test('with many punches only the first and last count, in any arrival order', () => {
  const row = buildMachineDay([punch('13:05:00'), punch('18:40:05'), punch('10:02:11'), punch('14:01:00')])
  assert.equal(row?.check_in_at, '2026-11-02T04:32:11.000Z')
  assert.equal(row?.check_out_at, '2026-11-02T13:10:05.000Z')
})

test('one morning punch is an arrival, inferred', () => {
  assert.deepEqual(buildMachineDay([punch('10:02:11')]), {
    check_in_at: '2026-11-02T04:32:11.000Z',
    check_out_at: null,
    status: 'checked_in',
    punch_direction_source: 'inferred',
    source: 'minop',
  })
})

test('one afternoon punch is a departure, and 14:00 itself belongs to the afternoon', () => {
  assert.equal(buildMachineDay([punch('13:59:59')])?.check_out_at, null)
  const at14 = buildMachineDay([punch('14:00:00')])
  assert.equal(at14?.check_in_at, null)
  assert.equal(at14?.check_out_at, '2026-11-02T08:30:00.000Z')
  assert.equal(at14?.punch_direction_source, 'inferred')
})

test('two taps a minute apart are one punch, not a one-minute day', () => {
  const row = buildMachineDay([punch('10:02:00'), punch('10:03:00')])
  assert.equal(row?.check_in_at, '2026-11-02T04:32:00.000Z')
  assert.equal(row?.check_out_at, null)
  assert.equal(row?.punch_direction_source, 'inferred')
})

test('double taps at the end of the day keep the later tap as the departure', () => {
  const row = buildMachineDay([punch('18:40:00'), punch('18:41:00')])
  assert.equal(row?.check_in_at, null)
  assert.equal(row?.check_out_at, '2026-11-02T13:11:00.000Z')
})

test('the double-tap limit: just under is one punch, exactly on it is a pair', () => {
  assert.equal(DOUBLE_TAP_MINUTES, 5)
  assert.equal(buildMachineDay([punch('10:00:00'), punch('10:04:59')])?.status, 'checked_in')
  assert.equal(buildMachineDay([punch('10:00:00'), punch('10:05:00')])?.status, 'present')
})

test('the same punches classify the same way a day from the Excel import does', () => {
  const read = (row: NonNullable<ReturnType<typeof buildMachineDay>>) => classifyAttendanceDay({
    check_in_at: row.check_in_at, check_out_at: row.check_out_at, direction_source: row.punch_direction_source,
  })

  assert.equal(read(buildMachineDay([punch('10:05:00'), punch('18:35:00')])!).classification, 'full_present')

  const arrival = read(buildMachineDay([punch('10:05:00')])!)
  assert.equal(arrival.classification, 'missing_punch')
  assert.equal(arrival.missing_punch_type, 'missing_punch_out')
  assert.equal(arrival.direction_source, 'inferred')

  const departure = read(buildMachineDay([punch('18:35:00')])!)
  assert.equal(departure.missing_punch_type, 'missing_punch_in')

  // A double tap reads as a forgotten punch-out, never as a day under two hours.
  const doubleTap = read(buildMachineDay([punch('10:02:00'), punch('10:03:00')])!)
  assert.equal(doubleTap.classification, 'missing_punch')
})
