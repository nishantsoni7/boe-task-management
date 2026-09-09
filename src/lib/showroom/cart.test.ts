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
