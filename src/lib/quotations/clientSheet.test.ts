/**
 * The plain Excel of a quotation for the client ("Download Excel" in the Share card, owner, 13 Nov 2026).
 * Run: npm run test:file -- src/lib/quotations/clientSheet.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_SHEET_COLUMNS, clientSheet, clientSheetFileName, type ClientSheetHead } from './clientSheet'
import { computeTotals, type QuoteArea, type QuoteLine, type QuoteMoney } from './math'

const area = (over: Partial<QuoteArea> = {}): QuoteArea => ({ key: 'a', name: 'Boho room', style: 'Boho', multiplier: 56, unit_label: 'rooms', ...over })
const line = (over: Partial<QuoteLine> = {}): QuoteLine => ({
  key: 'l1', area_key: 'a', name: 'Bed', size_text: '83 × 68 × 18', spec: 'Walnut headboard', material: 'Ash wood', finish: 'NEVER-IN-THE-SHEET', category: '',
  qty_mode: 'per_unit', qty: 1, unit_price: 56000, tax_rate: 18, image_path: 'u/p.jpg', is_optional: false, client_note: 'Delivered assembled',
  internal_note: 'NEVER-IN-THE-SHEET-INTERNAL', ...over,
})
const money = (over: Partial<QuoteMoney> = {}): QuoteMoney => ({ gst_mode: 'igst', discount_pct: 0, fabric_amount: 0, packing_amount: 0, ...over })
const head = (over: Partial<ClientSheetHead> = {}): ClientSheetHead => ({
  quoteNo: 'QT-NS-01006', clientName: 'Babylon Resort', projectName: 'Resort, Shamshabad', issuedOn: '12 Nov 2026', validUntilOn: '19 Nov 2026', unit: 'in',
  transportNote: '', notes: 'Prices are ex-factory.', ...over,
})
const all = (rows: unknown[][]) => JSON.stringify(rows)
const headerRowIndex = (rows: unknown[][]) => rows.findIndex(r => r[0] === 'Room type')
const productRows = (rows: unknown[][]) => rows.slice(headerRowIndex(rows) + 1).filter(r => typeof r[1] === 'string' && r[0] !== undefined && r[8] !== null && r[7] !== null && typeof r[5] === 'number')
const totalRow = (rows: unknown[][], label: string) => rows.find(r => r[7] === label)

describe('the client Excel: what is in it', () => {
  test('the columns, the size unit in its heading, and the details above them', () => {
    const { rows, name } = clientSheet(head(), money(), [area()], [line()])
    assert.equal(name, 'Quotation')
    assert.deepEqual(rows[headerRowIndex(rows)], CLIENT_SHEET_COLUMNS.map((c, i) => (i === 2 ? 'Size (in)' : c)))
    assert.deepEqual(rows.slice(0, 5), [['Quotation', 'QT-NS-01006'], ['Prepared for', 'Babylon Resort'], ['Project', 'Resort, Shamshabad'], ['Date', '12 Nov 2026'], ['Valid until', '19 Nov 2026']])
    assert.equal(clientSheet(head({ unit: 'cm' }), money(), [area()], [line()]).rows[headerRowIndex(rows)][2], 'Size (cm)')
  })
  test('a product row reads like the printed quotation: room type, name, size, material, remarks with the client note, quantity, rate, GST, amount', () => {
    const { rows } = clientSheet(head(), money(), [area()], [line()])
    assert.deepEqual(productRows(rows)[0], ['Boho room · Boho × 56 rooms', 'Bed', '83 × 68 × 18', 'Ash wood', 'Walnut headboard · Delivered assembled', 56, 56000, 18, 56 * 56000])
  })
  test('never the Finish, the internal note, a picture path, or a phone or e-mail', () => {
    const sheet = all(clientSheet(head(), money(), [area()], [line()]).rows)
    for (const secret of ['NEVER-IN-THE-SHEET', 'u/p.jpg', 'finish', 'Finish']) assert.ok(!sheet.includes(secret), secret)
    const keys = Object.keys(head())
    assert.ok(!keys.some(k => /phone|email|internal/i.test(k)), 'the sheet is not even given a contact or an internal note')
  })
  test('products with no room type come last; optional ones are named so and stay out of the total', () => {
    const lines = [line({ key: 'x', area_key: null, name: 'Loose chair', unit_price: 1000, qty_mode: 'fixed', qty: 3 }), line({ key: 'o', name: 'Mirror', is_optional: true, unit_price: 5000, qty_mode: 'fixed', qty: 1 }), line()]
    const { rows } = clientSheet(head(), money(), [area()], lines)
    assert.deepEqual(productRows(rows).map(r => r[1]), ['Mirror (optional, not in the total)', 'Bed', 'Loose chair'], 'room type by room type in the order given, the products without a room type last')
    assert.equal(totalRow(rows, 'Subtotal')?.[8], 56 * 56000 + 3000, 'the optional mirror is not counted')
  })
})

describe('the client Excel: the totals are the builder\'s totals', () => {
  const areas = [area()]
  const lines = [line(), line({ key: 'm', name: 'Mirror', qty_mode: 'fixed', qty: 2, unit_price: 5000, tax_rate: 12 })]
  test('every total equals computeTotals: subtotal, discount, fabric and packing, taxable value, GST and the grand total', () => {
    const m = money({ discount_pct: 5, fabric_amount: 120000, packing_amount: 30000 })
    const t = computeTotals(m, areas, lines)
    const { rows } = clientSheet(head(), m, areas, lines)
    assert.equal(totalRow(rows, 'Subtotal')?.[8], t.subtotal)
    assert.equal(totalRow(rows, 'Discount (5%)')?.[8], -t.discount)
    assert.equal(totalRow(rows, 'Fabric')?.[8], 120000)
    assert.equal(totalRow(rows, 'Packing')?.[8], 30000)
    assert.equal(totalRow(rows, 'Taxable value')?.[8], t.taxable)
    assert.equal(totalRow(rows, 'Total including GST')?.[8], t.grand)
    const igst = rows.filter(r => typeof r[7] === 'string' && (r[7] as string).startsWith('IGST')).reduce((s, r) => s + (r[8] as number), 0)
    assert.equal(igst, t.gstTotal)
    assert.equal(productRows(rows).reduce((s, r) => s + (r[8] as number), 0), t.subtotal, 'the product amounts add up to the subtotal')
  })
  test('within Rajasthan the GST is split into CGST and SGST, outside it is IGST', () => {
    const inState = clientSheet(head(), money({ gst_mode: 'cgst_sgst' }), areas, lines).rows
    assert.ok(totalRow(inState, 'CGST 9%') && totalRow(inState, 'SGST 9%') && totalRow(inState, 'CGST 6%'))
    assert.ok(!inState.some(r => typeof r[7] === 'string' && (r[7] as string).startsWith('IGST')))
    const outside = clientSheet(head(), money(), areas, lines).rows
    assert.ok(totalRow(outside, 'IGST 18%') && totalRow(outside, 'IGST 12%'))
  })
  test('no discount, fabric or packing row when there is none; transport and the client notes come last, internal notes never', () => {
    const plain = clientSheet(head(), money(), areas, lines).rows
    for (const l of ['Fabric', 'Packing']) assert.equal(totalRow(plain, l), undefined, l)
    assert.ok(!plain.some(r => typeof r[7] === 'string' && (r[7] as string).startsWith('Discount')))
    const withExtras = clientSheet(head({ transportNote: 'As per actual' }), money(), areas, lines).rows
    assert.deepEqual(withExtras.slice(-4), [[], ['Transport', 'As per actual'], [], ['Notes', 'Prices are ex-factory.']])
  })
})

describe('the file name', () => {
  test('is the quotation number plus the word quotation, safe for any file system', () => {
    assert.equal(clientSheetFileName('QT-NS-01006'), 'QT-NS-01006 quotation.xlsx')
    assert.equal(clientSheetFileName('  QT/NS:01 006 '), 'QT-NS-01-006 quotation.xlsx')
    assert.equal(clientSheetFileName('///'), 'quotation quotation.xlsx')
  })
})
