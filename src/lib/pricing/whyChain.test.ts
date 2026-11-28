// "Why this price" (28 Nov 2026): the chain a suggestion is made of must close on EXACTLY the price the estimator shows, and the closest past
// prices must be real prices of the same kind of product. Data made from a known rule, as in model.test.ts.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { closestPrices, explain, fitType, priceLine, type Fit, type ModelPoint } from './model'
import { lineFeatures } from './features'
import { roundPrice } from './suggest'

const NOW = Date.parse('2026-11-28T06:00:00Z')

let seed = 11
const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }

/** Chairs the way real PIs write them: most with no size, a few with one; two woods; bulk orders cheaper. */
function chairs(n: number): ModelPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const sized = i % 5 === 0, ash = i % 4 === 1, bulk = i % 3 === 0
    const price = (sized ? 9000 : 6000) * (ash ? 1.3 : 1) * (bulk ? 0.75 : 1) * (1 + (rand() - 0.5) * 0.05)
    return {
      k: i % 7 === 6 ? 'quote' : 'order', p: Math.round(price), q: bulk ? 40 : 6, at: new Date(NOW - (i % 6) * 30 * 86_400_000).toISOString(),
      name: 'Chair', dims: sized ? `${16 + (i % 4) * 2} x ${18 + (i % 3) * 2} x 33` : 'Standard Dimension Seating Height 18"', material: ash ? 'Ash wood, cane & upholstery' : 'Acacia wood, cane & upholstery', finish: i % 2 ? 'Natural' : null, client_type: null,
    } as ModelPoint
  })
}

const POINTS = chairs(60)
const LINES = [
  { name: 'Chair', size: 'Standard Dumension Seating Height 18"', material: 'Acacia Wood, Natural cane & Upholstery', qty: 37 },
  { name: 'Chair', size: '26 x 28 x 33 inches', material: 'Ash wood', qty: 4 },
  { name: 'Chair', size: '', material: 'Teak', finish: 'Powder coat', qty: 120 },
]

describe('the chain closes on the price the estimator shows', () => {
  for (const line of LINES) {
    test(`${line.size || 'no size'}, ${line.material}, ${line.qty} pieces`, () => {
      const fits = new Map<string, Fit | null>()
      const s = priceLine(POINTS, line, NOW, fits)!
      const chain = s.why!()
      assert.equal(chain.price, s.price)
      assert.equal(chain.low, s.low)
      assert.equal(chain.high, s.high)
      assert.equal(chain.n, s.n)
      // base times every factor is the price before rounding: the screen multiplies the same numbers, so it closes by arithmetic.
      const run = chain.steps.reduce((p, st) => p * Math.exp(st.c), chain.base)
      assert.equal(roundPrice(run), chain.price)
      // biggest first, except the small effects together, which come last
      const listed = chain.steps.filter(st => st.key !== 'rest')
      assert.deepEqual(listed.map(st => Math.abs(st.c)), [...listed.map(st => Math.abs(st.c))].sort((a, b) => b - a))
      for (const st of chain.steps) assert.equal(st.pct, Math.round((Math.exp(st.c) - 1) * 100))
    })
  }

  test('a chair written with no size gets a "Size not written" step that says how many prices are also unsized', () => {
    const s = priceLine(POINTS, LINES[0], NOW)!
    const size = s.why!().steps.find(st => st.key === 'size')!
    assert.equal(size.label, 'Size not written')
    assert.match(size.behind, /^\d+ of the 60 chair prices are also written without a size$/)
    assert.ok(size.c < 0, 'the sized chairs cost more, so the unsized ones are priced lower')
    const written = priceLine(POINTS, LINES[1], NOW)!.why!().steps.find(st => st.key === 'size')!
    assert.match(written.label, /^Its size against a typical chair$/)
  })

  test('the volume step names its band and counts the prices in it', () => {
    const qty = priceLine(POINTS, LINES[0], NOW)!.why!().steps.find(st => st.key === 'qty')!
    assert.equal(qty.label, '11–50 pieces (volume)')
    assert.match(qty.behind, /^\d+ of the 60 prices are in this band$/)
  })

  test('the starting point is the typical product: its usual material, finish and size', () => {
    const c = priceLine(POINTS, LINES[0], NOW)!.why!()
    assert.equal(c.typical.material, 'acacia')
    assert.equal(typeof c.typical.area, 'number')
    assert.ok(c.base > 0)
  })

  test('the plain suggestion is unchanged: nothing extra to copy, compare or send as feedback', () => {
    const s = priceLine(POINTS, LINES[0], NOW)!
    assert.deepEqual(Object.keys(s).sort(), ['basis', 'confidence', 'engine', 'high', 'low', 'n', 'price', 'reasons', 'type'])
    assert.ok(!JSON.stringify(s).includes('why') && !JSON.stringify(s).includes('closest'))
    assert.equal(typeof s.why, 'function')
    assert.equal(typeof s.closest, 'function')
  })

  test('explain on the fit directly gives the same chain', () => {
    const fit = fitType(POINTS, 'chair', NOW)!
    const f = lineFeatures(LINES[0] as Parameters<typeof lineFeatures>[0])
    const direct = explain(fit, f)
    assert.equal(direct.price, priceLine(POINTS, LINES[0], NOW)!.price)
  })
})

describe('the closest past prices', () => {
  const line = lineFeatures(LINES[0] as Parameters<typeof lineFeatures>[0])

  test('only real prices of the same product type: no quote, no lost price, no other product', () => {
    const mixed: ModelPoint[] = [
      ...POINTS,
      { k: 'lost', p: 100, q: 40, at: new Date(NOW).toISOString(), name: 'Chair', dims: null, material: 'Acacia wood', finish: null, client_type: null } as ModelPoint,
      { k: 'order', p: 99_999, q: 40, at: new Date(NOW).toISOString(), name: 'King bed', dims: null, material: 'Acacia wood', finish: null, client_type: null } as ModelPoint,
    ]
    const near = closestPrices(mixed, line, 50)
    assert.ok(near.every(n => ['order', 'won', 'approved', 'taught'].includes(n.kind)))
    assert.ok(near.every(n => n.name === 'Chair'))
    assert.ok(!near.some(n => n.price === 100 || n.price === 99_999))
  })

  test('the same material and quantity band come first, and at most n are returned', () => {
    const near = closestPrices(POINTS, line, 5)
    assert.equal(near.length, 5)
    assert.ok(near.every(n => /acacia/i.test(n.detail) && (n.qty ?? 0) >= 11), JSON.stringify(near))
  })

  test('a taught case counts as a past price and says so', () => {
    const taught = { k: 'taught', p: 4795, q: 1, at: new Date(NOW).toISOString(), name: 'Chair', dims: null, material: 'Acacia wood', finish: 'Natural', client_type: null } as ModelPoint
    const near = closestPrices([...POINTS, taught], line, 40)
    assert.ok(near.some(n => n.kind === 'taught' && n.price === 4795))
  })

  test('ties go to the newest', () => {
    const a = { k: 'order', p: 5000, q: 40, at: '2026-01-01T00:00:00Z', name: 'Chair', dims: null, material: 'Acacia wood', finish: null, client_type: null } as ModelPoint
    const b = { ...a, p: 5100, at: '2026-10-01T00:00:00Z' } as ModelPoint
    assert.deepEqual(closestPrices([a, b], line, 2).map(n => n.price), [5100, 5000])
  })
})
