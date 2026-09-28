/**
 * THE CLIENT PDF'S OPENING COMMERCIAL LINE — named so it cannot be read as
 * "Product value", which on every BOE screen is the amount AFTER the discount.
 *
 * With a discount the gross is printed as "Product value before discount",
 * followed by the separate Discount line and the Subtotal after discount; with
 * none it keeps "Gross product amount". Only the caption changes: the same
 * stored figures, the discount once, and the Grand Total exactly as stored.
 *
 * Offline: renders real PDF bytes from fixture rows; no database.
 *
 * Run:
 *   npx tsx --test src/lib/orders/pdfProductValueLabel.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { buildConfirmedPdfModel } from './confirmedPdf'
import { renderConfirmedPdf } from './confirmedPdfRender'
import type { OrderPiRow } from './orderPiHandoff'
import type { PersistedItem } from './draftsView'

const BASE = {
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', client_name: 'Fixture Interiors', bill_to_name: 'Fixture Interiors Pvt Ltd',
  ship_to_name: null, creation_date: '2026-07-01', source_created_by: 'R. Sharma', contact_number: null,
  bill_to_phone: null, ship_to_phone: null, billing_address: 'Plot 4, Test Estate', shipping_address: null, client_city: 'Pune',
  bill_to_gst: null, ship_to_gst: null, discount_label: 'Design Fees',
  fabric_cost: '0', fabric_cost_meaning: 'not_applicable', fabric_cost_text: null,
  packing_cost: '169960.00', packing_cost_meaning: 'numeric', packing_cost_text: null,
  transportation_amount: null, transportation_text: 'as applicable',
  commercial_terms_note: null, fabric_responsibility: 'boe', billing_percentage: null,
  source_workbook_name: null, source_workbook_path: null,
}

const DISCOUNTED = { gross_product_amount: '3494400.00', discount_amount: '94300.00', subtotal_after_discount: '3400100.00',
  total_before_gst: '3570060.00', gst_amount: '642610.80', grand_total: '4212670.80' }
const UNDISCOUNTED = { gross_product_amount: '3494400.00', discount_amount: '0', subtotal_after_discount: '3494400.00',
  total_before_gst: '3664360.00', gst_amount: '659584.80', grand_total: '4323944.80' }

const ITEMS = [{ id: 'item-0', source_row: 32, item_sequence: '1', product_name: 'Cane Lounge Chair', quantity: 1,
  dimensions: null, material: null, customization: null, cost_per_piece: '3494400.00', total_amount: '3494400.00',
  sort_order: 0 }] as unknown as PersistedItem[]

const model = (figures: Record<string, unknown>) =>
  buildConfirmedPdfModel({ orderNumber: 'BOE/0525', submission: { ...BASE, ...figures } as unknown as OrderPiRow, items: ITEMS })

const lines = (figures: Record<string, unknown>) => model(figures).commercial.map(r => [r.label, r.value])

/** The text pdfkit drew: inflate the Flate streams, decode each TJ run. */
function pdfText(buf: Buffer): string {
  const raw = buf.toString('latin1')
  let inflated = ''
  let at = 0
  for (;;) {
    const start = raw.indexOf('stream', at)
    if (start < 0) break
    let from = start + 'stream'.length
    if (raw[from] === '\r') from++
    if (raw[from] === '\n') from++
    const end = raw.indexOf('endstream', from)
    if (end < 0) break
    try { inflated += zlib.inflateSync(Buffer.from(buf.subarray(from, end))).toString('latin1') }
    catch { /* a font or an image */ }
    at = end + 'endstream'.length
  }
  return inflated.replace(/\[([^\]]*)\]\s*TJ/g, (_m, body: string) =>
    [...body.matchAll(/<([0-9a-fA-F]+)>/g)].map(h => Buffer.from(h[1], 'hex').toString('latin1')).join(''))
}

describe('the client PDF names the gross apart from Product value', () => {
  test('a discount: "Product value before discount", then the discount once, figures and Grand Total as stored', () => {
    assert.deepEqual(lines(DISCOUNTED), [
      ['Product value before discount', 'Rs. 34,94,400'],
      ['Discount', 'Rs. 94,300'],
      ['Subtotal after discount', 'Rs. 34,00,100'],
      ['Fabric cost', 'Not applicable'],
      ['Packing cost', 'Rs. 1,69,960'],
      ['Transportation', 'as applicable'],
      ['Total before GST', 'Rs. 35,70,060'],
      ['GST', 'Rs. 6,42,610.80'],
      ['Grand Total', 'Rs. 42,12,670.80'],
    ])
    assert.equal(lines(DISCOUNTED).filter(([label]) => label === 'Discount').length, 1, 'the discount is printed once')
  })

  test('no discount: the line keeps "Gross product amount", with no Discount line', () => {
    assert.deepEqual(lines(UNDISCOUNTED).slice(0, 2), [
      ['Gross product amount', 'Rs. 34,94,400'],
      ['Subtotal', 'Rs. 34,94,400'],
    ])
    assert.ok(!lines(UNDISCOUNTED).some(([label]) => /discount/i.test(label)))
    assert.deepEqual(lines(UNDISCOUNTED).at(-1), ['Grand Total', 'Rs. 43,23,944.80'])
  })

  test('the rendered bytes say the same', async () => {
    const withDiscount = pdfText(await renderConfirmedPdf({ model: model(DISCOUNTED), metadata: { title: 't' } }))
    assert.ok(withDiscount.includes('Product value before discount'))
    assert.ok(!withDiscount.includes('Gross product amount'))
    assert.ok(withDiscount.includes('Rs. 42,12,670.80'), 'the Grand Total is the stored one')
    const without = pdfText(await renderConfirmedPdf({ model: model(UNDISCOUNTED), metadata: { title: 't' } }))
    assert.ok(without.includes('Gross product amount'))
    assert.ok(!without.includes('Product value before discount'))
    assert.ok(without.includes('Rs. 43,23,944.80'))
  })
})
