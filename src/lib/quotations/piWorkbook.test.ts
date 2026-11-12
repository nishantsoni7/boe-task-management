// The quotation → PI workbook round trip, through the REAL PI reader (the same parser process-draft runs on the
// server). Prices are the real Resort Shamshabad quote (QT-MVTPTT9W, also pinned in math.test.ts); names and
// pictures are invented, as the PI parser's own tests require.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBoePiWorkbook } from '@/lib/pi/masterSheetParser'
import { buildPiWorkbook, conversionProblems, piFigures, type PiWorkbookInput } from './piWorkbook'
import type { QuoteArea, QuoteLine } from './math'

const areas: QuoteArea[] = [
  { key: 'a', name: 'Corporate room', style: 'Contemporary', multiplier: 18, unit_label: 'rooms' },
  { key: 'b', name: 'Boho room', style: 'Boho', multiplier: 56, unit_label: 'rooms' },
]
let n = 0
const L = (over: Partial<QuoteLine>): QuoteLine => {
  n += 1
  return {
    key: `k${n}`, area_key: 'a', name: `Sample product ${n}`, size_text: `6'0" x 6'6"`, spec: '', material: 'Sheesham wood', finish: 'Walnut',
    category: '', qty_mode: 'per_unit', qty: 1, unit_price: 1000, tax_rate: 18, image_path: `u/${n}.jpg`, is_optional: false,
    client_note: '', internal_note: '', ...over,
  }
}
const REAL: QuoteLine[] = [
  L({ area_key: 'a', unit_price: 64000 }), L({ area_key: 'a', unit_price: 10800 }), L({ area_key: 'a', unit_price: 18000 }),
  L({ area_key: 'a', unit_price: 8200 }), L({ area_key: 'a', unit_price: 46000 }), L({ area_key: 'a', unit_price: 14500 }),
  L({ area_key: 'a', unit_price: 102000 }),
  L({ area_key: 'b', unit_price: 56000 }), L({ area_key: 'b', qty: 2, unit_price: 11900 }), L({ area_key: 'b', unit_price: 21000 }),
  L({ area_key: 'b', unit_price: 7800 }), L({ area_key: 'b', unit_price: 43000 }), L({ area_key: 'b', unit_price: 15000 }),
  L({ area_key: 'b', qty_mode: 'fixed', qty: 39, unit_price: 96000 }), L({ area_key: 'b', unit_price: 23200 }), L({ area_key: 'b', unit_price: 19000 }),
]

/** Invented JPEG bytes: a real signature, then a deterministic fill, different per picture. */
function fakeJpeg(seed: number): Uint8Array {
  const b = new Uint8Array(256)
  b.set([0xff, 0xd8, 0xff, 0xe0], 0)
  let x = seed
  for (let i = 4; i < b.length; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; b[i] = x & 0xff }
  return b
}

function input(lines: QuoteLine[], over: Partial<PiWorkbookInput> = {}): PiWorkbookInput {
  const pictures = new Map<string, Uint8Array>()
  lines.forEach((l, i) => { if (l.image_path) pictures.set(l.image_path, fakeJpeg(i + 1)) })
  return {
    quoteNo: 'QT-NS-01001', clientName: 'Example Resort Pvt Ltd', projectName: 'Example Resort, Phase 1', contactPhone: '9000000002',
    supplyState: 'Telangana', createdByName: 'Sample Salesperson', transportNote: null,
    money: { gst_mode: 'igst', discount_pct: 0, fabric_amount: 0, packing_amount: 0 }, areas, lines, pictures,
    today: new Date(Date.UTC(2026, 10, 12)), ...over,
  }
}

async function parse(i: PiWorkbookInput) {
  const result = await parseBoePiWorkbook(await buildPiWorkbook(i))
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.errors))
  if (!result.ok) throw new Error('unreachable')
  return result
}

