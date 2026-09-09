/**
 * The showroom selection.
 *
 * The defect this locks down: scanning the same product sticker twice pushed a
 * second row instead of raising the first one's quantity, so the list showed
 * the same chair twice and removing "the duplicate" removed a real quantity.
 * The old code said so out loud — "Same product added twice is kept as a
 * separate row in V1".
 *
 * Run:
 *   npx tsx --test src/lib/showroom/cart.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_ITEM_QUANTITY,
  addToCart,
  changeQuantity,
  parseCart,
  removeFromCart,
  summarizeCart,
  type CartItem,
} from './cart'

const chair = (over: Partial<CartItem> = {}): CartItem => ({
  product_id: 'p-1',
  product_code: 'BOE-221',
  name: 'Dining Chair',
  mrp: 9200,
  quantity: 1,
  image_url: null,
  dim_str: null,
  ...over,
})

describe('addToCart', () => {
  test('a new product becomes a line and is confirmed by code and name', () => {
    const out = addToCart([], chair())
    assert.equal(out.cart.length, 1)
    assert.equal(out.merged, false)
    assert.equal(out.quantity, 1)
    assert.equal(out.message, 'BOE-221 · Dining Chair added')
  })

  test('scanning the same product again raises the quantity instead of duplicating', () => {
    const first = addToCart([], chair())
    const second = addToCart(first.cart, chair())
    assert.equal(second.cart.length, 1)
    assert.equal(second.merged, true)
    assert.equal(second.quantity, 2)
    assert.equal(second.message, 'BOE-221 already selected. Quantity increased to 2.')
  })

  test('a requested quantity is added to what is already there', () => {
    const first = addToCart([], chair({ quantity: 2 }))
    assert.equal(first.quantity, 2)
    const second = addToCart(first.cart, chair(), 3)
    assert.equal(second.quantity, 5)
  })

  test('identity is the product id, not the code shown on the sticker', () => {
    const start = addToCart([], chair()).cart
    const other = addToCart(start, chair({ product_id: 'p-2', product_code: 'BOE-221' }))
    assert.equal(other.cart.length, 2)
    assert.equal(other.merged, false)
  })

  test('the input list is never mutated', () => {
    const start = addToCart([], chair()).cart
    const snapshot = JSON.parse(JSON.stringify(start))
    addToCart(start, chair())
    assert.deepEqual(start, snapshot)
  })

  test('quantity is capped, and at the cap it does not claim to have increased', () => {
    const full = addToCart([], chair({ quantity: MAX_ITEM_QUANTITY })).cart
    const again = addToCart(full, chair())
    assert.equal(again.quantity, MAX_ITEM_QUANTITY)
    assert.match(again.message, /already selected \(maximum quantity 99\)/)
    assert.equal(/increased to/.test(again.message), false)
  })

  test('a nonsense quantity becomes one rather than NaN', () => {
    const out = addToCart([], chair({ quantity: Number.NaN }))
    assert.equal(out.quantity, 1)
    assert.equal(addToCart([], chair(), -4).quantity, 1)
  })
})

describe('parseCart', () => {
  test('reads back what was written', () => {
    const saved = JSON.stringify(addToCart([], chair()).cart)
    assert.deepEqual(parseCart(saved).map(c => c.product_code), ['BOE-221'])
  })

  test('a missing, empty or corrupt value is an empty selection, never a crash', () => {
    assert.deepEqual(parseCart(null), [])
    assert.deepEqual(parseCart(''), [])
    assert.deepEqual(parseCart('not json'), [])
    assert.deepEqual(parseCart('{"a":1}'), [])
    assert.deepEqual(parseCart('[null, 3, "x"]'), [])
  })

  test('a row with no product id is dropped — it could not be submitted anyway', () => {
    assert.deepEqual(parseCart('[{"product_code":"BOE-1","mrp":10}]'), [])
  })

  test('a row with a broken price still renders instead of throwing on toLocaleString', () => {
    const [item] = parseCart('[{"product_id":"p-1","mrp":"abc","quantity":"x"}]')
    assert.equal(item.mrp, 0)
    assert.equal(item.quantity, 1)
    assert.equal(item.name, 'Product')
    assert.equal(item.product_code, '—')
  })

  test('duplicates saved by the old version are folded on the way in', () => {
    // A customer mid-visit when this ships has duplicate rows in localStorage.
    // They should see one line of two, not carry the old bug into this session.
    const legacy = JSON.stringify([
      { product_id: 'p-1', product_code: 'BOE-221', name: 'Dining Chair', mrp: 9200, quantity: 1 },
      { product_id: 'p-1', product_code: 'BOE-221', name: 'Dining Chair', mrp: 9200, quantity: 1 },
    ])
    const restored = parseCart(legacy)
    assert.equal(restored.length, 1)
    assert.equal(restored[0].quantity, 2)
  })
})

describe('changeQuantity and removeFromCart', () => {
  const cart = [chair(), chair({ product_id: 'p-2', product_code: 'BOE-9', mrp: 4000 })]

  test('a step up and a step down move only the named line', () => {
    const up = changeQuantity(cart, 'p-1', +1)
    assert.equal(up[0].quantity, 2)
    assert.equal(up[1].quantity, 1)
  })

  test('quantity never goes below one — removing is a different action', () => {
    assert.equal(changeQuantity(cart, 'p-1', -5)[0].quantity, 1)
  })

  test('removal is by product, so it cannot hit the wrong row after a re-order', () => {
    const left = removeFromCart(cart, 'p-1')
    assert.deepEqual(left.map(c => c.product_id), ['p-2'])
  })
})

describe('summarizeCart', () => {
  test('counts pieces rather than lines, and reads as the sticky bar shows it', () => {
    const cart = [chair({ quantity: 2, mrp: 100000 }), chair({ product_id: 'p-2', quantity: 4, mrp: 11250 })]
    const s = summarizeCart(cart)
    assert.equal(s.lines, 2)
    assert.equal(s.units, 6)
    assert.equal(s.total, 245000)
    assert.equal(s.label, '6 items · ₹2,45,000')
  })

  test('one piece is singular', () => {
    assert.equal(summarizeCart([chair()]).label, '1 item · ₹9,200')
  })

  test('an empty selection totals nothing', () => {
    const s = summarizeCart([])
    assert.equal(s.units, 0)
    assert.equal(s.total, 0)
    assert.equal(s.label, '0 items · ₹0')
  })
})

// ── Quantity persistence across the selection flow ───────────────────────────
//
// The reported defect: a quantity edit sometimes reverted to its previous value
// when the customer moved between products or screens. On this side of the
// module the mechanism was a lost update — the page's handler derived every
// change from the `cart` value captured by the current render, so two taps
// before a re-render both started from the same snapshot and the second
// overwrote the first, in state and in localStorage alike.
//
// The page now derives each change from the last committed value. These tests
// pin the invariant that makes that correct: an update composes with the one
// before it, and a round-trip through storage returns exactly what was written.

describe('quantity survives the selection flow', () => {
  /** What the page writes to localStorage, and reads back on the next mount. */
  const roundTrip = (cart: CartItem[]): CartItem[] => parseCart(JSON.stringify(cart))
  const qtyOf = (cart: CartItem[], id: string) =>
    cart.find(c => c.product_id === id)?.quantity

  const A = chair({ product_id: 'A', product_code: 'BOE-A', mrp: 1000 })
  const B = chair({ product_id: 'B', product_code: 'BOE-B', mrp: 2000 })
  const C = chair({ product_id: 'C', product_code: 'BOE-C', mrp: 3000 })

  test('1 → 5 persists through a save and reload', () => {
    let cart = addToCart([], A).cart
    cart = changeQuantity(cart, 'A', +4)
    assert.equal(qtyOf(cart, 'A'), 5)
    assert.equal(qtyOf(roundTrip(cart), 'A'), 5)
  })

  test('consecutive steps compose — the defect was that they did not', () => {
    const start = addToCart([], A).cart

    // What the page used to do: every handler in one render derived from that
    // render's `cart`, so two taps both started here and the second overwrote
    // the first. Two taps, one increment.
    const firstTap  = changeQuantity(start, 'A', +1)
    const secondTap = changeQuantity(start, 'A', +1)
    void firstTap
    assert.equal(qtyOf(secondTap, 'A'), 2, 'both derived from one snapshot: a tap is lost')

    let composed = start
    composed = changeQuantity(composed, 'A', +1)
    composed = changeQuantity(composed, 'A', +1)
    assert.equal(qtyOf(composed, 'A'), 3, 'derived from the latest value each time')
  })

  test('changing one product never disturbs another', () => {
    let cart = addToCart(addToCart(addToCart([], A).cart, B).cart, C).cart
    cart = changeQuantity(cart, 'A', +4)   // 5
    cart = changeQuantity(cart, 'B', +2)   // 3
    cart = changeQuantity(cart, 'C', +6)   // 7
    assert.deepEqual([qtyOf(cart, 'A'), qtyOf(cart, 'B'), qtyOf(cart, 'C')], [5, 3, 7])

    // Editing A again leaves B and C exactly where they were.
    cart = changeQuantity(cart, 'A', -1)
    assert.deepEqual([qtyOf(cart, 'A'), qtyOf(cart, 'B'), qtyOf(cart, 'C')], [4, 3, 7])
  })

  test('multiple products keep independent quantities across a reload', () => {
    let cart = addToCart(addToCart(addToCart([], A).cart, B).cart, C).cart
    cart = changeQuantity(cart, 'A', +4)
    cart = changeQuantity(cart, 'B', +2)
    cart = changeQuantity(cart, 'C', +6)
    const restored = roundTrip(cart)
    assert.deepEqual([qtyOf(restored, 'A'), qtyOf(restored, 'B'), qtyOf(restored, 'C')], [5, 3, 7])
  })

  test('a duplicate scan builds on the edited quantity, not the original', () => {
    // 1, hand-edited to 5, then the same sticker is scanned again → 6.
    let cart = addToCart([], A).cart
    cart = changeQuantity(cart, 'A', +4)
    const rescan = addToCart(cart, A, 1)
    assert.equal(rescan.quantity, 6)
    assert.equal(rescan.merged, true)
    assert.equal(rescan.cart.length, 1, 'still one line, not a duplicate row')
    assert.match(rescan.message, /increased to 6/)
  })

  test('a scan after a reload also builds on the persisted quantity', () => {
    // The scan lands in a NEW TAB, so it reads the cart back from storage —
    // this is the path that must not resurrect a stale quantity.
    let cart = addToCart([], A).cart
    cart = changeQuantity(cart, 'A', +4)
    const rescan = addToCart(roundTrip(cart), A, 1)
    assert.equal(rescan.quantity, 6)
  })

  test('the latest write wins over an earlier snapshot of the same cart', () => {
    const start = addToCart([], A).cart
    const stale = changeQuantity(start, 'A', +1)      // an older derivation
    const latest = changeQuantity(changeQuantity(start, 'A', +1), 'A', +3)  // 5
    // Whichever is written last is what a reload returns; the page must write
    // the latest, never the stale one.
    assert.equal(qtyOf(roundTrip(latest), 'A'), 5)
    assert.equal(qtyOf(roundTrip(stale), 'A'), 2)
  })

  test('quantity cannot be driven below one or above the cap by stepping', () => {
    let cart = addToCart([], A).cart
    for (let i = 0; i < 5; i++) cart = changeQuantity(cart, 'A', -1)
    assert.equal(qtyOf(cart, 'A'), 1)
    for (let i = 0; i < MAX_ITEM_QUANTITY + 5; i++) cart = changeQuantity(cart, 'A', +1)
    assert.equal(qtyOf(cart, 'A'), MAX_ITEM_QUANTITY)
  })

  test('a corrupt stored cart cannot wipe a quantity to something arbitrary', () => {
    // Restoring junk yields an empty selection rather than a cart of NaNs.
    assert.deepEqual(parseCart('[[]]'), [])
    assert.equal(parseCart('[{"product_id":"A","quantity":"nonsense"}]')[0].quantity, 1)
  })
})
