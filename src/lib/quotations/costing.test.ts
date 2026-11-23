/**
 * Fabric and packing priced per piece and multiplied by the product's quantity (owner, 21 Nov 2026; 20270819000000).
 *
 * Run: npm run test:file -- src/lib/quotations/costing.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanCosting, computeTotals, costWaitingText, costingSums, costingViewOf, costingWords, fabricInUse, lineCost, type LineChoice, type QuoteArea, type QuoteLine } from './math'

const areas: QuoteArea[] = [{ key: 'a', name: 'Lobby lounge', style: '', multiplier: 10, unit_label: 'rooms' }]
const line = (over: Partial<QuoteLine> = {}): QuoteLine => ({
  key: 'l1', area_key: null, name: 'Rocking chair', size_text: '', spec: '', material: '', finish: '', category: '',
  qty_mode: 'fixed', qty: 3, unit_price: 22300, tax_rate: 18, image_path: null, is_optional: false, client_note: '', internal_note: '', ...over,
})
const fabric = (source: LineChoice['source'], name = 'Berlin velvet', code = ''): QuoteLine['choices'] => ({ fabric: { source, status: 'to_confirm', name, code } })

describe('one product: price per piece × quantity', () => {
  test('packing: ₹650 per piece on 3 chairs is ₹1,950', () => {
    const c = lineCost(line({ costing: { packing: { type: 'Carton with foam corners', per_piece: 650 } } }), 3)
    assert.deepEqual(c.packing, { state: 'ok', per: 650, total: 1950, priced: true })
    assert.deepEqual([c.per, c.total], [650, 1950])
  })
  test('fabric: metres per piece × rate per metre gives the price per piece, then × quantity', () => {
    const c = lineCost(line({ choices: fabric('catalog'), costing: { fabric: { metres: 1.6, rate: 850 } } }), 3)
    assert.deepEqual(c.fabric, { state: 'ok', per: 1360, total: 4080, priced: true })
  })
  test('the quantity is the product\'s total quantity, so a per-room quantity counts every room', () => {
    const l = line({ qty_mode: 'per_unit', qty: 2, area_key: 'a', choices: fabric('catalog'), costing: { fabric: { metres: 1.5, rate: 800 }, packing: { per_piece: 500 } } })
    const sums = costingSums(areas, [l])
    assert.deepEqual([sums.fabric, sums.packing], [20 * 1200, 20 * 500], '2 per room × 10 rooms = 20 pieces')
  })
  test('a fractional price per piece is kept to two decimals; the amount is rounded to a whole rupee', () => {
    const c = lineCost(line({ choices: fabric('catalog'), costing: { fabric: { metres: 1.25, rate: 333 } } }), 3)
    assert.equal(c.fabric.per, 416.25)
    assert.equal(c.fabric.total, Math.round(3 * 1.25 * 333))
  })
  test('finish has no price at all: a finish code and picture add nothing', () => {
    const l = line({ choices: { finish: { source: 'catalog', status: 'confirmed', code: 'W-04', photo: null } } })
    const c = lineCost(l, 3)
    assert.deepEqual([c.fabric.state, c.packing.state, c.per, c.total], ['none', 'none', 0, 0])
  })
})

describe('what is still waiting for a price', () => {
  test('a catalog fabric or a sourced code with no rate waits, and adds nothing yet', () => {
    for (const source of ['catalog', 'code'] as const) {
      const c = lineCost(line({ choices: fabric(source, source === 'code' ? '' : 'Velvet', source === 'code' ? 'F-2210' : '') }), 6)
      assert.deepEqual(c.fabric, { state: 'wait', per: 0, total: 0, priced: false })
    }
  })
  test('a rate with no metres per piece asks for the metres', () => {
    const c = lineCost(line({ choices: fabric('catalog'), costing: { fabric: { rate: 850 } } }), 3)
    assert.equal(c.fabric.state, 'metres')
    assert.equal(c.total, 0)
  })
  test('the client\'s own fabric is no charge until a rate is typed', () => {
    const own = lineCost(line({ choices: fabric('client', 'Own linen') }), 3)
    assert.deepEqual(own.fabric, { state: 'ok', per: 0, total: 0, priced: false })
    const charged = lineCost(line({ choices: fabric('client', 'Own linen'), costing: { fabric: { metres: 1.6, rate: 100 } } }), 3)
    assert.equal(charged.fabric.total, 480)
  })
  test('packing with a type but no price waits; a price of 0 is a price', () => {
    assert.equal(lineCost(line({ costing: { packing: { type: 'Carton' } } }), 3).packing.state, 'wait')
    assert.deepEqual(lineCost(line({ costing: { packing: { per_piece: 0 } } }), 3).packing, { state: 'ok', per: 0, total: 0, priced: true })
  })
  test('a product with nothing on it is not used', () => {
    assert.equal(fabricInUse(line()), false)
    assert.deepEqual(lineCost(line(), 3), { fabric: { state: 'none', per: 0, total: 0, priced: false }, packing: { state: 'none', per: 0, total: 0, priced: false }, per: 0, total: 0 })
  })
})

describe('the sums for the whole quotation', () => {
  const lines = [
    line({ key: 'p1', name: 'Rocking chair', qty: 3, choices: fabric('catalog'), costing: { fabric: { metres: 1.6, rate: 850 }, packing: { per_piece: 650 } } }),
    line({ key: 'p2', name: 'Side table', qty: 1, costing: { packing: { type: 'Carton', per_piece: 400 } } }),
    line({ key: 'p3', name: 'Armchair', qty: 2, choices: fabric('client', 'Own linen') }),
    line({ key: 'p4', name: 'Bar stool', qty: 6, choices: fabric('code', '', 'F-2210') }),
  ]
  test('the example of the preview: fabric ₹4,080 and packing ₹2,350, with the bar stool still to come', () => {
    const sums = costingSums([], lines)
    assert.deepEqual([sums.fabric, sums.packing, sums.any], [4080, 2350, true])
    assert.deepEqual(sums.waiting.map(costWaitingText), ['Bar stool fabric (price to come)'])
  })
  test('optional products are shown but not counted, as in the subtotal', () => {
    const sums = costingSums([], [...lines, line({ key: 'p5', is_optional: true, qty: 9, costing: { packing: { per_piece: 1000 } } })])
    assert.equal(sums.packing, 2350)
  })
  test('nothing typed means no sums replace the typed Fabric and Packing boxes', () => {
    const none = costingSums([], [line({ choices: fabric('client', 'Own linen') }), line({ key: 'x', choices: fabric('catalog') })])
    assert.equal(none.any, false, 'a client\'s own fabric at no charge and an unpriced fabric are not prices')
    assert.equal(costingSums([], [line()]).any, false)
  })
  test('the sums are what the totals add: before GST and the 18% GST follow', () => {
    const sums = costingSums([], lines)
    const t = computeTotals({ gst_mode: 'igst', discount_pct: 0, fabric_amount: sums.fabric, packing_amount: sums.packing }, [], lines.map(l => ({ ...l, unit_price: 10000 })))
    // 3 + 1 + 2 + 6 = 12 pieces at ₹10,000 = ₹1,20,000, plus ₹4,080 + ₹2,350 = ₹1,26,430; GST ₹22,757 (rounded)
    assert.equal(t.subtotal, 120000)
    assert.equal(t.taxable, 126430)
    assert.equal(t.gstTotal, Math.round(126430 * 0.18))
  })
})

describe('what a save writes (cleanCosting)', () => {
  test('only typed numbers are kept: whole rupees, metres to two decimals; an empty costing is {}', () => {
    assert.deepEqual(cleanCosting(undefined), {})
    assert.deepEqual(cleanCosting({}), {})
    assert.deepEqual(cleanCosting({ fabric: {}, packing: { type: '   ' } }), {})
    assert.deepEqual(cleanCosting({ fabric: { metres: 1.666, rate: 850.4 }, packing: { type: ' Carton ', per_piece: 649.6 } }), { fabric: { metres: 1.67, rate: 850 }, packing: { type: 'Carton', per_piece: 650 } })
  })
  test('zero is kept (a price of 0 was typed); negatives, text and infinity are not', () => {
    assert.deepEqual(cleanCosting({ fabric: { rate: 0 } }), { fabric: { rate: 0 } })
    assert.deepEqual(cleanCosting({ fabric: { rate: -5, metres: Infinity } }), {})
    assert.deepEqual(cleanCosting({ packing: { per_piece: '600' as unknown as number } }), {})
  })
  test('what the database allows is respected: a packing type of at most 80 characters, amounts of at most ₹1,00,00,000, metres below 1,000', () => {
    const c = cleanCosting({ fabric: { metres: 5000, rate: 99_999_999 }, packing: { type: 'x'.repeat(200), per_piece: 99_999_999 } })
    assert.equal(c.fabric?.metres, 999.99)
    assert.equal(c.fabric?.rate, 10_000_000)
    assert.equal(c.packing?.per_piece, 10_000_000)
    assert.equal(c.packing?.type?.length, 80)
  })
})

describe('what the client may see (costingViewOf), the twin of quotation_costing_view in the database', () => {
  const view = (over: Partial<QuoteLine>) => costingViewOf(line(over))
  test('the same cases the database test checks: per piece, no charge, waiting, fractions', () => {
    assert.deepEqual(view({ choices: fabric('catalog'), costing: { fabric: { metres: 1.6, rate: 850 }, packing: { type: 'Carton with foam corners', per_piece: 650 } } }),
      { fabric: { per: 1360 }, packing: { per: 650, type: 'Carton with foam corners' } })
    assert.deepEqual(view({ choices: fabric('client', 'Own linen'), costing: { packing: { per_piece: 0 } } }), { fabric: { free: true }, packing: { per: 0 } })
    assert.deepEqual(view({ choices: fabric('code', '', 'F-2210'), costing: { packing: { type: 'Crate' } } }), { fabric: { wait: true }, packing: { type: 'Crate', wait: true } })
    assert.deepEqual(view({ costing: { fabric: { rate: 700 } } }), { fabric: { wait: true } })
    assert.deepEqual(view({ choices: fabric('catalog', 'V'), costing: { fabric: { metres: 1.25, rate: 333 } } }), { fabric: { per: 416.25 } })
    assert.equal(view({}), undefined)
  })
  test('never carries the metres or the rate', () => {
    const s = JSON.stringify(view({ choices: fabric('catalog'), costing: { fabric: { metres: 1.6, rate: 850 }, packing: { per_piece: 650 } } }))
    assert.ok(!/metres|rate|costing/.test(s), s)
  })
  test('the words the client reads', () => {
    assert.deepEqual(costingWords({ fabric: { per: 1360 }, packing: { type: 'Carton', per: 650 } }), { fabric: '₹1,360 per piece', packing: 'Packing: Carton · ₹650 per piece' })
    assert.deepEqual(costingWords({ fabric: { free: true }, packing: { wait: true } }), { fabric: 'No charge for the fabric', packing: 'Packing · price to be confirmed' })
    assert.deepEqual(costingWords({ fabric: { wait: true } }), { fabric: 'Fabric price to be confirmed', packing: '' })
    assert.deepEqual(costingWords({ fabric: { per: 416.25 } }), { fabric: '₹416.25 per piece', packing: '' })
    assert.deepEqual(costingWords(undefined), { fabric: '', packing: '' })
  })
})
