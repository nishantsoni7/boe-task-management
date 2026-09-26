/**
 * THE CONFIRMED ORDER PDF — its content, and where its pages break.
 *
 * WHAT THESE TESTS DEFEND
 * -----------------------
 * A PDF is the one artefact where a defect is invisible until a client is
 * holding it. Three kinds of defect matter here, and each has its own section:
 *
 *   1. A FIGURE THAT DISAGREES WITH THE PI. Every amount comes through the same
 *      builders the screens use, so the test is that no second arithmetic path
 *      exists — the strings match the ones the screen would print.
 *   2. A ROW LOST OR ORPHANED AT A PAGE BREAK. Pagination is a pure function
 *      here precisely so it can be proved: every row appears exactly once, in
 *      order, whole, and every page carrying rows repeats the column head.
 *   3. TEXT THE FONT CANNOT RENDER. Helvetica is Latin-1; ₹ is not in it. The
 *      substitution is asserted, and so is the rule that nothing outside the
 *      encoding is passed through to become mojibake in a client's hands.
 *
 * Sections 1–3 are pure. Section 4 renders a REAL PDF with pdfkit and reads the
 * text back out of its content streams — because "the table head repeats" is not
 * a claim a layout plan can settle.
 *
 * Offline. No network, no storage, no database.
 *
 * Run:
 *   npx tsx --test src/lib/orders/confirmedPdf.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

import {
  PDF_CURRENCY_NOTE,
  PDF_FOOTER_HEIGHT,
  PDF_MARGIN,
  PDF_MAX_ROW_HEIGHT,
  PDF_PAGE_HEIGHT,
  PDF_PRODUCT_COLUMNS,
  PDF_TABLE_HEAD_HEIGHT,
  buildConfirmedPdfModel,
  longestWrappingText,
  measureRowHeight,
  paginateProductRows,
  pdfAmount,
  toPdfText,
  type PdfProductRow,
} from './confirmedPdf'
import {
  FIRST_PAGE_TOP,
  LATER_PAGE_TOP,
  TAIL_HEIGHT,
  renderConfirmedPdf,
  toEmbeddableImage,
} from './confirmedPdfRender'
import { buildCommercialRows, formatInr } from '@/lib/pi/previewView'
import { persistedCommercial } from './draftsView'
import { BOE_STANDARD_COMMERCIAL_TERMS } from './piTerms'
import type { PersistedItem } from './draftsView'
import type { OrderPiRow } from './orderPiHandoff'

const SUB = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

function submission(over: Partial<OrderPiRow> = {}): OrderPiRow {
  return {
    id: SUB,
    client_name: 'Marigold Interiors',
    bill_to_name: 'Marigold Interiors Pvt Ltd',
    ship_to_name: 'Marigold Site Office',
    creation_date: '2026-07-01',
    source_created_by: 'R. Sharma',
    contact_number: '+91 98200 11223',
    bill_to_phone: null,
    ship_to_phone: null,
    billing_address: '14 Nariman Point, Mumbai',
    shipping_address: 'Plot 8, Sector 21, Gurugram',
    order_confirmation_date: '2026-07-04',
    dispatch_commitment: '6 weeks from date of confirmation',
    due_date: '2026-08-15',
    gross_product_amount: '1200000.00',
    discount_amount: '50000.00',
    subtotal_after_discount: '1150000.00',
    fabric_cost: '0',
    fabric_cost_meaning: 'not_applicable',
    fabric_cost_text: null,
    packing_cost: '0',
    packing_cost_meaning: 'included',
    packing_cost_text: 'Inclusive',
    transportation_amount: '20000.00',
    transportation_text: null,
    total_before_gst: '1170000.00',
    gst_amount: '210600.00',
    grand_total: '1380600.00',
    billing_percentage: '65',
    source_workbook_name: 'Marigold-PI-July.xlsx',
    source_workbook_path: null,
    ...over,
  }
}

function items(n: number, over: Partial<PersistedItem> = {}): PersistedItem[] {
  return Array.from({ length: n }, (_v, i) => ({
    id: `item-${i}`,
    source_row: 32 + i,
    item_sequence: String(i + 1),
    product_name: `Cane Lounge Chair ${i + 1}`,
    quantity: 12,
    dimensions: '720 x 680 x 900',
    material: 'Rattan / Teak',
    customization: null,
    cost_per_piece: '48000.00',
    total_amount: '576000.00',
    sort_order: i,
    ...over,
  }))
}

const model = (n = 3, over: Partial<OrderPiRow> = {}, extra: Partial<Parameters<typeof buildConfirmedPdfModel>[0]> = {}) =>
  buildConfirmedPdfModel({
    orderNumber: 'BOE/0001',
    submission: submission(over),
    items: items(n),
    ...extra,
  })

// ═══ 1. What the document says ═══════════════════════════════════════════════

describe('the document identifies itself and its client', () => {
  test('carries the confirmed Order number, exactly as given', () => {
    assert.equal(model().orderNumber, 'BOE/0001')
  })

  test('names the client, falling back to the bill-to party', () => {
    assert.equal(model().clientName, 'Marigold Interiors')
    assert.equal(model(1, { client_name: null }).clientName, 'Marigold Interiors Pvt Ltd')
    assert.equal(model(1, { client_name: null, bill_to_name: null }).clientName, 'Not provided')
  })

  test('carries billing details and shipping details as separate blocks', () => {
    const m = model()
    assert.deepEqual(m.billTo.map(f => f.label), ['Name', 'Address'])
    assert.deepEqual(m.shipTo.map(f => f.label), ['Name', 'Address'])
    assert.equal(m.billTo.find(f => f.label === 'Address')?.value, '14 Nariman Point, Mumbai')
    assert.equal(m.shipTo.find(f => f.label === 'Address')?.value, 'Plot 8, Sector 21, Gurugram')
  })

  test('a party the PI never named produces NO labelled holes', () => {
    const m = model(1, { ship_to_name: null, shipping_address: null, ship_to_phone: null })
    assert.deepEqual(m.shipTo, [], 'an empty block prints its own absence once')
  })

  test('carries the salesperson and their number — and NO date', () => {
    const meta = Object.fromEntries(model().meta.map(f => [f.label, f.value]))
    // NAMED FOR WHOSE IT IS. contact_number is the BOE-side number the
    // workbook carries at G22; it was labelled a bare "Contact" beside a
    // "PI created by" name, which read as the client’s number and is not
    // what the column holds.
    assert.equal(meta['Salesperson'], 'R. Sharma')
    assert.equal(meta['Salesperson contact'], '+91 98200 11223')
    assert.equal(meta['Contact'], undefined, 'the unqualified label is gone')
    assert.equal(meta['PI created by'], undefined)
    // 20270122000000: a client PDF prints no confirmation date and no due
    // date, from the app or from the workbook. This fixture carries both.
    assert.equal(meta['Confirm date'], undefined)
    assert.equal(meta['Due date'], undefined)
    assert.ok(!Object.values(meta).some(v => /Jul 2026|Aug 2026/.test(v)))
  })

  test('the salesperson line never falls back to a client’s number', () => {
    // IT USED TO. `contact_number || bill_to_phone || ship_to_phone` printed
    // the client's own number under a BOE label, on a document sent to that
    // client. A PI with no salesperson number now prints no such line, and
    // submission asks for one before it can be finalized.
    const meta = Object.fromEntries(model(1, {
      contact_number: null,
      bill_to_phone: '+91 90000 44444',
      ship_to_phone: '+91 90000 55555',
    }).meta.map(f => [f.label, f.value]))
    assert.equal(meta['Salesperson contact'], undefined)
    assert.ok(!Object.values(meta).some(v => v.includes('90000')),
      'the client’s number must not appear under a BOE label')
  })

  test('no date field of any kind, and the prose commitment is not turned into one', () => {
    const meta = Object.fromEntries(model(1, { due_date: '2027-01-01' }).meta.map(f => [f.label, f.value]))
    assert.ok(!Object.keys(meta).some(k => /date/i.test(k)), 'no date label')
    assert.ok(!Object.values(meta).some(v => v.includes('6 weeks') || v.includes('Jan 2027')))
  })
})

// ── Billing ───────────────────────────────────────────────────────────────────

describe('the billing declaration', () => {
  test('a declared percentage prints with its derived value', () => {
    const meta = Object.fromEntries(model().meta.map(f => [f.label, f.value]))
    assert.equal(meta['Billing percentage'], '65%')
    // 65% of the PRE-GST total, never of the grand total.
    assert.equal(meta['Billing value'], 'Rs. 7,60,500')
  })

  test('an undeclared percentage says so in words, and prints NO value row', () => {
    const meta = Object.fromEntries(model(1, { billing_percentage: null }).meta.map(f => [f.label, f.value]))
    assert.equal(meta['Billing percentage'], 'Undeclared')
    assert.equal(meta['Billing value'], undefined)
  })

  test('a declared percentage against a MISSING pre-GST total is never Rs. 0', () => {
    const meta = Object.fromEntries(model(1, { total_before_gst: null }).meta.map(f => [f.label, f.value]))
    assert.equal(meta['Billing percentage'], '65%')
    assert.equal(meta['Billing value'], '—', 'the missing treatment, not a zero')
  })
})

// ── The commercial block ──────────────────────────────────────────────────────

describe('the commercial summary', () => {
  test('is the SAME rows, string for string, that the screens print', () => {
    const expected = buildCommercialRows(persistedCommercial(submission()))
      .filter(r => r.key !== 'advance')
    const actual = model().commercial
    assert.equal(actual.length, expected.length)
    for (let i = 0; i < expected.length; i++) {
      assert.equal(actual[i].key, expected[i].key)
      // Only the currency symbol differs — no arithmetic, no reformatting.
      assert.equal(actual[i].value, expected[i].value.replace(/₹/g, 'Rs. '))
    }
  })

  test('carries product value, total before GST, GST and the grand total', () => {
    const keys = model().commercial.map(r => r.key)
    for (const key of ['gross', 'discount', 'subtotal', 'beforeGst', 'gst', 'grandTotal']) {
      assert.ok(keys.includes(key), key)
    }
  })

  test('does NOT print the advance requirement — this Order already exists', () => {
    assert.ok(!model().commercial.some(r => r.key === 'advance'))
  })

  test('a non-zero deduction is "Discount"; a zero one is left off', () => {
    // 20270122000000: the generated PI's convention, whatever the workbook said.
    assert.equal(model().commercial.find(r => r.key === 'discount')?.label, 'Discount')
    const zero = model(3, { discount_amount: '0', subtotal_after_discount: '1200000.00' }).commercial
    assert.equal(zero.find(r => r.key === 'discount'), undefined)
  })

  test('the grand total is the emphasised row, and it is the only one', () => {
    const emphasised = model().commercial.filter(r => r.emphasis)
    assert.deepEqual(emphasised.map(r => r.key), ['grandTotal'])
  })

  test('a missing figure is marked missing, so it renders muted and never as zero', () => {
    const row = model(1, { total_before_gst: null }).commercial.find(r => r.key === 'beforeGst')
    assert.equal(row?.missing, true)
    assert.ok(!/(^|\D)0($|\D)/.test(row?.value ?? ''), row?.value)
  })

  test('the four cost MEANINGS survive rather than collapsing to zero', () => {
    const rows = Object.fromEntries(model().commercial.map(r => [r.key, r.value]))
    assert.equal(rows['fabric'], 'Not applicable')
    assert.equal(rows['packing'], 'Included')
  })
})

// ── Products ──────────────────────────────────────────────────────────────────

describe('the product rows', () => {
  test('carry code, name, quantity, rate and amount', () => {
    const p = model(2).products[0]
    assert.equal(p.code, '1')
    assert.equal(p.name, 'Cane Lounge Chair 1')
    assert.equal(p.quantity, '12')
    assert.equal(p.rate, 'Rs. 48,000')
    assert.equal(p.lineTotal, 'Rs. 5,76,000')
  })

  test('an absent quantity is an em dash, not a zero', () => {
    const m = buildConfirmedPdfModel({
      orderNumber: 'X', submission: submission(), items: items(1, { quantity: null }),
    })
    assert.equal(m.products[0].quantity, '—')
  })

  test('the rate is the SAME string formatInr produces', () => {
    assert.equal(model(1).products[0].rate, formatInr(48000).replace('₹', 'Rs. '))
  })

  test('a row is marked as carrying an image only when one is expected', () => {
    const m = buildConfirmedPdfModel({
      orderNumber: 'X', submission: submission(), items: items(3),
      imageRows: new Set([33]),
    })
    assert.deepEqual(m.products.map(p => p.hasImage), [false, true, false])
  })

  test('an Order with no product lines still produces a document', () => {
    const m = buildConfirmedPdfModel({ orderNumber: 'X', submission: submission(), items: [] })
    assert.deepEqual(m.products, [])
    assert.ok(m.commercial.length > 0, 'the commercial summary still stands')
  })
})

// ── Payment ───────────────────────────────────────────────────────────────────

describe('the payment position', () => {
  test('is omitted entirely when none was supplied', () => {
    assert.equal(model().payment, null)
  })

  test('prints the VERIFIED figure and what it comes to', () => {
    const m = model(1, {}, { payment: { receivedText: '₹4,00,000', percentText: '29%', awaitingCount: 0 } })
    assert.deepEqual(m.payment?.map(f => [f.label, f.value]), [
      ['Verified payment', 'Rs. 4,00,000'],
      ['Of order value', '29%'],
    ])
  })

  test('money awaiting verification is REPORTED and explicitly not counted', () => {
    const m = model(1, {}, { payment: { receivedText: '₹0', percentText: '0%', awaitingCount: 2 } })
    const line = m.payment?.find(f => f.label === 'Awaiting verification')
    assert.match(String(line?.value), /2 payments/)
    assert.match(String(line?.value), /not counted above/)
  })
})

// ═══ 2. Text the font can render ═════════════════════════════════════════════

describe('what reaches the page', () => {
  test('the rupee sign becomes Rs., which is the documented limitation', () => {
    assert.equal(toPdfText('₹1,20,000'), 'Rs. 1,20,000')
    assert.equal(pdfAmount('₹5,200.50'), 'Rs. 5,200.50')
    assert.match(PDF_CURRENCY_NOTE, /Latin-1/)
    assert.match(PDF_CURRENCY_NOTE, /no figure is affected/)
  })

  test('formatInr\'s negative sign becomes one the font has', () => {
    assert.equal(toPdfText('−₹500'), '-Rs. 500')
  })

  test('the em dash — which WinAnsi DOES carry — is left alone', () => {
    assert.equal(toPdfText('—'), '—')
  })

  test('text outside the encoding is REPLACED, never passed through', () => {
    // Silent mojibake in a document sent to a client is a defect nobody
    // reports; a visible `?` is one somebody does.
    assert.equal(toPdfText('मैरीगोल्ड'), '?????????')
    assert.equal(toPdfText('日本'), '??')
  })

  test('control characters are dropped, and the layout ones are kept', () => {
    assert.equal(toPdfText('a bc'), 'abc')
    assert.equal(toPdfText('a\nb'), 'a\nb')
  })

  test('null and undefined are the empty string, never the words', () => {
    assert.equal(toPdfText(null), '')
    assert.equal(toPdfText(undefined), '')
    assert.ok(!toPdfText(null).includes('null'))
  })

  test('NOT ONE STRING in a built model still carries a rupee sign', () => {
    const m = model(3, {}, { payment: { receivedText: '₹4,00,000', percentText: '29%', awaitingCount: 1 } })
    const strings = JSON.stringify(m)
    assert.ok(!strings.includes('₹'), 'a ₹ reaching pdfkit renders as the wrong glyph')
    assert.ok(!strings.includes('−'))
  })
})

// ═══ 3. Pagination ═══════════════════════════════════════════════════════════

const paginate = (rows: readonly PdfProductRow[]) => paginateProductRows({
  rows, firstPageTop: FIRST_PAGE_TOP, laterPageTop: LATER_PAGE_TOP, tailHeight: TAIL_HEIGHT,
})

describe('page breaks', () => {
  test('a short Order is one page', () => {
    const pages = paginate(model(3).products)
    assert.equal(pages.length, 1)
    assert.equal(pages[0].rows.length, 3)
  })

  test('EVERY ROW APPEARS EXACTLY ONCE, in order, however many pages it takes', () => {
    for (const n of [1, 5, 19, 20, 21, 60, 120]) {
      const rows = model(n).products
      const placed = paginate(rows).flatMap(p => p.rows)
      assert.equal(placed.length, n, `${n} products`)
      assert.deepEqual(placed.map(r => r.row), rows.map(r => r.row), `${n} products, in order`)
      assert.equal(new Set(placed.map(r => r.row)).size, n, `${n} products, no duplicate at a boundary`)
    }
  })

  test('NO ROW STRADDLES A PAGE — every page fits inside its usable band', () => {
    const usableBottom = PDF_PAGE_HEIGHT - PDF_MARGIN - PDF_FOOTER_HEIGHT
    for (const pages of [paginate(model(60).products), paginate(model(120).products)]) {
      for (const page of pages) {
        const top = (page.index === 1 ? FIRST_PAGE_TOP : LATER_PAGE_TOP)
          + (page.tableHead ? PDF_TABLE_HEAD_HEIGHT : 0)
        const used = page.rows.reduce((sum, r) => sum + r.height, 0)
        assert.ok(top + used <= usableBottom,
          `page ${page.index} overflows: ${top + used} > ${usableBottom}`)
      }
    }
  })

  test('EVERY PAGE CARRYING ROWS REPEATS THE COLUMN HEAD', () => {
    for (const page of paginate(model(120).products)) {
      if (page.rows.length > 0) {
        assert.equal(page.tableHead, true, `page ${page.index} carries rows with no head`)
      }
    }
  })

  test('an Order with no products is one page with no table head', () => {
    const pages = paginate([])
    assert.equal(pages.length, 1)
    assert.equal(pages[0].tableHead, false)
    assert.deepEqual(pages[0].rows, [])
  })

  test('the totals get a page of their own rather than being split', () => {
    // A Grand Total orphaned from the rows above it is the one block on this
    // document that must be read whole.
    const usableBottom = PDF_PAGE_HEIGHT - PDF_MARGIN - PDF_FOOTER_HEIGHT
    const pages = paginate(model(120).products)
    const last = pages[pages.length - 1]
    const top = (last.index === 1 ? FIRST_PAGE_TOP : LATER_PAGE_TOP)
      + (last.tableHead ? PDF_TABLE_HEAD_HEIGHT : 0)
    const used = last.rows.reduce((sum, r) => sum + r.height, 0)
    assert.ok(top + used + TAIL_HEIGHT <= usableBottom,
      'the tail must fit on the page it is drawn on')
  })

  test('pages are numbered consecutively from one', () => {
    const pages = paginate(model(60).products)
    assert.deepEqual(pages.map(p => p.index), pages.map((_p, i) => i + 1))
  })

  test('a row with a photograph is at least tall enough for one', () => {
    const withImage = buildConfirmedPdfModel({
      orderNumber: 'X', submission: submission(), items: items(1), imageRows: new Set([32]),
    }).products[0]
    const plain = model(1).products[0]
    assert.ok(measureRowHeight(withImage, longestWrappingText(withImage))
      > measureRowHeight(plain, longestWrappingText(plain)))
  })

  test('a row with a very long description is CLAMPED, not allowed to eat a page', () => {
    const long = buildConfirmedPdfModel({
      orderNumber: 'X', submission: submission(),
      items: items(1, { customization: 'x'.repeat(4000) }),
    }).products[0]
    assert.ok(measureRowHeight(long, longestWrappingText(long)) <= PDF_MAX_ROW_HEIGHT)
  })

  test('and such a row is still placed exactly once', () => {
    const rows = buildConfirmedPdfModel({
      orderNumber: 'X', submission: submission(),
      items: items(30, { customization: 'y'.repeat(2000) }),
    }).products
    const placed = paginate(rows).flatMap(p => p.rows)
    assert.equal(placed.length, 30)
  })
})

// ═══ 4. A real PDF ═══════════════════════════════════════════════════════════
//
// Everything above is a plan. This renders it and reads the text back out of the
// content streams, because "the table head repeats" is not a claim a plan can
// settle.

const METADATA = { title: 'Confirmed Order BOE/0001' }

/**
 * The text pdfkit actually drew.
 *
 * Content streams are Flate-compressed, and pdfkit writes each run as a HEX
 * STRING inside a TJ array with kerning numbers between the runs. Both have to
 * be undone or a search for "CUSTOMIZATION" finds nothing in a document that
 * plainly contains it.
 */
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
    catch { /* not a Flate stream — a font file or an image */ }
    at = end + 'endstream'.length
  }
  // Each `[ <hex> num <hex> … ] TJ` becomes one run of text.
  return inflated.replace(/\[([^\]]*)\]\s*TJ/g, (_m, body: string) =>
    [...body.matchAll(/<([0-9a-fA-F]+)>/g)]
      .map(h => Buffer.from(h[1], 'hex').toString('latin1'))
      .join(''))
}

