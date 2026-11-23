// The quotation → PI workbook round trip, through the REAL PI reader (the same parser process-draft runs on the
// server). Prices are the real Resort Shamshabad quote (QT-MVTPTT9W, also pinned in math.test.ts); names and
// pictures are invented, as the PI parser's own tests require.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBoePiWorkbook } from '@/lib/pi/masterSheetParser'
import { COST_SHEET_NAME } from '@/lib/pi/fabricFinishSheets'
import { buildPiWorkbook, conversionProblems, extraPathsOf, fabricWords, finishWords, fitExtras, PI_COST_SHEET, piFigures, PI_PICTURE_BUDGET_BYTES, type PiWorkbookInput } from './piWorkbook'
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

  test('a line\'s extra pictures (swatch, drawing, reference) arrive as customization pictures of THAT product, nine across two lines too', async () => {
    const refs = (k: string, count: number) => Array.from({ length: count }, (_, j) => ({ path: `u/${k}-ref${j}.jpg`, kind: 'swatch' as const }))
    const lines = [L({}), L({ references: refs('a', 2) }), L({}), L({ references: refs('b', 8) })]
    const i = input(lines)
    const pictures = new Map(i.pictures)
    lines.forEach((l, k) => (l.references ?? []).forEach((r, j) => pictures.set(r.path, fakeJpeg(100 + k * 10 + j))))
    const res = await parse({ ...i, pictures })
    assert.deepEqual(res.blockingIssues.map(x => x.code), [])
    assert.equal(res.data.representativeImages.length, 4, 'the main pictures are untouched')
    const byRow = new Map<number, number>()
    for (const c of res.data.customizationImages) byRow.set(c.row, (byRow.get(c.row) ?? 0) + 1)
    assert.deepEqual([...byRow.entries()].sort((a, b) => a[0] - b[0]), [[33, 2], [35, 8]], 'rows 33 and 35 are products 2 and 4')
    assert.ok(res.data.customizationImages.every(c => c.format === 'jpeg'))
  })

  test('an extra picture that was not loaded (or left out) is simply not on the PI; the PI still reads', async () => {
    const lines = [L({ references: [{ path: 'u/missing.jpg', kind: 'drawing' }] })]
    const res = await parse(input(lines))
    assert.deepEqual(res.blockingIssues.map(x => x.code), [])
    assert.equal(res.data.customizationImages.length, 0)
  })

  test('extras fit the 10 MB PI: main pictures always, extras in product order while they fit, the rest counted', () => {
    const extras = [{ path: 'a', bytes: 3 }, { path: 'b', bytes: 5 }, { path: 'c', bytes: 2 }]
    assert.deepEqual([...fitExtras(4, extras, 10).keep], ['a', 'c'])
    assert.equal(fitExtras(4, extras, 10).leftOut, 1)
    assert.equal(fitExtras(20, extras, 10).leftOut, 3, 'main pictures alone over the budget: no extras')
    assert.equal(PI_PICTURE_BUDGET_BYTES < 10 * 1024 * 1024, true)
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

describe('fabric, finish and packing on the PI (the costing page, PR 3)', () => {
  const fab = (name: string, source: 'catalog' | 'client' | 'code' = 'catalog', code = '') => ({ source, status: 'to_confirm' as const, name, code })
  const costed = () => [
    L({ area_key: 'a', qty_mode: 'fixed', qty: 3, unit_price: 22300, choices: { fabric: fab('Berlin velvet', 'catalog', 'F18'), finish: { source: 'catalog', status: 'to_confirm', code: 'W-04' } }, costing: { fabric: { metres: 1.6, rate: 850 }, packing: { type: 'Carton with foam corners', per_piece: 650 } } }),
    L({ area_key: 'a', qty_mode: 'fixed', qty: 1, unit_price: 10400, costing: { packing: { type: 'Carton', per_piece: 400 } } }),
    L({ area_key: 'a', qty_mode: 'fixed', qty: 2, unit_price: 18500 }),
  ]
  const money = { gst_mode: 'igst' as const, discount_pct: 0, fabric_amount: 4080, packing_amount: 2350 }

  test('Orders reads the per-product fabric and packing back from the sheet beside the Master, and the two footer totals still add up', async () => {
    const r = await parse(input(costed(), { money }))
    assert.equal(r.data.fabricFinish!.cost.found, true)
    const cost = r.data.fabricFinish!.cost.lines
    assert.equal(cost.length, 3)
    assert.deepEqual(cost.map(c => [c.quantity, c.fabricMetresPerPiece, c.fabricPricePerMetre, c.packingCostPerPiece, c.packingType]),
      [[3, 1.6, 850, 650, 'Carton with foam corners'], [1, null, null, 400, 'Carton'], [2, null, null, null, null]])
    assert.equal(r.data.fabricFinish!.finish.found, false, 'finish is not priced, and its sheet is not written here')
  })
  test('no costing, no side sheet: the workbook is as before', async () => {
    const r = await parse(input([L({}), L({})]))
    assert.equal(r.data.fabricFinish!.cost.found, false)
  })
  test('the sheet name and headings are the ones the reader looks for', () => {
    assert.equal(PI_COST_SHEET, COST_SHEET_NAME)
  })
  test('the Customization names the fabric and the finish code; the finish code beats the old free-text finish', () => {
    const [a, b] = costed()
    assert.equal(fabricWords(a), 'Fabric: Berlin velvet (F18)')
    assert.equal(finishWords(a), 'Finish: W-04')
    assert.equal(finishWords(b), 'Finish: Walnut', 'the old finish text still counts when no code was chosen')
    assert.equal(fabricWords(L({ choices: { fabric: fab('Own linen', 'client') } })), 'Fabric: Own linen, client’s own')
    assert.equal(fabricWords(L({ choices: { fabric: fab('', 'code', 'F-2210') } })), 'Fabric: (F-2210), client’s code, we source it')
    assert.equal(fabricWords(L({})), '')
  })
  test('the swatch photos of the fabric and the finish go on the PI as extra pictures of that row, once each', () => {
    const l = L({ references: [{ path: 'u/ref.jpg', kind: 'reference' }], choices: { fabric: { source: 'catalog', status: 'to_confirm', name: 'V', photo: 'u/fab.jpg' }, finish: { source: 'catalog', status: 'to_confirm', code: 'W', photo: 'u/ref.jpg' } } })
    assert.deepEqual(extraPathsOf(l), ['u/ref.jpg', 'u/fab.jpg'])
    assert.deepEqual(extraPathsOf(L({})), [])
  })
})
