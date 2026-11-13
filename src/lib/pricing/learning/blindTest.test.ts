// Price learning, piece 1: the blind test, against a price pool made from a KNOWN rule so the test can say what the
// model should get right: bed price = 40,000 × (plan area / 6,000 sq in)^0.5 × 1.20 for teak × 1.05 per year newer.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { ModelPoint } from '../model'
import { blindTest, typesOf, type TestLine } from './blindTest'

const NOW = Date.parse('2026-11-14T06:00:00Z')
const YEAR = 365.25 * 86_400_000
const SIZES: [string, number][] = [['60 x 78', 60 * 78], ['72 x 78', 72 * 78], ['72 x 84', 72 * 84], ['78 x 84', 78 * 84]]
const rule = (area: number, teak: boolean, yearsAgo: number) => 40000 * Math.sqrt(area / 6000) * (teak ? 1.2 : 1) * Math.pow(1.05, -yearsAgo)

function bedPool(n: number): ModelPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const [dims, area] = SIZES[i % SIZES.length]
    const yearsAgo = (i % 5) * 0.4
    return { k: 'order', p: Math.round(rule(area, i % 3 === 0, yearsAgo)), q: 4, at: new Date(NOW - yearsAgo * YEAR).toISOString(), name: 'King bed with headboard', dims, material: i % 3 === 0 ? 'Teak wood' : 'Mango wood', finish: 'PU', client_type: null }
  })
}
const line = (over: Partial<TestLine> = {}): TestLine => ({ pi: 0, name: 'King bed with headboard', size: '72 x 84', material: 'Teak wood', customization: 'PU', qty: 10, price: Math.round(rule(72 * 84, true, 0)), date: new Date(NOW).toISOString().slice(0, 10), clientType: null, ...over })
const POOLS = { bed: bedPool(40), mirror: bedPool(3).map(p => ({ ...p, name: 'Wall mirror' })) }
const poolFor = (type: string) => (type === 'bed' ? POOLS.bed : type === 'mirror' ? POOLS.mirror : [])

describe('the blind test', () => {
  const lines: TestLine[] = [
    ...SIZES.map(([size, area]) => line({ size, price: Math.round(rule(area, true, 0)) })),
    line({ name: 'Planter stand', price: 3000 }),                         // a new design: no type
    line({ name: 'Wall mirror', size: '24 x 42', material: 'Mango', price: 6100 }), // a type with only 3 prices
  ]
  const t = blindTest(lines, poolFor, NOW)

  test('prices what it can and says plainly what it could not', () => {
    assert.equal(t.priced, 4)
    assert.equal(t.unpriced, 2)
    assert.equal(t.lines.length, 6)
    assert.equal(t.lines[4].model, null)
    assert.equal(t.lines[5].model, null)
  })

  test('on prices that follow the rule it is close, and the score says so', () => {
    assert.ok(t.avgMiss !== null && t.avgMiss < 4, `average miss ${t.avgMiss}`)
    assert.equal(t.hitRate, 100)
    assert.ok(t.orderGapPct !== null && Math.abs(t.orderGapPct) < 4)
    assert.deepEqual(t.byType.map(x => [x.type, x.n]), [['bed', 4]])
  })

  test('the biggest miss comes first, signed against the PI price', () => {
    const odd = blindTest([...lines.slice(0, 4), line({ price: 90000 })], poolFor, NOW)
    assert.equal(odd.worst[0].price, 90000)
    assert.ok(odd.worst[0].missPct! < -30, 'the model said far less than this PI')
    assert.equal(odd.hitRate, 80)
    assert.ok(odd.avgMiss! > 8 && odd.avgMiss! < 12, `one wild price lifts the average from under 1 to about 10 (${odd.avgMiss})`)
  })

  test('a PI from 1.5 years ago is priced as of its own date, not at today\'s level', () => {
    const [size, area] = SIZES[3]
    const old = line({ size, price: Math.round(rule(area, true, 1.5)), date: new Date(NOW - 1.5 * YEAR).toISOString().slice(0, 10) })
    const r = blindTest([old], poolFor, NOW)
    assert.ok(Math.abs(r.lines[0].missPct!) < 4, `as of its date: ${r.lines[0].missPct}`)
    // priced for today instead, the same line would look about 7% too high
    const today = blindTest([{ ...old, date: new Date(NOW).toISOString().slice(0, 10) }], poolFor, NOW)
    assert.ok(today.lines[0].missPct! > 5)
  })

  test('an empty batch and the product types in a batch', () => {
    const e = blindTest([], poolFor, NOW)
    assert.deepEqual([e.priced, e.unpriced, e.avgMiss, e.hitRate, e.orderGapPct, e.worst.length], [0, 0, null, null, null, 0])
    assert.deepEqual(typesOf(lines), ['bed', 'mirror'])
  })
})