const pageCount = (buf: Buffer): number =>
  (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length

describe('the rendered PDF', () => {
  test('is a PDF, and it is not empty', async () => {
    const buf = await renderConfirmedPdf({ model: model(3), metadata: METADATA })
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-')
    assert.ok(buf.length > 1000)
  })

  test('IS BYTE-DETERMINISTIC for one model — which is what makes its hash an identity', async () => {
    const m = model(8)
    const a = await renderConfirmedPdf({ model: m, metadata: METADATA })
    const b = await renderConfirmedPdf({ model: m, metadata: METADATA })
    assert.equal(Buffer.compare(a, b), 0,
      'pdfkit stamps the clock unless the metadata dates are pinned')
  })

  // 20270122000000: the metadata dates are no longer the caller's to choose —
  // they were the Order's internal confirm date. One fixed instant, always.
  test('the metadata dates are the fixed epoch, never a caller\'s date', async () => {
    const raw = (await renderConfirmedPdf({ model: model(3), metadata: METADATA })).toString('latin1')
    // pdfkit writes each date as an indirect object: `/CreationDate 13 0 R`.
    const stamps = [...raw.matchAll(/\/(CreationDate|ModDate)\s+(\d+) 0 R/g)].map(m =>
      new RegExp(`(?:^|\\n)${m[2]} 0 obj\\s*\\(D:(\\d{8})`).exec(raw)?.[1] ?? 'unresolved')
    assert.deepEqual(stamps, ['19700101', '19700101'])
  })

  test('a different title produces different bytes', async () => {
    const m = model(3)
    const a = await renderConfirmedPdf({ model: m, metadata: METADATA })
    const b = await renderConfirmedPdf({ model: m, metadata: { title: 'Confirmed Order BOE/0002' } })
    assert.notEqual(Buffer.compare(a, b), 0)
  })

  test('carries the Order number, the client and the totals', async () => {
    const text = pdfText(await renderConfirmedPdf({ model: model(3), metadata: METADATA }))
    assert.ok(text.includes('BOE/0001'))
    assert.ok(text.includes('Marigold Interiors'))
    assert.ok(text.includes('Grand Total'))
    assert.ok(text.includes('Total before GST'))
    assert.ok(text.includes('GST'))
  })

  // ── What the PI says about its fabric and its terms ──
  //
  // THESE READ THE DRAWN BYTES, not the model. piTerms.test.ts already asserts
  // that buildConfirmedPdfModel produces the right sentence; what a client
  // receives is whatever pdfkit actually put on the page, and only extracting
  // it proves the two agree.

  test('the GENERATED PDF states who provides the fabric', async () => {
    for (const [answer, sentence] of [
      ['boe', 'Fabric will be provided by BOE.'],
      ['client', 'Fabric will be provided by client.'],
      ['not_selected', 'Fabric not selected yet.'],
    ] as const) {
      const buf = await renderConfirmedPdf({
        model: model(2, { fabric_responsibility: answer }), metadata: METADATA,
      })
      assert.ok(pdfText(buf).includes(sentence), `${answer} must print "${sentence}"`)
    }
  })

  test('a client-supplied PI does not also say BOE provides it', async () => {
    const buf = await renderConfirmedPdf({
      model: model(2, { fabric_responsibility: 'client' }), metadata: METADATA,
    })
    const drawn = pdfText(buf)
    assert.ok(drawn.includes('Fabric will be provided by client.'))
    assert.ok(!drawn.includes('Fabric will be provided by BOE'),
      'the document must not present BOE as sourcing the fabric')
  })

  test('the GENERATED PDF carries the commercial terms', async () => {
    const standard = await renderConfirmedPdf({
      model: model(2, { commercial_terms_note: BOE_STANDARD_COMMERCIAL_TERMS }),
      metadata: METADATA,
    })
    assert.ok(pdfText(standard).includes('Given prices are ex-factory.'),
      'the standard wording is printed, not assumed')

    const edited = 'Prices include fabric and packing. Transport at actual.'
    const negotiated = await renderConfirmedPdf({
      model: model(2, { commercial_terms_note: edited }), metadata: METADATA,
    })
    const drawn = pdfText(negotiated)
    assert.ok(drawn.includes(edited), 'an edited note reaches the page verbatim')
    assert.ok(!drawn.includes('ex-factory'),
      'and the standard sentence is not printed alongside it')
  })

  test('A HISTORICAL PI PRINTS NEITHER, because it stated neither', async () => {
    // No backfill: a PI finalized before this feature carries NULL in all three
    // columns. Regenerating its documents must produce what it always did.
    const buf = await renderConfirmedPdf({
      model: model(2, {
        fabric_responsibility: null, commercial_terms_note: null, client_city: null,
      }),
      metadata: METADATA,
    })
    const drawn = pdfText(buf)
    assert.ok(!drawn.includes('Fabric will be provided'))
    assert.ok(!drawn.includes('Fabric not selected'))
    assert.ok(!drawn.includes('ex-factory'))
    assert.ok(!/\bCity\b/.test(drawn), 'and no empty City line appears in the billing block')
    // The document is otherwise intact.
    assert.ok(drawn.includes('BOE/0001'))
  })

  test('the billing block states the city when the PI has one', async () => {
    const buf = await renderConfirmedPdf({
      model: model(2, { client_city: 'Coimbatore' }), metadata: METADATA,
    })
    assert.ok(pdfText(buf).includes('Coimbatore'))
  })

  test('carries billing and shipping details and the contact number', async () => {
    const text = pdfText(await renderConfirmedPdf({ model: model(2), metadata: METADATA }))
    assert.ok(text.includes('14 Nariman Point, Mumbai'))
    assert.ok(text.includes('Plot 8, Sector 21, Gurugram'))
    assert.ok(text.includes('+91 98200 11223'))
    assert.ok(text.includes('R. Sharma'))
  })

  test('AMOUNTS READ Rs., and no rupee sign reaches the page', async () => {
    const text = pdfText(await renderConfirmedPdf({ model: model(2), metadata: METADATA }))
    assert.ok(text.includes('Rs.'))
    assert.ok(!text.includes('₹'))
  })

  test('the page count matches the plan exactly — pdfkit adds none of its own', async () => {
    for (const n of [1, 3, 40, 120]) {
      const m = model(n)
      const planned = paginate(m.products).length
      const buf = await renderConfirmedPdf({ model: m, metadata: METADATA })
      assert.equal(pageCount(buf), planned, `${n} products`)
    }
  })

  test('EVERY PAGE IS NUMBERED, and the totals agree', async () => {
    const m = model(40)
    const planned = paginate(m.products).length
    const text = pdfText(await renderConfirmedPdf({ model: m, metadata: METADATA }))
    assert.ok(planned > 1, 'the fixture must actually span pages')
    for (let i = 1; i <= planned; i++) {
      assert.ok(text.includes(`Page ${i} of ${planned}`), `page ${i} is not numbered`)
    }
  })

  test('THE PRODUCT TABLE HEAD REPEATS on every page that carries rows', async () => {
    const m = model(40)
    const withRows = paginate(m.products).filter(p => p.rows.length > 0).length
    const text = pdfText(await renderConfirmedPdf({ model: m, metadata: METADATA }))
    assert.ok(withRows > 1, 'the fixture must actually span pages')
    for (const column of PDF_PRODUCT_COLUMNS) {
      assert.equal((text.match(new RegExp(column.toUpperCase(), 'g')) ?? []).length, withRows,
        `"${column}" should appear once per page of rows`)
    }
  })

  test('every product name reaches the document', async () => {
    const m = model(40)
    const text = pdfText(await renderConfirmedPdf({ model: m, metadata: METADATA }))
    for (const p of m.products) {
      assert.ok(text.includes(p.name), `${p.name} is missing from the PDF`)
    }
  })

  test('a continuation page repeats the Order number, so a loose sheet is identifiable', async () => {
    const m = model(40)
    const text = pdfText(await renderConfirmedPdf({ model: m, metadata: METADATA }))
    assert.ok((text.match(/BOE\/0001/g) ?? []).length >= 2)
  })

  test('an Order with no products renders one page and still shows its totals', async () => {
    const m = buildConfirmedPdfModel({ orderNumber: 'BOE/0002', submission: submission(), items: [] })
    const buf = await renderConfirmedPdf({ model: m, metadata: METADATA })
    assert.equal(pageCount(buf), 1)
    const text = pdfText(buf)
    assert.ok(text.includes('Grand Total'))
    assert.ok(text.includes('Page 1 of 1'))
  })

  test('optional fields the PI never carried do not become empty labels', async () => {
    const m = buildConfirmedPdfModel({
      orderNumber: 'BOE/0003',
      submission: submission({
        ship_to_name: null, shipping_address: null, ship_to_phone: null,
        contact_number: null, bill_to_phone: null, source_created_by: null,
        due_date: null, billing_percentage: null,
      }),
      items: items(2),
    })
    const text = pdfText(await renderConfirmedPdf({ model: m, metadata: METADATA }))
    assert.ok(text.includes('Not provided'), 'an absent block says so once')
    assert.ok(!/DUE DATE/i.test(text), 'and no due date line at all')
    assert.ok(text.includes('Undeclared'))
    assert.ok(!text.includes('null'))
    assert.ok(!text.includes('undefined'))
  })

  test('the currency limitation is printed on the document itself', async () => {
    const text = pdfText(await renderConfirmedPdf({ model: model(2), metadata: METADATA }))
    assert.ok(text.includes('Latin-1'))
  })

  test('the payment position is printed when supplied and absent when not', async () => {
    const withPayment = model(2, {}, { payment: { receivedText: '₹4,00,000', percentText: '29%', awaitingCount: 1 } })
    const text = pdfText(await renderConfirmedPdf({ model: withPayment, metadata: METADATA }))
    // Field labels are drawn upper-case, the same treatment every other label
    // block on this document uses.
    assert.ok(text.includes('VERIFIED PAYMENT'))
    assert.ok(text.includes('Rs. 4,00,000'))
    assert.ok(text.includes('not counted above'))

    const without = pdfText(await renderConfirmedPdf({ model: model(2), metadata: METADATA }))
    assert.ok(!without.includes('VERIFIED PAYMENT'))
    assert.ok(!without.includes('not counted above'))
  })
})

// ── Images ────────────────────────────────────────────────────────────────────

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64')

describe('product images', () => {
  test('a PNG is embedded as it is', async () => {
    const out = await toEmbeddableImage(PNG_1x1)
    assert.ok(out)
    assert.equal(Buffer.compare(out, PNG_1x1), 0)
  })

  test('a JPEG is embedded as it is', async () => {
    // A minimal but genuine JPEG, produced by sharp from the PNG above.
    const { default: sharp } = await import('sharp')
    const jpeg = await sharp(PNG_1x1).jpeg().toBuffer()
    const out = await toEmbeddableImage(jpeg)
    assert.ok(out)
    assert.equal(Buffer.compare(out, jpeg), 0)
  })

  test('a WEBP — which the PI pipeline stores — is converted rather than dropped', async () => {
    const { default: sharp } = await import('sharp')
    const webp = await sharp(PNG_1x1).webp().toBuffer()
    const out = await toEmbeddableImage(webp)
    assert.ok(out, 'a stored WEBP must still reach the document')
    assert.equal(out[0], 0xff, 'converted to JPEG')
    assert.equal(out[1], 0xd8)
  })

  test('AN UNDECODABLE IMAGE IS NULL, NOT AN EXCEPTION', async () => {
    for (const bad of [
      null,
      new Uint8Array(0),
      new Uint8Array([1, 2, 3]),
      Buffer.from('this is not an image at all, it is a sentence'),
      Buffer.alloc(4096, 0x5a),
    ]) {
      assert.equal(await toEmbeddableImage(bad), null, String(bad?.length))
    }
  })

  test('a TRUNCATED PNG does not take the document down', async () => {
    const truncated = PNG_1x1.subarray(0, 40)
    // It sniffs as a PNG, so it is handed to pdfkit — and the renderer's own
    // try/catch draws the empty box instead of throwing.
    const m = buildConfirmedPdfModel({
      orderNumber: 'BOE/0004', submission: submission(), items: items(2), imageRows: new Set([32, 33]),
    })
    const buf = await renderConfirmedPdf({
      model: m, metadata: METADATA,
      loadImage: async () => truncated,
    })
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-')
    assert.ok(pdfText(buf).includes('Grand Total'))
  })

  test('AN IMAGE LOADER THAT THROWS does not fail the document', async () => {
    const m = buildConfirmedPdfModel({
      orderNumber: 'BOE/0005', submission: submission(), items: items(3), imageRows: new Set([32, 33, 34]),
    })
    const buf = await renderConfirmedPdf({
      model: m, metadata: METADATA,
      loadImage: async () => { throw new Error('storage said no') },
    })
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-')
    const text = pdfText(buf)
    assert.ok(text.includes('Cane Lounge Chair 1'), 'the rows are still there')
    assert.ok(text.includes('Grand Total'))
  })

  test('a real image is actually embedded', async () => {
    const m = buildConfirmedPdfModel({
      orderNumber: 'BOE/0006', submission: submission(), items: items(2), imageRows: new Set([32, 33]),
    })
    const withImages = await renderConfirmedPdf({ model: m, metadata: METADATA, loadImage: async () => PNG_1x1 })
    const without = await renderConfirmedPdf({ model: m, metadata: METADATA, loadImage: async () => null })
    assert.ok(withImages.length > without.length, 'the embedded image should grow the file')
    assert.ok(withImages.toString('latin1').includes('/Image'))
  })

  test('only rows that expect an image are asked for one', async () => {
    const asked: number[] = []
    const m = buildConfirmedPdfModel({
      orderNumber: 'BOE/0007', submission: submission(), items: items(5), imageRows: new Set([33, 35]),
    })
    await renderConfirmedPdf({
      model: m, metadata: METADATA,
      loadImage: async (row) => { asked.push(row); return PNG_1x1 },
    })
    assert.deepEqual(asked.sort((a, b) => a - b), [33, 35])
  })
})
