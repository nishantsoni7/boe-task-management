import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { examine } from './exam'
import { allTypeWords } from './pool'
import { isEcho, usedPrice, withUsedTag } from './echo'
import type { ModelPoint } from './model'

const NOW = Date.parse('2026-11-23T06:00:00Z')
let seed = 11
const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
const SIZES: [string, number][] = [['60 x 78', 60 * 78], ['72 x 78', 72 * 78], ['72 x 84', 72 * 84]]

// Beds from a known rule (price grows with the plan area, teak 20% more) with ±5% noise: the model should learn it well.
const beds = (n: number, noise = 0.1): ModelPoint[] => Array.from({ length: n }, (_, i) => {
  const [dims, area] = SIZES[i % SIZES.length]
  const teak = i % 3 === 0
  const price = 40000 * Math.sqrt(area / 6000) * (teak ? 1.2 : 1) * (1 + (rand() - 0.5) * noise)
  return { k: 'order', p: Math.round(price), q: 4, at: new Date(NOW - (i % 4) * 60 * 86_400_000).toISOString(), name: 'King bed', dims, material: teak ? 'Teak wood' : 'Mango wood', finish: 'PU', client_type: null }
})

describe('the echo guard: a price set with Use', () => {
  test('the tag is written, replaced, read, and only counts while the price is unchanged', () => {
    assert.equal(withUsedTag('', 4790.4), '[Used suggestion 4790]')
    assert.equal(withUsedTag('Darker [Used suggestion 4000] [Taught case #3]', 4790), 'Darker [Taught case #3] [Used suggestion 4790]')
    assert.equal(usedPrice('Darker [Used suggestion 4790]'), 4790); assert.equal(usedPrice('Darker'), null)
    assert.equal(isEcho('[Used suggestion 4790]', 4790), true)
    assert.equal(isEcho('[Used suggestion 4790]', 5200), false)
    assert.equal(isEcho('Typed by hand', 4790), false); assert.equal(isEcho('[Used suggestion 4790]', null), false)
  })
  test('the quotation line writes the tag when Use sets the price', () => {
    const src = readFileSync('src/components/quotations/ProductLine.tsx', 'utf8')
    assert.match(src, /onUse=\{p => onChange\(\{ unit_price: Math\.round\(p\), internal_note: withUsedTag\(l\.internal_note, Math\.round\(p\)\) \}\)\}/)
  })
})

describe('how accurate is it: an exam on prices the model never saw', () => {
  test('a type learned from a clear rule is priced close; the miss is the median over five blind rounds', () => {
    const r = examine(beds(40), NOW)
    const bed = r.types.find(t => t.type === 'bed')!
    assert.equal(bed.prices, 40); assert.equal(bed.tested, 40); assert.equal(bed.quoted, 0)
    assert.ok(bed.miss! < 5, `bed miss ${bed.miss}%`)
    assert.ok(bed.close! >= 95)
    assert.equal(r.overall.tested, 40)
  })
  test('a type with too few prices is not tested and goes to Teach next first when it is quoted', () => {
    const chairs: ModelPoint[] = [3000, 3400, 2900].map((p, i) => ({ k: 'quote', p, q: 10, at: new Date(NOW).toISOString(), name: `Cafe chair ${i}`, dims: null, material: 'Mango', finish: null, client_type: null }))
    const r = examine([...beds(30), ...chairs], NOW)
    const chair = r.types.find(t => t.type === 'chair')!
    assert.equal(chair.miss, null); assert.equal(chair.tested, 0); assert.equal(chair.quoted, 3)
    assert.equal(r.teachNext[0].type, 'chair'); assert.match(r.teachNext[0].why, /only 3 prices: too few to learn from/)
  })
  test('lost quotations are never examined or learned; a name with no product type is counted apart', () => {
    const lost: ModelPoint = { k: 'lost', p: 99999, q: 1, at: new Date(NOW).toISOString(), name: 'King bed', dims: '72 x 78', material: 'Teak', finish: null, client_type: null }
    const odd: ModelPoint = { k: 'order', p: 500, q: 1, at: new Date(NOW).toISOString(), name: 'Something else', dims: null, material: null, finish: null, client_type: null }
    const r = examine([...beds(20), lost, odd], NOW)
    assert.equal(r.types.find(t => t.type === 'bed')!.prices, 20); assert.equal(r.untyped, 1)
  })
  test('the noise floor: how much the same product\'s own prices vary', () => {
    const same = (p: number): ModelPoint => ({ k: 'order', p, q: 1, at: new Date(NOW).toISOString(), name: 'Teak bench', dims: null, material: null, finish: null, client_type: null })
    const r = examine([same(10000), same(12000), same(11000), same(20000), same(20000)], NOW)
    assert.equal(r.floor.products, 1); assert.ok(r.floor.spread! > 20 && r.floor.spread! < 40, String(r.floor.spread))
    assert.deepEqual(examine([], NOW).overall, { tested: 0, miss: null, close: null })
  })
  test('every product type is asked for, 40 words at a time', () => {
    const groups = allTypeWords()
    assert.ok(groups.length >= 2); assert.ok(groups.every(g => g.length <= 40 && g.length > 0))
    for (const w of ['bed', 'chair', 'table', 'sofa', 'lamp', 'wardrobe']) assert.ok(groups.flat().includes(w), w)
  })
})
