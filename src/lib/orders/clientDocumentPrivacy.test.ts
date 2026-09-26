/**
 * WHAT A CLIENT DOCUMENT ACTUALLY SAYS — read back out of REAL PDF BYTES.
 *
 * Two rules for the generated client PDFs (20270122000000):
 *
 *   1. NO confirmation date and NO due date — from ANY source: not the
 *      app-entered dates (Sales' internal answers) and not the dates the
 *      uploaded workbook stated. The internal middleman answer is never
 *      printed either.
 *   2. The deduction row: LEFT OFF when zero or blank; "Discount" when
 *      non-zero — never "Design Fee" — whatever the workbook called it. The
 *      figures do not change.
 *
 * A column-list test cannot prove either, because one record read feeds both
 * the internal screens and the documents. So this renders the two generated
 * PDFs a client can receive, through the real builders and pdfkit, with every
 * date source populated with distinctive values, and searches the text drawn:
 *
 *   the confirmed-order PDF   POST /api/orders/[id]/documents  (buildConfirmedPdfModel)
 *   the PI version PDF        GET  /api/orders/[id]/pi-versions/[versionId]/pdf
 *                             (piVersionPdfSource → buildConfirmedPdfModel), for a
 *                             live row and for a captured version
 *
 * NOT generated here, and NOT changed by this work: the ORIGINAL uploaded
 * workbook (served byte-for-byte by signed URL) and the confirmed Excel copy
 * (the workbook with only the Order number and corrected cells rewritten).
 * Whatever dates and wording the uploaded workbook contains, those files still
 * contain — sharing them shares that.
 *
 * Run: npx tsx --test src/lib/orders/clientDocumentPrivacy.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { buildConfirmedPdfModel } from './confirmedPdf'
import { renderConfirmedPdf } from './confirmedPdfRender'
import { piVersionPdfSource } from './piVersionPdf'
import type { PersistedItem } from './draftsView'
import type { OrderPiRow } from './orderPiHandoff'

const SUB = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const METADATA = { date: new Date('2026-07-04T00:00:00Z'), title: 'Confirmed Order BOE/0001' }

// Every date source populated, each with a distinctive day.
const DATES = {
  order_confirmation_date: '2026-09-23',            // app-entered (internal)
  due_date: '2026-09-29',                           // app-entered (internal)
  workbook_order_confirmation_date: '2026-09-21',   // what the workbook stated
  workbook_due_date: '2026-11-27',                  // what the workbook stated
  dispatch_commitment: '6 weeks from date of confirmation',
}
const DATE_TEXT = ['23 Sep 2026', '29 Sep 2026', '21 Sep 2026', '27 Nov 2026',
  '2026-09-23', '2026-09-29', '2026-09-21', '2026-11-27']

const INTERNAL = {
  middleman_commission: 'yes',
  middleman_recipient: 'Zephyrine Quillfeather',
  middleman_commission_basis: 'amount',
  middleman_commission_amount: '43217.00',
  internal_details_confirmed_at: '2026-09-26T11:00:00Z',
  internal_details_confirmed_by: '5a1e5a1e-0000-4000-8000-00000000a001',
}
const INTERNAL_TEXT = ['Zephyrine', 'Quillfeather', '43,217', 'iddleman', 'ommission']

function row(over: Record<string, unknown> = {}): OrderPiRow {
  return {
    id: SUB,
    client_name: 'Marigold Interiors',
    bill_to_name: 'Marigold Interiors Pvt Ltd',
    ship_to_name: null,
    creation_date: '2026-07-01',
    source_created_by: 'R. Sharma',
    contact_number: '+91 98200 11223',
    bill_to_phone: null, ship_to_phone: null,
    billing_address: 'Plot 4, MIDC', shipping_address: null,
    client_city: 'Pune',
    bill_to_gst: null, ship_to_gst: null,
    discount_label: 'Design Fees',               // what the workbook printed
    gross_product_amount: '3494400.00',
    discount_amount: '94300.00',
    subtotal_after_discount: '3400100.00',
    fabric_cost: '0', fabric_cost_meaning: 'not_applicable', fabric_cost_text: null,
    packing_cost: '169960.00', packing_cost_meaning: 'numeric', packing_cost_text: null,
    transportation_amount: null, transportation_text: 'as applicable',
    total_before_gst: '3570060.00',
    gst_amount: '642610.80',
    grand_total: '4212670.80',
    commercial_terms_note: 'Given prices are ex-factory.',
    fabric_responsibility: 'boe',
    billing_percentage: null,
    source_workbook_name: null,
    source_workbook_path: null,
    ...DATES,
    ...INTERNAL,
    ...over,
  } as unknown as OrderPiRow
}

const ITEMS: PersistedItem[] = [{
  id: 'item-0', source_row: 32, item_sequence: '1', product_name: 'Cane Lounge Chair',
  quantity: 1, dimensions: null, material: null, customization: null,
  cost_per_piece: '3494400.00', total_amount: '3494400.00', sort_order: 0,
} as unknown as PersistedItem]

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

async function rendered(submission: OrderPiRow): Promise<string> {
  const model = buildConfirmedPdfModel({ orderNumber: 'BOE/0525', submission, items: ITEMS })
  return pdfText(await renderConfirmedPdf({ model, metadata: METADATA }))
}

function assertNoDatesOrInternal(text: string, where: string) {
  assert.ok(!/CONFIRM DATE|DUE DATE|Confirm date|Due date/.test(text), `${where} has a date line`)
  for (const t of DATE_TEXT) assert.ok(!text.includes(t), `${where} printed the date "${t}"`)
  assert.ok(!text.includes('6 weeks'), `${where} printed the dispatch commitment`)
  for (const t of INTERNAL_TEXT) assert.ok(!text.includes(t), `${where} printed internal text "${t}"`)
}

describe('the confirmed-order PDF and the live PI version PDF (same builder, same row)', () => {
  test('the extraction works — the PDF says what it obviously says', async () => {
    const text = await rendered(row())
    assert.ok(text.includes('BOE/0525'))
    assert.ok(text.includes('Marigold Interiors'))
    assert.ok(text.includes('42,12,670.80'), 'the grand total is there')
  })

  test('NO date from the app or the workbook, and no middleman detail — with every source populated', async () => {
    assertNoDatesOrInternal(await rendered(row()), 'the confirmed PDF')
  })

  test('the ₹94,300 case: printed as "Discount", never "Design Fee", figures unchanged', async () => {
    // The workbook said "Design Fees"; the generated PI follows the convention.
    const text = await rendered(row())
    assert.ok(/\bDiscount\b/.test(text))
    assert.ok(!/Design Fee/i.test(text), 'no Design Fee label for a non-zero deduction')
    assert.ok(text.includes('Rs. 94,300'), 'the same amount')
    assert.ok(text.includes('Subtotal after discount'))
    assert.ok(text.includes('Rs. 34,00,100'), 'the same subtotal — deducted')
    assert.ok(text.includes('Rs. 35,70,060') && text.includes('Rs. 42,12,670.80'), 'the totals are untouched')
  })

  test('the zero case: the row is left off entirely, whatever it was called', async () => {
    for (const discount_amount of ['0', '0.00', null]) {
      const text = await rendered(row({ discount_amount, subtotal_after_discount: '3494400.00' }))
      assert.ok(!/\bDiscount\b/.test(text), `no Discount row (${String(discount_amount)})`)
      assert.ok(!/Design Fee/i.test(text), `no Design Fee row (${String(discount_amount)})`)
      assert.ok(!text.includes('Rs. 0 '), 'no zero row')
    }
  })
})

describe('the PI version PDF for a CAPTURED version', () => {
  test('a captured version carrying every date and the middleman answers prints none of them', async () => {
    const src = piVersionPdfSource({
      detail: {
        source: 'captured',
        content: {
          submission: row(),
          items: [{ id: 'item-0', source_row: 32, item_sequence: '1', product_name: 'Cane Lounge Chair',
            quantity: 1, cost_per_piece: '3494400.00', total_amount: '3494400.00', sort_order: 0 }],
          images: [],
          codes: {},
        },
      },
      submissionId: SUB,
      orderDisplayNumber: '0525',
      liveCodes: new Map(),
    })
    assert.equal(src.ok, true)
    if (!src.ok) return
    const model = buildConfirmedPdfModel({ orderNumber: 'BOE/0525', submission: src.submission, items: src.items })
    const text = pdfText(await renderConfirmedPdf({ model, metadata: METADATA }))
    assert.ok(text.includes('Cane Lounge Chair'), 'the version rendered')
    assertNoDatesOrInternal(text, 'the captured version PDF')
    assert.ok(/\bDiscount\b/.test(text) && !/Design Fee/i.test(text))
  })
})
