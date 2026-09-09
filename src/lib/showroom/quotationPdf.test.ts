/**
 * The showroom quotation document, rendered for real.
 *
 * These tests build actual PDFs with PDFKit and read the text back out of the
 * page content streams. They exist because the two defects they cover were both
 * invisible to every other kind of check:
 *
 *  1. `salesperson_name` was fetched from the inquiry's owner, threaded through
 *     the whole route, handed to the builder — and never drawn. Types were
 *     satisfied, the route returned 200, and the quotation named nobody.
 *  2. A product whose image did not load produced an empty rectangle. Nothing
 *     failed; the document simply had a hole in it.
 *
 * Reading the text back is what makes them provable. `compress: false` is used
 * for the assertions so the content stream is plain text — the route ships the
 * compressed default, and compression changes no glyph on the page.
 *
 * No network: every item here either has no image or an unreachable one, which
 * is also exactly the path that must never throw.
 *
 * Run:
 *   npx tsx --test src/lib/showroom/quotationPdf.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildEnhancedPdf, fmt, type PdfData, type PdfItem } from './quotationPdf'

// ── Reading a PDF back ────────────────────────────────────────────────────────

/**
 * The text PDFKit drew, recovered from the uncompressed content streams.
 *
 * PDFKit emits a `.text()` call as a `TJ` array of hex strings interleaved with
 * kerning numbers — `[<4341> 40 <4645> 0] TJ` — so a run has to be decoded and
 * rejoined before it reads as the original string. One line per `TJ` array,
 * which is one `.text()` call. Good enough to assert that a line is on the page
 * and what it says; deliberately not a layout assertion.
 */
function pdfText(bytes: Buffer): string {
  const raw = bytes.toString('latin1')
  const lines: string[] = []
  const arrays = /\[([^\]]*)\]\s*TJ/g
  let m: RegExpExecArray | null
  while ((m = arrays.exec(raw)) !== null) {
    let line = ''
    const chunks = /<([0-9A-Fa-f]*)>/g
    let c: RegExpExecArray | null
    while ((c = chunks.exec(m[1])) !== null) {
      line += Buffer.from(c[1], 'hex').toString('latin1')
    }
    if (line) lines.push(line)
  }
  return lines.join('\n')
}

const item = (over: Partial<PdfItem> = {}): PdfItem => ({
  quantity: 1,
  rate: 25000,
  mrp_at_time: 25000,
  customization_note: null,
  product: {
    product_code: 'BOE-SR-003',
    name: 'Atri Chair',
    image_url: null,
    dimensions: null,
  },
  ...over,
})

const data = (over: Partial<PdfData> = {}): PdfData => ({
  customer_name: 'Jasvi Interiors',
  customer_mobile: '+91 98765 43210',
  company: null,
  city: 'Jodhpur',
  project_name: null,
  salesperson_name: 'Ashok Choudhary',
  discount_percent: 0,
  quotation_no: 'BOE-Q-0042',
  created_at: '2026-09-01T10:00:00.000Z',
  items: [item()],
  ...over,
})

// Uncompressed so the content stream is readable. Same drawing calls either way.
const render = (d: PdfData) => buildEnhancedPdf(d, { compress: false })

// ── Salesperson ───────────────────────────────────────────────────────────────

describe('the salesperson who owns the inquiry', () => {
  test('is named on the quotation', async () => {
    const text = pdfText(await render(data()))
    assert.match(text, /SALES CONSULTANT/)
    assert.match(text, /Ashok Choudhary/)
  })

  test('is the inquiry owner even when someone else generated the document', async () => {
    // The builder is only ever given the inquiry's own salesperson — an admin
    // downloading a colleague's quotation has no way to substitute their name,
    // because the caller's identity is not one of the builder's inputs.
    const text = pdfText(await render(data({ salesperson_name: 'Prerna' })))
    assert.match(text, /Prerna/)
    assert.equal(/Ashok/.test(text), false)
  })

  test('an unresolved profile prints no row rather than a dash', async () => {
    // The route falls back to '—' when the users lookup returns nothing.
    const text = pdfText(await render(data({ salesperson_name: '—' })))
    assert.equal(/SALES CONSULTANT/.test(text), false)
  })

  test('the quotation still renders its number and date without a salesperson', async () => {
    const text = pdfText(await render(data({ salesperson_name: '' })))
    assert.match(text, /QUOTATION NO\./)
    assert.match(text, /BOE-Q-0042/)
    assert.match(text, /DATE/)
  })
})

// ── The missing-image box ─────────────────────────────────────────────────────

