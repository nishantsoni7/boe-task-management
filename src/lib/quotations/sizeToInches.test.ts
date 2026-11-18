// Sizes not in inches or cm become inches, rounded to the nearest 0.5 (owner, 18 Nov 2026).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { sizeToInches } from './math'
import { addToQuote } from './importBoq'
import type { ImportRow } from './importBoq'

describe('sizeToInches', () => {
  test("the owner's rule: 8.3 becomes 8.5, 8.2 becomes 8", () => {
    assert.equal(sizeToInches(`${(8.3 * 25.4).toFixed(2)} mm`), '8.5')
    assert.equal(sizeToInches(`${(8.2 * 25.4).toFixed(2)} mm`), '8')
  })
  test('millimetres, the unit written once at the end', () => {
    assert.equal(sizeToInches('2000 x 900 x 450 mm'), '78.5 × 35.5 × 17.5')
    assert.equal(sizeToInches('600mm × 600mm'), '23.5 × 23.5')
  })
  test('metres', () => {
    assert.equal(sizeToInches('1.2m x 0.6m'), '47 × 23.5')
    assert.equal(sizeToInches('2 mtr x 1 mtr'), '78.5 × 39.5')
  })
  test('feet, and feet with inches', () => {
    assert.equal(sizeToInches(`6'6" x 3'`), '78 × 36')
    assert.equal(sizeToInches('7 ft x 2 ft x 1.5 ft'), '84 × 24 × 18')
    assert.equal(sizeToInches(`6'0"×6'6"×1'6"`), '72 × 78 × 18')
  })
  test('left as typed: inches, centimetres, no unit, unreadable', () => {
    assert.equal(sizeToInches('83 x 68 x 18'), null)
    assert.equal(sizeToInches('83" x 68"'), null)
    assert.equal(sizeToInches('30x18x16 inches'), null)
    assert.equal(sizeToInches('200 x 90 cm'), null)
    assert.equal(sizeToInches('2000 x 900 cm x 450 mm'), null)
    assert.equal(sizeToInches('Dia 600mm'), null)
    assert.equal(sizeToInches(''), null)
    assert.equal(sizeToInches(null), null)
  })
})

describe('an imported line', () => {
  const row = (size: string): ImportRow => ({
    id: 'r1', include: true, name: 'Chair', size, room: '', rooms: null, qty: 1, qtyMode: 'fixed', price: 0,
    spec: '', material: '', finish: '', note: '', internalNote: '',
  } as unknown as ImportRow)
  test('a size in mm arrives in inches; a size in inches arrives as written', () => {
    assert.equal(addToQuote([row('450 x 450 x 900 mm')], []).lines[0].size_text, '17.5 × 17.5 × 35.5')
    assert.equal(addToQuote([row('18 x 18 x 36')], []).lines[0].size_text, '18 x 18 x 36')
  })
})

describe('the size box', () => {
  test('converts on leaving the box, only on an inches quotation', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/components/quotations/ProductLine.tsx', 'utf8')
    assert.match(src, /onBlur=\{\(\) => \{ const inch = unit === 'in' \? sizeToInches\(l\.size_text\) : null; if \(inch\) onChange\(\{ size_text: inch \}\) \}\}/)
  })
})
