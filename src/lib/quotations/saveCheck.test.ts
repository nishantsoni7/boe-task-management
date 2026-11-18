// A save that would fail says which room type or product is the problem (practicality review, 18 Nov 2026).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { saveProblem } from './saveCheck'
import type { QuoteArea, QuoteLine } from './math'

const area = (key: string, name: string, multiplier = 10): QuoteArea => ({ key, name, style: '', multiplier, unit_label: 'rooms' })
const line = (key: string, area_key: string | null, p: Partial<QuoteLine> = {}): QuoteLine => ({
  key, area_key, name: 'Chair', size_text: '', spec: '', material: '', finish: '', category: '',
  qty_mode: area_key ? 'per_unit' : 'fixed', qty: 1, unit_price: 1000, tax_rate: 18, image_path: null, is_optional: false,
  client_note: '', internal_note: '', ...p,
})

describe('saveProblem', () => {
  test('a quotation that can be saved has no problem', () => {
    assert.equal(saveProblem([area('a', 'Deluxe')], [line('1', 'a'), line('2', null)]), null)
  })
  test('a product is named by its name and room type, and the message carries its key', () => {
    assert.deepEqual(saveProblem([area('a', 'Deluxe')], [line('1', 'a', { name: 'Bed', qty: 0 })]),
      { text: '"Bed" in Deluxe: needs a quantity above 0.', lineKey: '1' })
  })
  test('an unnamed product is counted within its room type, in page order', () => {
    const areas = [area('a', 'Deluxe'), area('b', 'Suite')]
    const lines = [line('s1', 'b'), line('d1', 'a'), line('d2', 'a', { name: ' ' }), line('x', null, { name: '' })]
    assert.deepEqual(saveProblem(areas, lines), { text: 'Product 2 in Deluxe: needs a name.', lineKey: 'd2' })
    assert.deepEqual(saveProblem([], [line('x1', null), line('x2', null, { name: '' })]), { text: 'Product 2 (no room type): needs a name.', lineKey: 'x2' })
  })
  test("the database's limits, said in words", () => {
    const one = (p: Partial<QuoteLine>, mode?: QuoteLine['qty_mode']) => saveProblem([area('a', 'Deluxe')], [line('1', 'a', { ...p, ...(mode ? { qty_mode: mode } : {}) })])?.text
    assert.equal(one({ name: 'x'.repeat(161) }), `"${'x'.repeat(161)}" in Deluxe: the name is longer than 160 characters.`)
    assert.equal(one({ size_text: '1'.repeat(81) }), '"Chair" in Deluxe: the dimensions are longer than 80 characters.')
    assert.equal(one({ spec: 'r'.repeat(1601) }), '"Chair" in Deluxe: the remarks are longer than 1,600 characters.')
    assert.equal(one({ material: 'm'.repeat(121) }), '"Chair" in Deluxe: the material is longer than 120 characters.')
    assert.equal(one({ qty: 100001 }), '"Chair" in Deluxe: the quantity can be at most 1,00,000.')
    assert.equal(one({ qty: 100001 }, 'fixed'), undefined)
    assert.equal(one({ qty: 1000001 }, 'fixed'), '"Chair" in Deluxe: the quantity can be at most 10,00,000.')
    assert.equal(one({ unit_price: 100_000_000_001 }), '"Chair" in Deluxe: the price is not a valid amount.')
    assert.equal(one({ unit_price: null }), undefined, 'no price yet still saves')
  })
  test('room types first: a missing name, a long name, a room count out of range', () => {
    assert.deepEqual(saveProblem([area('a', ' ')], []), { text: 'Room type 1 needs a name.' })
    assert.deepEqual(saveProblem([area('a', 'Deluxe', 0)], []), { text: 'Room type "Deluxe" needs between 1 and 1,00,000 rooms.' })
  })
  test('the builder uses it and brings the product into view', () => {
    const builder = readFileSync('src/components/quotations/BuilderScreen.tsx', 'utf8')
    const row = readFileSync('src/components/quotations/ProductLine.tsx', 'utf8')
    assert.match(builder, /const onLine = problem \? null : saveProblem\(areas, lines\)/)
    assert.match(builder, /document\.getElementById\(`line-\$\{onLine\.lineKey\}`\)\?\.scrollIntoView/)
    assert.match(row, /<div className=\{s\.pl\} id=\{`line-\$\{l\.key\}`\}>/)
  })
})