describe('a product whose image is not on the page', () => {
  test('with nothing on file, says so and names the product', async () => {
    const text = pdfText(await render(data()))
    assert.match(text, /NO IMAGE ON FILE/)
    assert.match(text, /BOE-SR-003/)
  })

  test('with an image that would not load, says the image is unavailable', async () => {
    // A host that cannot resolve: the fetch fails, and the document must still
    // be produced with a placeholder rather than a hole.
    const text = pdfText(await render(data({
      items: [item({
        product: {
          product_code: 'BOE-SR-105',
          name: 'Rimini Chair',
          image_url: 'https://invalid.invalid/nope.jpg',
          dimensions: null,
        },
      })],
    })))
    assert.match(text, /IMAGE UNAVAILABLE/)
    assert.match(text, /BOE-SR-105/)
  })

  test('one unreachable image does not stop the other products rendering', async () => {
    const text = pdfText(await render(data({
      items: [
        item({ product: { product_code: 'BOE-A', name: 'First Chair',  image_url: 'https://invalid.invalid/a.jpg', dimensions: null } }),
        item({ product: { product_code: 'BOE-B', name: 'Second Chair', image_url: null, dimensions: null } }),
      ],
    })))
    assert.match(text, /First Chair/)
    assert.match(text, /Second Chair/)
    assert.match(text, /IMAGE UNAVAILABLE/)
    assert.match(text, /NO IMAGE ON FILE/)
  })

  test('images land on the right cards when fetching is concurrent', async () => {
    // Images are fetched through a bounded worker pool, so results come back
    // out of order and are written into an indexed array. If that indexing
    // slipped, a photo — or a placeholder — would appear on the wrong product,
    // which is a wrong price next to a wrong picture in a customer's hands.
    // Alternating the two placeholder kinds makes any shift visible.
    const items = Array.from({ length: 6 }, (_, i) => item({
      product: {
        product_code: `BOE-${i}`,
        name: `Chair ${i}`,
        image_url: i % 2 === 0 ? `https://invalid.invalid/${i}.jpg` : null,
        dimensions: null,
      },
    }))
    const text = pdfText(await render(data({ items })))
    const placeholders = text.split('\n').filter(l =>
      l === 'IMAGE UNAVAILABLE' || l === 'NO IMAGE ON FILE')
    assert.deepEqual(placeholders, [
      'IMAGE UNAVAILABLE', 'NO IMAGE ON FILE',
      'IMAGE UNAVAILABLE', 'NO IMAGE ON FILE',
      'IMAGE UNAVAILABLE', 'NO IMAGE ON FILE',
    ])
  })

  test('an item whose product row is missing entirely still renders a card', async () => {
    const bytes = await render(data({ items: [item({ product: null })] }))
    assert.ok(bytes.length > 0)
    assert.match(pdfText(bytes), /Unknown product/)
  })
})

// ── The rest of the document still works ──────────────────────────────────────

describe('the quotation body', () => {
  test('carries the customer, the number and the commercial notes', async () => {
    const text = pdfText(await render(data({ company: 'Jasvi LLP', project_name: 'Hotel lobby' })))
    assert.match(text, /Jasvi Interiors/)
    assert.match(text, /Jasvi LLP/)
    assert.match(text, /Hotel lobby/)
    assert.match(text, /Jodhpur/)
    assert.match(text, /COMMERCIAL NOTES/)
    assert.match(text, /FINAL QUOTATION VALUE/)
  })

  test('shows a discount row only when there is a discount', async () => {
    const withDiscount = pdfText(await render(data({ discount_percent: 10 })))
    assert.match(withDiscount, /Discount \(10%\)/)
    // 25,000 less 10% — the existing calculation, unchanged.
    assert.match(withDiscount, /22,500/)

    const without = pdfText(await render(data({ discount_percent: 0 })))
    assert.equal(/Discount \(/.test(without), false)
    assert.match(without, /25,000/)
  })

  test('prints dimensions and a customization note when the item has them', async () => {
    const text = pdfText(await render(data({
      items: [item({
        customization_note: 'Walnut finish, customer fabric',
        product: {
          product_code: 'BOE-SR-003',
          name: 'Atri Chair',
          image_url: null,
          dimensions: { width: 22, depth: 24, height: 33, unit: 'inches' },
        },
      })],
    })))
    assert.match(text, /CUSTOMIZATION/)
    assert.match(text, /Walnut finish, customer fabric/)
    assert.match(text, /DIMENSIONS/)
    assert.match(text, /W 22/)
    assert.match(text, /H 33/)
  })

  test('a quotation with many items paginates instead of overflowing', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      item({ product: { product_code: `BOE-${i}`, name: `Chair ${i}`, image_url: null, dimensions: null } }))
    const text = pdfText(await render(data({ items: many })))
    // Every item reaches the document, including ones past the first page.
    for (let i = 0; i < 12; i++) assert.match(text, new RegExp(`Chair ${i}\\b`))
  })

  test('an empty quotation still produces a valid document', async () => {
    const bytes = await render(data({ items: [] }))
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-')
    assert.match(pdfText(bytes), /FINAL QUOTATION VALUE/)
  })

  test('money is written with Rs. rather than a rupee sign', async () => {
    // Helvetica is Latin-1 only; U+20B9 makes PDFKit throw mid-document.
    assert.equal(fmt(245000), 'Rs. 2,45,000')
    assert.equal(/₹/.test(pdfText(await render(data()))), false)
  })
})
