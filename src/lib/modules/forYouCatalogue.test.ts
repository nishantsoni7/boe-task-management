/**
 * What the For you column may show (owner, 2026-10-31): an administrator's
 * setting per item, each person's own choices, and the rule that neither ever
 * widens access. The rules are executed here; the screens are pinned in
 * src/app/modules/forYouSettings.test.ts.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FOR_YOU_ITEMS,
  FOR_YOU_MODES,
  NO_FOR_YOU_ACCESS,
  isForYouItemKey,
  isItemOn,
  itemApplies,
  modeOf,
  readForYouModes,
  readHiddenItems,
  withItemHidden,
  type ForYouAccess,
  type ForYouItemKey,
} from './forYouCatalogue'

const all = (over: Partial<ForYouAccess> = {}): ForYouAccess => ({ ...NO_FOR_YOU_ACCESS, ...over })

describe('the list', () => {
  test('keys are unique and fit the database check', () => {
    const keys = FOR_YOU_ITEMS.map(i => i.key)
    assert.equal(new Set(keys).size, keys.length)
    for (const key of keys) assert.match(key, /^[a-z][a-z0-9_]{0,63}$/)
  })

  test('the owner\'s defaults: payment requests on, cash handed to you always on, the four extras off', () => {
    assert.equal(modeOf({}, 'payment_request'), 'optional')
    assert.equal(modeOf({}, 'cash_handed_to_you'), 'always')
    for (const key of ['pi_waiting_approval', 'payment_sent_back', 'order_change_request', 'pi_waiting_operations'] as const) {
      assert.equal(modeOf({}, key), 'off', `${key} starts off`)
    }
  })

  test('only one item starts Always on', () => {
    assert.deepEqual(FOR_YOU_ITEMS.filter(i => i.defaultMode === 'always').map(i => i.key), ['cash_handed_to_you'])
  })

  test('every card that existed before keeps showing by default', () => {
    for (const key of ['announcement', 'machine_stopped', 'pi_returned', 'cash_handed_to_you', 'handover_waiting',
      'cash_you_hold', 'cash_not_with_company', 'leave_late'] as const) {
      assert.equal(isItemOn(key, {}, []), true, key)
    }
  })
})

describe('the administrator and the person', () => {
  test('Off wins over everything: nobody gets it', () => {
    assert.equal(isItemOn('announcement', { announcement: 'off' }, []), false)
  })

  test('Optional is on unless the person turned it off', () => {
    assert.equal(isItemOn('announcement', {}, []), true)
    assert.equal(isItemOn('announcement', {}, ['announcement']), false)
  })

  test('Always on ignores the person\'s choice', () => {
    assert.equal(isItemOn('announcement', { announcement: 'always' }, ['announcement']), true)
  })

  test('adding an extra item turns it on for those who qualify', () => {
    assert.equal(isItemOn('pi_waiting_approval', {}, []), false)
    assert.equal(isItemOn('pi_waiting_approval', { pi_waiting_approval: 'optional' }, []), true)
  })

  test('turning an item off and back on leaves the rest of the list alone', () => {
    const off = withItemHidden(['leave_late'], 'announcement', true)
    assert.deepEqual(off, ['leave_late', 'announcement'])
    assert.deepEqual(withItemHidden(off, 'announcement', false), ['leave_late'])
    assert.deepEqual(withItemHidden(off, 'announcement', true), ['leave_late', 'announcement'], 'no repeats')
  })
})

describe('never wider than access', () => {
  test('a new payment request needs verifying AND reading other people\'s payments', () => {
    assert.equal(itemApplies('payment_request', all()), false)
    assert.equal(itemApplies('payment_request', all({ finance: true })), false)
    assert.equal(itemApplies('payment_request', all({ verifiesPayments: true })), true)
  })

  test('each gated item follows its own access', () => {
    const cases: [ForYouItemKey, Partial<ForYouAccess>][] = [
      ['pi_returned', { orders: true }],
      ['machine_stopped', { admin: true }],
      ['leave_late', { admin: true }],
      ['cash_not_with_company', { seesAllCash: true }],
      ['pi_waiting_approval', { approvesPis: true }],
      ['payment_sent_back', { finance: true }],
      ['order_change_request', { admin: true }],
      ['pi_waiting_operations', { orders: true }],
    ]
    for (const [key, access] of cases) {
      assert.equal(itemApplies(key, all()), false, `${key} is closed without access`)
      assert.equal(itemApplies(key, all(access)), true, `${key} opens with its access`)
    }
  })

  test('your own cash and announcements reach everyone', () => {
    for (const key of ['announcement', 'cash_handed_to_you', 'handover_waiting', 'cash_you_hold'] as const) {
      assert.equal(itemApplies(key, all()), true, key)
    }
  })
})

describe('what comes back from the database is data', () => {
  test('a row naming no current item or mode is ignored', () => {
    assert.deepEqual(readForYouModes([
      { item_key: 'announcement', mode: 'off' },
      { item_key: 'retired_item', mode: 'off' },
      { item_key: 'leave_late', mode: 'sometimes' },
      null,
    ]), { announcement: 'off' })
  })

  test('anything that is not a list reads as no settings', () => {
    assert.deepEqual(readForYouModes(null), {})
    assert.deepEqual(readHiddenItems('announcement'), [])
    assert.deepEqual(readHiddenItems(undefined), [])
  })

  test('a hidden list keeps only current items, once each', () => {
    assert.deepEqual(readHiddenItems(['announcement', 'announcement', 'retired_item', 7]), ['announcement'])
  })

  test('the modes and keys the checks accept', () => {
    assert.deepEqual([...FOR_YOU_MODES], ['off', 'optional', 'always'])
    assert.equal(isForYouItemKey('payment_request'), true)
    assert.equal(isForYouItemKey('nope'), false)
  })
})
