import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ROUNDED_CORNER_LOSS, SWG, partWeight, section, type MetalPart } from './metal'
import { cutList, cuFt } from './wood'

const near = (got: number, want: number, tol = 0.001) => assert.ok(Math.abs(got - want) <= tol, `got ${got}, want ${want}`)
const part = (p: Partial<MetalPart>): MetalPart => ({ profile: 'sqtube', a: 25, b: null, t: 1.6, unit: 'mm', gauge: null, corners: 'round', length: 1, lengthUnit: 'm', qty: 1, ...p })
const kgm = (p: Partial<MetalPart>, density = 7850) => { const w = partWeight(part(p), density); if ('error' in w) throw new Error(w.error); return w.per }

describe('metal weight, as maiak-m.bg works it out (steel, 7.85)', () => {
  test('its rounded-corner constant is the one this code uses', () => {
    // maiak-m.bg: kg/m = t × (0.0314 × a − 0.044877 × t) for a square tube; 0.044877 = 0.0314 + loss × 0.00785
    near(0.0314 + ROUNDED_CORNER_LOSS * 0.00785, 0.044877, 0.000001)
  })
  test('square and rectangular tubes, rounded corners', () => {
    near(kgm({ profile: 'sqtube', a: 40, t: 2 }), 2 * (0.0314 * 40 - 0.044877 * 2))      // 2.3325
    near(kgm({ profile: 'sqtube', a: 25, t: 1.6 }), 1.6 * (0.0314 * 25 - 0.044877 * 1.6))  // 1.1411
    near(kgm({ profile: 'recttube', a: 60, b: 40, t: 2 }), 2 * (0.0157 * 100 - 0.044877 * 2)) // 2.9605
  })
  test('pipe, round bar, square bar, flat and sheet', () => {
    near(kgm({ profile: 'pipe', a: 48.3, t: 3.2 }), Math.PI * 0.00785 * 3.2 * 45.1)       // maiak-m.bg's 3.14 gives 3.5573
    near(kgm({ profile: 'rbar', a: 10, t: null }), 0.0061654 * 100, 0.0001)
    near(kgm({ profile: 'sbar', a: 12, t: null }), 0.00785 * 144)
    near(kgm({ profile: 'flat', a: 25, t: 5 }), 0.00785 * 125)
    const sheet = partWeight(part({ profile: 'sheet', a: 1000, b: 2000, t: 2 }), 7850)
    assert.ok(!('error' in sheet)); near(sheet.kgEach, 31.4); near(sheet.per, 15.7); assert.equal(sheet.perUnit, 'kg/m²')
  })
  test('a wall of half the size or more is refused, the way the site shows its error', () => {
    const w = partWeight(part({ profile: 'sqtube', a: 25, t: 16 }), 7850)
    assert.ok('error' in w); assert.match(w.error, /16 typed for 1\.6/)
    assert.equal(section('pipe', 20, 20, 10), null)
  })
})

describe('metal weight, as galaluminium.in works it out', () => {
  test('square tubing with sharp corners: (outer² − inner²) × length × density', () => {
    near(kgm({ profile: 'sqtube', a: 40, t: 2, corners: 'sharp' }), (40 * 40 - 36 * 36) * 7850 / 1e6)
  })
  test('other metals, inches, hexagon, ring', () => {
    near(kgm({ profile: 'rbar', a: 1, unit: 'in', t: null }, 2700), Math.PI / 4 * 25.4 * 25.4 * 2700 / 1e6) // 1.3681
    near(kgm({ profile: 'hex', a: 20, t: null }), 0.866 * 400 * 7850 / 1e6)
    const ring = partWeight(part({ profile: 'ring', a: 100, b: 60, t: 10 }), 7850)
    assert.ok(!('error' in ring)); near(ring.kgEach, Math.PI * (10000 - 3600) / 4 * 10 * 7850 / 1e9)
    assert.ok('error' in partWeight(part({ profile: 'ring', a: 60, b: 100, t: 10 }), 7850))
  })
})

describe('lengths, pieces, gauges and surface', () => {
  test('length in feet and pieces multiply; an 18 gauge wall is 1.219 mm', () => {
    const w = partWeight(part({ profile: 'pipe', a: 19.05, t: null, gauge: 18, length: 2.5, lengthUnit: 'ft', qty: 4 }), 7850)
    assert.ok(!('error' in w))
    near(w.per, Math.PI * SWG[18] * (19.05 - SWG[18]) * 7850 / 1e6)
    near(w.kg, w.per * 2.5 * 0.3048 * 4)
    near(w.sqft, Math.PI * 19.05 / 1000 * 2.5 * 0.3048 * 4 * 10.7639)
    assert.ok('error' in partWeight(part({ gauge: 9 }), 7850))
    assert.ok('error' in partWeight(part({ length: null }), 7850))
  })
})

describe('wood from a cut list', () => {
  test('cu ft = pieces × length × width × thickness ÷ 1,728, and the waste is added on top', () => {
    near(cuFt({ qty: 2, length: 36, width: 3, thick: 2 }), 0.25)
    const r = cutList([{ qty: 2, length: 36, width: 3, thick: 2 }, { qty: 2, length: 18, width: 2, thick: 2 }, { qty: 4, length: 18, width: 3, thick: 1 },
      { qty: 2, length: 16, width: 3, thick: 1 }, { qty: 3, length: 16, width: 1.5, thick: 1 }], 30)
    near(r.net, 0.5556, 0.0001); near(r.gross, 0.7222, 0.0001)
    assert.equal(cuFt({ qty: 2, length: 36, width: 0, thick: 2 }), 0)
  })
})
