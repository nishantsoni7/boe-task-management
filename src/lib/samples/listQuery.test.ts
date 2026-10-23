/**
 * Which statuses each Sample Tracking tab means, who sees which rows, and that
 * every tab's page order is unique.
 *
 * Run:
 *   npx tsx --test src/lib/samples/listQuery.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { TAB_KEYS, TAB_STATUSES, ownRequestsOnly, tabOrder } from './listQuery'

describe('tab statuses', () => {
  test('every tab is defined, and All has no status filter', () => {
    assert.equal(TAB_STATUSES.all, null)
    assert.equal(TAB_KEYS.length, 7)
  })

  test('Closed is returned plus lost, as the page always grouped them', () => {
    assert.deepEqual(TAB_STATUSES.closed, ['returned', 'lost'])
  })

  test('no status belongs to two tabs', () => {
    const seen = new Set<string>()
    for (const key of TAB_KEYS) {
      for (const status of TAB_STATUSES[key] ?? []) {
        assert.equal(seen.has(status), false, `${status} appears twice`)
        seen.add(status)
      }
    }
    assert.equal(seen.size, 7)
  })
})

describe('ownRequestsOnly', () => {
  test('an administrator or a permission holder sees every request', () => {
    assert.equal(ownRequestsOnly({ isAdmin: true, hasAnySamplePermission: false, userId: 'u1' }), null)
    assert.equal(ownRequestsOnly({ isAdmin: false, hasAnySamplePermission: true, userId: 'u1' }), null)
  })

  test('anyone else sees only the requests they raised', () => {
    assert.equal(ownRequestsOnly({ isAdmin: false, hasAnySamplePermission: false, userId: 'u1' }), 'u1')
  })
})

describe('tabOrder', () => {
  test('every tab ends on id so a page boundary cannot shuffle rows', () => {
    for (const key of TAB_KEYS) {
      assert.equal(tabOrder(key).at(-1)?.column, 'id')
    }
  })

  test('dispatched lists the earliest expected return first, nulls last', () => {
    const [first] = tabOrder('dispatched')
    assert.deepEqual(first, { column: 'expected_return_date', ascending: true, nullsFirst: false })
  })
})
