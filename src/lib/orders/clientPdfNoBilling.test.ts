/**
 * NO BILLING ON A CLIENT PDF (#248, owner's decision 2026-09-27).
 *
 * The Confirmed Order PDF and every PI version PDF (one builder,
 * buildConfirmedPdfModel) print neither "Billing percentage" nor "Billing
 * value", whether or not the PI declares one — billing_percentage is BOE's
 * internal arrangement, kept in Internal order details. The fabric
 * responsibility sentence stays, and every commercial figure and the Grand
 * Total are the same with and without a billing percentage.
 *
 * Offline: renders real PDF bytes from fixture rows; no database.
 *
 * Run:
 *   npx tsx --test src/lib/orders/clientPdfNoBilling.test.ts
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

const FABRIC_SENTENCE = 'Fabric will be provided by BOE.'

const render = async (figures: Record<string, unknown>, billing: string | null) =>
  pdfText(await renderConfirmedPdf({ model: model({ ...figures, billing_percentage: billing }), metadata: { title: 't' } }))

describe('a client PDF prints no billing, with or without a billing percentage', () => {
  for (const [name, figures, grand] of [
    ['discounted', DISCOUNTED, 'Rs. 42,12,670.80'],
    ['undiscounted', UNDISCOUNTED, 'Rs. 43,23,944.80'],
  ] as const) {
    test(`${name}: declared 65%, and undeclared`, async () => {
      for (const billing of ['65', null]) {
        const text = await render(figures, billing)
        for (const absent of ['Billing percentage', 'BILLING PERCENTAGE', 'Billing value', 'BILLING VALUE', 'Undeclared', '65%']) {
          assert.ok(!text.includes(absent), `${absent} is not printed (billing ${billing})`)
        }
        // 65% of Total before GST, the value the PDF used to print.
        for (const value of ['Rs. 23,20,539', 'Rs. 23,81,834']) assert.ok(!text.includes(value), value)
        assert.ok(text.includes(FABRIC_SENTENCE), 'the fabric sentence stays')
        assert.ok(text.includes(grand), 'the stored Grand Total')
      }
    })

    test(`${name}: the commercial rows are identical with and without a billing percentage`, () => {
      const withBilling = model({ ...figures, billing_percentage: '65' })
      const without = model({ ...figures, billing_percentage: null })
      assert.deepEqual(withBilling.commercial, without.commercial)
      assert.equal(withBilling.commercial.at(-1)?.value, grand)
      assert.equal(withBilling.fabricResponsibility, FABRIC_SENTENCE)
      assert.ok(!withBilling.meta.some(f => /billing/i.test(f.label)))
    })
  }
})

describe('of Internal order details, the client PDF prints only fabric responsibility', () => {
  // Every field in the section, filled with a marker. The Salesperson lines the
  // PDF prints come from the WORKBOOK (source_created_by, contact_number), never
  // from the salesperson chosen in the section.
  const SECTION = {
    order_confirmation_date: '2031-03-17', due_date: '2031-04-19',
    salesperson_id: 'SALESPERSONIDMARK', lead_source: 'instagram',
    billing_percentage: '65', billing_terms: 'BILLTERMSMARK',
    middleman_commission: true, middleman_name: 'MIDDLEMANMARK', middleman_commission_type: 'amount', middleman_commission_value: 43217,
    order_highlight_remark: 'HIGHLIGHTMARK',
  }

  test('the rendered text carries none of them, and the workbook salesperson as before', async () => {
    const m = model({ ...DISCOUNTED, ...SECTION, source_created_by: 'Workbook Author', contact_number: '+91 90000 00000' })
    assert.deepEqual(m.meta, [
      { label: 'Salesperson', value: 'Workbook Author' },
      { label: 'Salesperson contact', value: '+91 90000 00000' },
    ])
    const text = pdfText(await renderConfirmedPdf({ model: m, metadata: { title: 't' } }))
    for (const absent of ['SALESPERSONIDMARK', 'instagram', 'Instagram', 'BILLTERMSMARK', 'MIDDLEMANMARK', '43,217',
      'HIGHLIGHTMARK', '2031', 'Billing', 'BILLING', 'Lead source', 'LEAD SOURCE', 'Middleman', 'MIDDLEMAN']) {
      assert.ok(!text.includes(absent), `${absent} is not printed`)
    }
    assert.ok(text.includes(FABRIC_SENTENCE), 'fabric responsibility is')
    assert.ok(text.includes('Workbook Author'))
  })
})
