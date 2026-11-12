// Pricing model v2 against data made from a KNOWN rule, so the test can say what the model should have learned:
// bed price = 40,000 × (plan area / 6,000 sq in)^0.5 × 1.20 for teak × 0.94 for 51+ pieces × 1.05 per year newer,
// with a little noise. Names, sizes and materials are written the ways real PIs write them.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { dimensionsInches, lineFeatures, productType } from './features'
import { explainFit, fitType, predict, priceLine, type ModelPoint } from './model'

const NOW = Date.parse('2026-11-12T06:00:00Z')
let seed = 7
const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
const SIZES: [string, number][] = [[`5'0" x 6'6"`, 60 * 78], [`6'0" x 6'6"`, 72 * 78], ['72 x 84', 72 * 84], ['1500 x 2000 mm', (1500 / 25.4) * (2000 / 25.4)]]

function bedPoints(n: number): ModelPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const [dims, area] = SIZES[i % SIZES.length]
    const teak = i % 3 === 0
    const bulk = i % 4 === 1
    const yearsAgo = (i % 5) * 0.4
    const price = 40000 * Math.sqrt(area / 6000) * (teak ? 1.2 : 1) * (bulk ? 0.94 : 1) * Math.pow(1.05, -yearsAgo) * (1 + (rand() - 0.5) * 0.04)
    return {
      k: 'order', p: Math.round(price), q: bulk ? 60 : 4, at: new Date(NOW - yearsAgo * 365.25 * 86_400_000).toISOString(),
      name: i % 2 ? 'King Bed with headboard' : 'Boho room · Double bed', dims, material: teak ? 'Teak wood' : 'Mango wood', finish: 'PU matt', client_type: null,
    }
  })
}

describe('reading a line', () => {
  test('product type, size in any unit, material, finish, quantity band', () => {
    assert.equal(productType('Boho room · King bed'), 'bed')
    assert.equal(productType('Bedside table'), 'bedside')
    assert.equal(productType('Sofa cum bed'), 'sofa_bed')
    assert.equal(productType('Coffee table round'), 'coffee_table')
    assert.equal(productType('Something else'), null)
    assert.deepEqual(dimensionsInches(`6'0" x 6'6"`), [72, 78])
    assert.deepEqual(dimensionsInches('1800 x 2000 mm'), [70.87, 78.74])
    assert.deepEqual(dimensionsInches('180 x 200 cm'), [70.87, 78.74])
    assert.deepEqual(dimensionsInches('72 x 78 x 18'), [72, 78, 18])
    const f = lineFeatures({ name: 'King bed', size: '72 x 78', material: 'Sheesham wood', finish: 'Duco white', qty: 56 })
    assert.deepEqual([f.type, f.area, f.material, f.finish, f.qtyBand], ['bed', 5616, 'sheesham', 'duco', 'q51'])
  })
})

describe('the model learns how prices are made', () => {
  const points = bedPoints(40)
  const fit = fitType(points, 'bed', NOW)!

  test('it recovers the rule: teak about +20%, twice the area about +41%, 51+ pieces about −6%, about +5% a year', () => {
    const eff = Object.fromEntries(explainFit(fit).map(e => [e.label, e.pct]))
    assert.ok(Math.abs(eff['Teak instead of Mango'] - 20) <= 3, JSON.stringify(eff))
    assert.ok(Math.abs(eff['Twice the plan area'] - 41) <= 6, JSON.stringify(eff))
    assert.ok(Math.abs(eff['51+ pieces instead of 1–10 pieces'] + 6) <= 3, JSON.stringify(eff))
    assert.ok(Math.abs(eff['Price change per year'] - 5) <= 3, JSON.stringify(eff))
    assert.ok(fit.r2 > 0.9)
  })

  test('it prices a bed BOE never sold in exactly that form, with reasons, close to the rule', () => {
    const s = priceLine(points, { name: 'Queen bed', size: `5'6" x 6'6"`, material: 'Teak', finish: 'PU', qty: 2 }, NOW)!
    const truth = 40000 * Math.sqrt((66 * 78) / 6000) * 1.2
    assert.ok(Math.abs(s.price - truth) / truth < 0.05, `${s.price} vs ${Math.round(truth)}`)
    assert.equal(s.confidence, 'high')
    assert.ok(s.low < s.price && s.price < s.high)
    assert.ok(s.reasons.some(r => /^\+\d+% Teak instead of Mango$/.test(r)), s.reasons.join(' | '))
    assert.match(s.basis, /price model for Bed \(40 prices/)
  })

  test('a material never seen is priced as the usual one, says so, and is not high confidence', () => {
    const s = predict(fit, lineFeatures({ name: 'King bed', size: '72 x 78', material: 'Walnut', qty: 2 }))
    assert.notEqual(s.confidence, 'high')
    assert.ok(s.reasons.some(r => /Walnut material not seen before/.test(r)), s.reasons.join(' | '))
  })

  test('too few prices, an unknown type, or only lost quotations: no model (the screen falls back to the history lookup)', () => {
    assert.equal(priceLine(bedPoints(5), { name: 'King bed', size: '72 x 78' }, NOW), null)
    assert.equal(priceLine(points, { name: 'Pergola', size: '10 x 10' }, NOW), null)
    assert.equal(priceLine(points.map(p => ({ ...p, k: 'lost' as const })), { name: 'King bed' }, NOW), null)
  })

  test('other product types are not mixed in', () => {
    const mixed = [...points, ...points.map(p => ({ ...p, name: 'Bedside table', p: p.p / 5 }))]
    assert.equal(fitType(mixed, 'bed', NOW)!.n, 40)
    assert.equal(fitType(mixed, 'bedside', NOW)!.n, 40)
  })
})
