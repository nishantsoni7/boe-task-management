/**
 * "Clear all" on the Modules launcher's For you panel: hide what is showing for
 * 24 hours; anything still not dealt with comes back, anything new shows at once.
 *
 * Run:
 *   npx tsx --test src/lib/modules/forYouSnooze.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_SNOOZE, SNOOZE_MS, isHidden, isSnoozed, itemKeys, readSnooze, snoozeAll, snoozeStorageKey,
} from './forYouSnooze'

const NOW = Date.UTC(2026, 9, 29, 6, 0, 0)

describe('Clear all hides for 24 hours', () => {
  test('the window is exactly 24 hours', () => {
    assert.equal(SNOOZE_MS, 24 * 60 * 60 * 1000)
    assert.equal(snoozeAll(['a'], NOW).until, NOW + SNOOZE_MS)
  })

  test('a cleared key is hidden until the window ends, then comes back', () => {
    const s = snoozeAll(['handover:1'], NOW)
    assert.equal(isSnoozed(s, 'handover:1', NOW + 1), true)
    assert.equal(isSnoozed(s, 'handover:1', NOW + SNOOZE_MS - 1), true)
    assert.equal(isSnoozed(s, 'handover:1', NOW + SNOOZE_MS), false)
  })

  test('something new shows at once, inside the window', () => {
    const s = snoozeAll(['handover:1'], NOW)
    assert.equal(isSnoozed(s, 'handover:2', NOW + 1), false)
    assert.equal(isHidden(s, 'handover:2'), false)
  })

  test('a holder whose amount or state changes is new', () => {
    const before = itemKeys.holder('u1', 45000, '2 payments, not handed over')
    const s = snoozeAll([before], NOW)
    assert.equal(isHidden(s, itemKeys.holder('u1', 60000, '2 payments, not handed over')), false)
    assert.equal(isHidden(s, itemKeys.holder('u1', 45000, 'Handed to Nitish Bansal, not accepted')), false)
    assert.equal(isHidden(s, before), true)
  })

  test('nothing hidden with no Clear all', () => {
    assert.equal(isHidden(EMPTY_SNOOZE, 'request:1'), false)
  })
})

describe('the stored value', () => {
  test('round-trips, per signed-in user', () => {
    const s = snoozeAll(['a', 'a', 'b'], NOW)
    assert.deepEqual(s.keys, ['a', 'b'])
    assert.deepEqual(readSnooze(JSON.stringify(s), NOW + 5), s)
    assert.equal(snoozeStorageKey('u1') === snoozeStorageKey('u2'), false)
  })

  test('expired, missing or malformed is no snooze', () => {
    const s = snoozeAll(['a'], NOW)
    assert.deepEqual(readSnooze(JSON.stringify(s), NOW + SNOOZE_MS), EMPTY_SNOOZE)
    assert.deepEqual(readSnooze(null, NOW), EMPTY_SNOOZE)
    assert.deepEqual(readSnooze('{not json', NOW), EMPTY_SNOOZE)
    assert.deepEqual(readSnooze('{"until":"soon","keys":[1]}', NOW), EMPTY_SNOOZE)
  })
})
