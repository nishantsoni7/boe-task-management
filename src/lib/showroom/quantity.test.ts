/**
 * Quotation quantity: what the screen shows, what it charges, what it saves.
 *
 * The reported defect: a quantity edit "sometimes" survived and sometimes
 * snapped back to its previous value. Two independent mechanisms, both
 * reproduced here as logic:
 *
 *  1. On blur, the page cleared the typed value and only THEN re-fetched the
 *     inquiry. In between, the input fell back to the pre-edit snapshot, so the
 *     number visibly reverted for the length of a round-trip — and if either
 *     the save or the re-fetch failed, it reverted permanently, silently,
 *     because neither response was ever checked.
 *  2. Every money figure — line total, subtotal, discount, final value — and
 *     the payload sent to the quotation route read the SERVER snapshot, never
 *     the typed value. So the totals lagged the number in the box, and a
 *     quantity typed but not blurred never reached the PDF at all.
 *
 * Run:
 *   npx tsx --test src/lib/showroom/quantity.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_ITEM_QUANTITY,
  MIN_ITEM_QUANTITY,
  applyConfirmedQuantity,
  clampQuantity,
  effectiveQuantity,
  hasInvalidQuantity,
  parseQuantityInput,
  pendingQuantityWrites,
  subtotalOf,
} from './quantity'

describe('parseQuantityInput', () => {
  test('a typed quantity becomes the value, and counts as a change', () => {
    const r = parseQuantityInput('5', 1)
    assert.deepEqual(r, { value: 5, changed: true, valid: true })
  })

  test('not editing falls back to the server value', () => {
    assert.deepEqual(parseQuantityInput(undefined, 3), { value: 3, changed: false, valid: true })
  })

  test('an empty box mid-typing is invalid but does NOT reset anything', () => {
    // Clearing the field on the way to "12" must not be read as a request to
    // change the quantity, and must not persist anything.
    const r = parseQuantityInput('', 5)
    assert.equal(r.valid, false)
    assert.equal(r.changed, false)
    assert.equal(r.value, 5, 'display falls back to the last known good value')
  })

  test('junk cannot corrupt the quantity', () => {
    for (const raw of ['0', '-3', 'abc', '5px', '1e3', '2.5', ' ']) {
      const r = parseQuantityInput(raw, 4)
      assert.equal(r.valid, false, `${JSON.stringify(raw)} must be invalid`)
      assert.equal(r.value, 4, `${JSON.stringify(raw)} must keep the current value`)
    }
  })

  test('whitespace around a real number is accepted', () => {
    assert.deepEqual(parseQuantityInput('  7 ', 1), { value: 7, changed: true, valid: true })
  })

  test('retyping the same number is valid but not a change — no pointless write', () => {
    assert.deepEqual(parseQuantityInput('3', 3), { value: 3, changed: false, valid: true })
  })

  test('an absurd quantity is clamped rather than sent', () => {
    const r = parseQuantityInput('100000', 1)
    assert.equal(r.value, MAX_ITEM_QUANTITY)
    assert.equal(r.valid, true)
  })

  test('clampQuantity holds the range against anything', () => {
    assert.equal(clampQuantity(0), MIN_ITEM_QUANTITY)
    assert.equal(clampQuantity(-5), MIN_ITEM_QUANTITY)
    assert.equal(clampQuantity(1e9), MAX_ITEM_QUANTITY)
    assert.equal(clampQuantity(Number.NaN), MIN_ITEM_QUANTITY)
    assert.equal(clampQuantity(2.4), 2)
  })
})

describe('money always matches the number in the box', () => {
  const items = [
    { id: 'a', quantity: 1, rate: 9200 },
    { id: 'b', quantity: 3, rate: 16999 },
  ]

  test('a typed quantity is what the line is charged at', () => {
    // The defect: the input showed 5 while the line total was still 1 × rate.
    assert.equal(effectiveQuantity(1, '5'), 5)
    assert.equal(effectiveQuantity(1, undefined), 1)
  })

  test('the subtotal uses typed quantities, not the last saved ones', () => {
    const pending: Record<string, string> = { a: '5' }
    const before = subtotalOf(items, i => i.rate, i => i.quantity)
    const after  = subtotalOf(items, i => i.rate, i => effectiveQuantity(i.quantity, pending[i.id]))
    assert.equal(before, 9200 + 3 * 16999)
    assert.equal(after,  5 * 9200 + 3 * 16999)
  })

  test('discount and final value follow the same quantities', () => {
    const pending: Record<string, string> = { a: '5' }
    const subtotal = subtotalOf(items, i => i.rate, i => effectiveQuantity(i.quantity, pending[i.id]))
    const discount = subtotal * 10 / 100
    assert.equal(subtotal, 96997)
    assert.equal(Math.round(subtotal - discount), 87297)
  })

  test('a half-typed box does not blank out the totals', () => {
    const pending: Record<string, string> = { a: '' }
    const subtotal = subtotalOf(items, i => i.rate, i => effectiveQuantity(i.quantity, pending[i.id]))
    assert.equal(subtotal, 9200 + 3 * 16999, 'falls back to the last good quantity')
  })
})

describe('what gets saved, and what happens when saving fails', () => {
  const items = [
    { id: 'a', quantity: 1 },
    { id: 'b', quantity: 3 },
    { id: 'c', quantity: 7 },
  ]

  test('only genuinely changed lines are written', () => {
    const pending = { a: '5', b: '3', c: undefined }
    assert.deepEqual(pendingQuantityWrites(items, pending), [{ id: 'a', quantity: 5 }])
  })

  test('multiple edited lines are all written, independently', () => {
    const pending = { a: '5', b: '9' }
    assert.deepEqual(pendingQuantityWrites(items, pending), [
      { id: 'a', quantity: 5 },
      { id: 'b', quantity: 9 },
    ])
  })

  test('a quantity typed but never blurred is still sent to the quotation', () => {
    // Previously nothing flushed quantity: handleSaveItemEdits wrote only the
    // rate and the note, so Preview and Generate used the stale value.
    assert.deepEqual(pendingQuantityWrites(items, { c: '12' }), [{ id: 'c', quantity: 12 }])
  })

  test('an invalid entry is never written', () => {
    assert.deepEqual(pendingQuantityWrites(items, { a: '' }), [])
    assert.deepEqual(pendingQuantityWrites(items, { a: '0' }), [])
    assert.deepEqual(pendingQuantityWrites(items, { a: 'x' }), [])
  })

  test('an invalid entry is reported rather than silently ignored', () => {
    assert.equal(hasInvalidQuantity(items, { a: '0' }), true)
    assert.equal(hasInvalidQuantity(items, { a: '5' }), false)
    assert.equal(hasInvalidQuantity(items, {}), false)
  })

  test('a failed save leaves the typed value in place, not the old one', () => {
    // The old code cleared the pending value unconditionally, so a rejected
    // PATCH reverted the box to the pre-edit number with no error shown.
    // Keeping the pending entry is what "does not silently reset" means.
    const pending: Record<string, string> = { a: '5' }
    // …save rejects; the caller keeps `pending` untouched…
    assert.equal(effectiveQuantity(1, pending.a), 5, 'the user still sees what they typed')
    assert.deepEqual(pendingQuantityWrites(items, pending), [{ id: 'a', quantity: 5 }],
      'and it is still queued to be retried')
  })
})

describe('applyConfirmedQuantity', () => {
  const items = [
    { id: 'a', quantity: 1, rate_override: 100 },
    { id: 'b', quantity: 3, rate_override: null },
  ]

  test('the server-confirmed quantity replaces the snapshot for that line only', () => {
    const next = applyConfirmedQuantity(items, 'a', 5)
    assert.equal(next[0].quantity, 5)
    assert.equal(next[1].quantity, 3)
  })

  test('other columns on the same line are untouched', () => {
    // A quantity save must not clobber a rate the user is still editing.
    assert.equal(applyConfirmedQuantity(items, 'a', 5)[0].rate_override, 100)
  })

  test('the input array is never mutated', () => {
    const snapshot = JSON.parse(JSON.stringify(items))
    applyConfirmedQuantity(items, 'a', 5)
    assert.deepEqual(items, snapshot)
  })

  test('an unknown id changes nothing', () => {
    assert.deepEqual(applyConfirmedQuantity(items, 'zzz', 9), items)
  })

  test('a nonsense confirmation is clamped, not stored raw', () => {
    assert.equal(applyConfirmedQuantity(items, 'a', 0)[0].quantity, MIN_ITEM_QUANTITY)
  })
})
