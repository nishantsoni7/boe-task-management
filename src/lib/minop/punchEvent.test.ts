import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseMinopPunchEvent, SUPPORTED_PUNCH_TYPES } from './punchEvent'

const publishedPayload = {
  RealTime: {
    AuthToken: 'boe-minop-secret',
    OperationID: 42,
    PunchLog: {
      FaceMask: false,
      InputType: 'Face',
      LogTime: '2026-01-08T11:09:09Z',
      Temperature: 36.5,
      Type: 'CheckIn',
      UserId: 'EMP_001',
    },
    Time: '2026-01-08T11:09:10Z',
  },
}

test('the published callback shape parses into a punch event', () => {
  const result = parseMinopPunchEvent(publishedPayload)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.event.minopUserId, 'EMP_001')
  assert.equal(result.event.type, 'CheckIn')
  assert.equal(result.event.supportedType, 'CheckIn')
  assert.equal(result.event.logTimeUtc, '2026-01-08T11:09:09.000Z')
  assert.equal(result.event.operationId, '42')
})

test('CheckOut is supported too', () => {
  const result = parseMinopPunchEvent({
    RealTime: { PunchLog: { UserId: 'E1', Type: 'CheckOut', LogTime: '2026-01-08T12:00:00Z' } },
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.event.supportedType, 'CheckOut')
})

test('every documented supported type round-trips', () => {
  assert.deepEqual(SUPPORTED_PUNCH_TYPES, ['CheckIn', 'CheckOut'])
})

test('BreakIn parses but is not a supported type', () => {
  const result = parseMinopPunchEvent({
    RealTime: { PunchLog: { UserId: 'E1', Type: 'BreakIn', LogTime: '2026-01-08T12:00:00Z' } },
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.event.type, 'BreakIn')
    assert.equal(result.event.supportedType, null)
  }
})

test('an unknown future type also parses, unsupported', () => {
  const result = parseMinopPunchEvent({
    RealTime: { PunchLog: { UserId: 'E1', Type: 'SomethingNew', LogTime: '2026-01-08T12:00:00Z' } },
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.event.supportedType, null)
})

test('missing RealTime is refused', () => {
  assert.deepEqual(parseMinopPunchEvent({}), { ok: false, reason: 'missing_realtime' })
  assert.deepEqual(parseMinopPunchEvent(null), { ok: false, reason: 'missing_realtime' })
  assert.deepEqual(parseMinopPunchEvent('not an object'), { ok: false, reason: 'missing_realtime' })
})

test('missing PunchLog is refused', () => {
  assert.deepEqual(parseMinopPunchEvent({ RealTime: {} }), { ok: false, reason: 'missing_punchlog' })
})

test('missing or blank UserId is refused', () => {
  assert.deepEqual(
    parseMinopPunchEvent({ RealTime: { PunchLog: { Type: 'CheckIn', LogTime: '2026-01-08T12:00:00Z' } } }),
    { ok: false, reason: 'missing_user_id' },
  )
  assert.deepEqual(
    parseMinopPunchEvent({ RealTime: { PunchLog: { UserId: '   ', Type: 'CheckIn', LogTime: '2026-01-08T12:00:00Z' } } }),
    { ok: false, reason: 'missing_user_id' },
  )
})

test('missing Type is refused', () => {
  assert.deepEqual(
    parseMinopPunchEvent({ RealTime: { PunchLog: { UserId: 'E1', LogTime: '2026-01-08T12:00:00Z' } } }),
    { ok: false, reason: 'missing_type' },
  )
})

test('an invalid LogTime is refused', () => {
  assert.deepEqual(
    parseMinopPunchEvent({ RealTime: { PunchLog: { UserId: 'E1', Type: 'CheckIn', LogTime: 'not a date' } } }),
    { ok: false, reason: 'invalid_log_time' },
  )
  assert.deepEqual(
    parseMinopPunchEvent({ RealTime: { PunchLog: { UserId: 'E1', Type: 'CheckIn' } } }),
    { ok: false, reason: 'invalid_log_time' },
  )
})

test('a LogTime with no explicit zone is refused rather than guessed', () => {
  // The public docs say UTC, but a bare "2026-01-08T11:09:09" carries no
  // timezone of its own — accepting it would mean guessing the device's
  // clock, which Stage 2 must not do without real device evidence.
  const result = parseMinopPunchEvent({
    RealTime: { PunchLog: { UserId: 'E1', Type: 'CheckIn', LogTime: '2026-01-08T11:09:09' } },
  })
  assert.deepEqual(result, { ok: false, reason: 'invalid_log_time' })
})

test('an explicit non-UTC offset is still accepted and converted to UTC', () => {
  const result = parseMinopPunchEvent({
    RealTime: { PunchLog: { UserId: 'E1', Type: 'CheckIn', LogTime: '2026-01-08T16:39:09+05:30' } },
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.event.logTimeUtc, '2026-01-08T11:09:09.000Z')
})

test('OperationID is optional and carried as a string when present', () => {
  const withId = parseMinopPunchEvent({
    RealTime: { OperationID: 7, PunchLog: { UserId: 'E1', Type: 'CheckIn', LogTime: '2026-01-08T12:00:00Z' } },
  })
  assert.equal(withId.ok, true)
  if (withId.ok) assert.equal(withId.event.operationId, '7')

  const without = parseMinopPunchEvent({
    RealTime: { PunchLog: { UserId: 'E1', Type: 'CheckIn', LogTime: '2026-01-08T12:00:00Z' } },
  })
  assert.equal(without.ok, true)
  if (without.ok) assert.equal(without.event.operationId, null)
})
