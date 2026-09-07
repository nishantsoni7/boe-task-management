import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeMinopPunch, type ExistingAttendancePunches } from './attendanceMerge'

const empty: ExistingAttendancePunches = { check_in_at: null, check_out_at: null }

test('a CheckIn on an empty day becomes the arrival', () => {
  const result = mergeMinopPunch(empty, { type: 'CheckIn', timeUtc: '2026-01-08T09:40:00Z' })
  assert.deepEqual(result, { check_in_at: '2026-01-08T09:40:00Z', check_out_at: null, changed: true })
})

test('a CheckOut on an empty day becomes the departure (check-out-only day)', () => {
  const result = mergeMinopPunch(empty, { type: 'CheckOut', timeUtc: '2026-01-08T18:10:00Z' })
  assert.deepEqual(result, { check_in_at: null, check_out_at: '2026-01-08T18:10:00Z', changed: true })
})

test('CheckIn then CheckOut completes the day', () => {
  const afterIn = mergeMinopPunch(empty, { type: 'CheckIn', timeUtc: '2026-01-08T09:40:00Z' })
  const afterOut = mergeMinopPunch(afterIn, { type: 'CheckOut', timeUtc: '2026-01-08T18:10:00Z' })
  assert.deepEqual(afterOut, {
    check_in_at: '2026-01-08T09:40:00Z',
    check_out_at: '2026-01-08T18:10:00Z',
    changed: true,
  })
})

test('out-of-order arrival: CheckOut before CheckIn is still recorded correctly', () => {
  const afterOut = mergeMinopPunch(empty, { type: 'CheckOut', timeUtc: '2026-01-08T18:10:00Z' })
  const afterIn = mergeMinopPunch(afterOut, { type: 'CheckIn', timeUtc: '2026-01-08T09:40:00Z' })
  assert.deepEqual(afterIn, {
    check_in_at: '2026-01-08T09:40:00Z',
    check_out_at: '2026-01-08T18:10:00Z',
    changed: true,
  })
})

test('a retried CheckIn at the exact same time changes nothing', () => {
  const afterIn = mergeMinopPunch(empty, { type: 'CheckIn', timeUtc: '2026-01-08T09:40:00Z' })
  const retried = mergeMinopPunch(afterIn, { type: 'CheckIn', timeUtc: '2026-01-08T09:40:00Z' })
  assert.deepEqual(retried, { check_in_at: '2026-01-08T09:40:00Z', check_out_at: null, changed: false })
})

test('a retried CheckOut at the exact same time changes nothing', () => {
  const afterOut = mergeMinopPunch(empty, { type: 'CheckOut', timeUtc: '2026-01-08T18:10:00Z' })
  const retried = mergeMinopPunch(afterOut, { type: 'CheckOut', timeUtc: '2026-01-08T18:10:00Z' })
  assert.deepEqual(retried, { check_in_at: null, check_out_at: '2026-01-08T18:10:00Z', changed: false })
})

test('a second, LATER CheckIn does not overwrite the first arrival', () => {
  const afterFirst = mergeMinopPunch(empty, { type: 'CheckIn', timeUtc: '2026-01-08T09:40:00Z' })
  const afterSecond = mergeMinopPunch(afterFirst, { type: 'CheckIn', timeUtc: '2026-01-08T13:00:00Z' })
  assert.deepEqual(afterSecond, { check_in_at: '2026-01-08T09:40:00Z', check_out_at: null, changed: false })
})

test('a second, EARLIER CheckIn replaces a later one already recorded', () => {
  // Realistic only for an out-of-order/backfilled delivery, but the rule is
  // symmetric: the earliest CheckIn wins whichever order the events arrive in.
  const afterFirst = mergeMinopPunch(empty, { type: 'CheckIn', timeUtc: '2026-01-08T13:00:00Z' })
  const afterEarlier = mergeMinopPunch(afterFirst, { type: 'CheckIn', timeUtc: '2026-01-08T09:40:00Z' })
  assert.deepEqual(afterEarlier, { check_in_at: '2026-01-08T09:40:00Z', check_out_at: null, changed: true })
})

test('a second, LATER CheckOut replaces the one already recorded', () => {
  const afterFirst = mergeMinopPunch(empty, { type: 'CheckOut', timeUtc: '2026-01-08T17:00:00Z' })
  const afterLater = mergeMinopPunch(afterFirst, { type: 'CheckOut', timeUtc: '2026-01-08T18:10:00Z' })
  assert.deepEqual(afterLater, { check_in_at: null, check_out_at: '2026-01-08T18:10:00Z', changed: true })
})

test('a second, EARLIER CheckOut does not overwrite the later departure', () => {
  const afterFirst = mergeMinopPunch(empty, { type: 'CheckOut', timeUtc: '2026-01-08T18:10:00Z' })
  const afterEarlier = mergeMinopPunch(afterFirst, { type: 'CheckOut', timeUtc: '2026-01-08T17:00:00Z' })
  assert.deepEqual(afterEarlier, { check_in_at: null, check_out_at: '2026-01-08T18:10:00Z', changed: false })
})

test('multiple CheckIns across the day: only the earliest survives', () => {
  let day = empty
  for (const t of ['2026-01-08T10:15:00Z', '2026-01-08T09:40:00Z', '2026-01-08T11:00:00Z']) {
    day = mergeMinopPunch(day, { type: 'CheckIn', timeUtc: t })
  }
  assert.equal(day.check_in_at, '2026-01-08T09:40:00Z')
})

test('multiple CheckOuts across the day: only the latest survives', () => {
  let day = empty
  for (const t of ['2026-01-08T17:00:00Z', '2026-01-08T18:10:00Z', '2026-01-08T16:30:00Z']) {
    day = mergeMinopPunch(day, { type: 'CheckOut', timeUtc: t })
  }
  assert.equal(day.check_out_at, '2026-01-08T18:10:00Z')
})
