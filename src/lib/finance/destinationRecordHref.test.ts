/**
 * Payment Requests' "Against" cell: a link ONLY where the reader may already
 * open the record. A visible reference is not permission to open it.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { destinationRecordHref, type LinkableDestination } from './crossModuleLinks'

const ORDER = 'b3a2c1d0-0000-4000-8000-000000000425'
const PI = 'c4b3a2d1-0000-4000-8000-000000000526'

const order = (over: Partial<LinkableDestination> = {}): LinkableDestination =>
  ({ kind: 'confirmed_order', orderId: ORDER, submissionId: null, reference: '0425', ...over })
const pi = (over: Partial<LinkableDestination> = {}): LinkableDestination =>
  ({ kind: 'pi_draft', orderId: null, submissionId: PI, reference: 'Hotel.xlsx', ...over })

describe('destinationRecordHref', () => {
  test('one visible Order, and a reader with Orders access → the Order', () => {
    assert.equal(destinationRecordHref(order(), true), `/orders/${ORDER}`)
  })

  test('one visible PI Draft → the PI record', () => {
    assert.equal(destinationRecordHref(pi(), true), `/orders/drafts/${PI}`)
  })

  test('NO Orders module entry → no link, whatever the payment names', () => {
    assert.equal(destinationRecordHref(order(), false), null)
    assert.equal(destinationRecordHref(pi(), false), null)
  })

  test('a record the reader\'s own RLS did not return (no reference) → no link', () => {
    assert.equal(destinationRecordHref(order({ reference: null }), true), null)
    assert.equal(destinationRecordHref(pi({ reference: null }), true), null)
  })

  test('a destination that names no single record → no link', () => {
    assert.equal(destinationRecordHref({ kind: 'mixed', orderId: null, submissionId: null, reference: '2 Orders · 1 PI Draft' }, true), null)
    assert.equal(destinationRecordHref({ kind: 'suspense', orderId: null, submissionId: null, reference: null }, true), null)
    assert.equal(destinationRecordHref(order({ orderId: null }), true), null)
  })

  test('not loaded yet, or no destination row → no link', () => {
    assert.equal(destinationRecordHref(undefined, true), null)
    assert.equal(destinationRecordHref(null, true), null)
  })

  test('ids are encoded into the path, never interpolated raw', () => {
    assert.equal(destinationRecordHref(order({ orderId: 'a/../b' }), true), '/orders/a%2F..%2Fb')
  })
})