describe('quotation → PI workbook, read back by the real PI parser', () => {
  test('the real Shamshabad quote: 16 products, quantities × rooms, prices and totals to the rupee, no blocking issue', async () => {
    const res = await parse(input(REAL))
    assert.deepEqual(res.blockingIssues.map(i => i.code), [])
    assert.equal(res.data.products.length, 16)
    assert.deepEqual(res.data.products.map(i => i.quantity), [18, 18, 18, 18, 18, 18, 18, 56, 112, 56, 56, 56, 56, 39, 56, 56])
    assert.deepEqual(res.data.products.map(i => i.costPerPiece), REAL.map(l => l.unit_price))
    assert.equal(res.data.products[0].productName, 'Corporate room · Sample product 1')
    assert.equal(res.data.products[0].material, 'Sheesham wood')
    assert.equal(res.data.representativeImages.length, 16, 'every product has its picture')
    assert.equal(res.data.commercial.subtotalAfterDiscount.amount, 20179800)
    assert.equal(res.data.commercial.totalBeforeGst.amount, 20179800)
    assert.equal(res.data.commercial.gst.amount, 3632364)
    assert.equal(res.data.commercial.grandTotal.amount, 23812164)
  })

  test('discount, fabric, packing and transport land in the footer and still add up', async () => {
    const lines = [L({ qty_mode: 'fixed', qty: 10, unit_price: 10000 }), L({ qty_mode: 'fixed', qty: 5, unit_price: 2000 })]
    const res = await parse(input(lines, {
      money: { gst_mode: 'igst', discount_pct: 10, fabric_amount: 5000, packing_amount: 3000 }, transportNote: 'Extra at actuals',
    }))
    assert.deepEqual(res.blockingIssues.map(i => i.code), [])
    assert.equal(res.data.commercial.discount, 11000)
    assert.equal(res.data.commercial.subtotalAfterDiscount.amount, 99000)
    assert.equal(res.data.commercial.totalBeforeGst.amount, 107000)
    assert.equal(res.data.commercial.gst.amount, 19260)
    assert.equal(res.data.commercial.grandTotal.amount, 126260)
  })

  test('optional lines stay off the PI; more than 80 products move the footer and still read', async () => {
    const many = Array.from({ length: 85 }, () => L({ qty_mode: 'fixed', qty: 2, unit_price: 500 }))
    many.push(L({ is_optional: true, unit_price: 99999 }))
    const res = await parse(input(many))
    assert.deepEqual(res.blockingIssues.map(i => i.code), [])
    assert.equal(res.data.products.length, 85)
    assert.equal(res.data.commercial.grandTotal.amount, 85 * 1000 * 1.18)
  })

  test('mixed GST rates give one GST figure that is each rate on its own lines', () => {
    const f = piFigures({ money: { gst_mode: 'igst', discount_pct: 0, fabric_amount: 0, packing_amount: 0 }, areas, lines: [
      L({ qty_mode: 'fixed', qty: 1, unit_price: 10000, tax_rate: 18 }), L({ qty_mode: 'fixed', qty: 1, unit_price: 10000, tax_rate: 12 }),
    ] })
    assert.equal(f.gstRate, null)
    assert.equal(f.gst, 3000)
    assert.equal(f.grandTotal, 23000)
  })

  test('what blocks a conversion is named, line by line', () => {
    assert.deepEqual(conversionProblems(areas, []), [{ code: 'NO_LINES', lines: [] }])
    assert.deepEqual(conversionProblems(areas, [L({ is_optional: true })]), [{ code: 'NO_LINES', lines: [] }])
    const probs = conversionProblems(areas, [
      L({ name: 'Bed', unit_price: 0 }), L({ name: 'Chair', image_path: null }), L({ name: 'Lamp', qty: 0 }), L({ name: '' }),
    ])
    assert.deepEqual(probs, [
      { code: 'NAME_MISSING', lines: ['Product 4'] },
      { code: 'QTY_MISSING', lines: ['Lamp'] },
      { code: 'PRICE_MISSING', lines: ['Bed'] },
      { code: 'PICTURE_MISSING', lines: ['Chair'] },
    ])
  })
})
