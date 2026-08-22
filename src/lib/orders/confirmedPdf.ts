// THE CONFIRMED ORDER PDF — what it says, and where the pages break.
//
// WHAT THIS MODULE IS, AND WHAT IT IS NOT
// ---------------------------------------
// This decides the CONTENT and the LAYOUT PLAN of the confirmed PDF. It draws
// nothing: confirmedPdfRender.ts takes the model below and hands it to pdfkit.
//
// The split is not tidiness. Everything that could be WRONG about this document
// — a figure that disagrees with the PI, a product row silently dropped at a
// page break, a table header that does not repeat, a client name that came from
// the wrong place — is decided here, in a pure function, and is tested without
// a PDF library, a font, or a byte of binary output.
//
// NOT ONE FIGURE IS COMPUTED HERE.
// ---------------------------------
// Every amount comes through buildCommercialRows / persistedCommercial /
// billingValue — the same helpers the Order screen and both PI screens use, and
// the same STRINGS. There is no second formatting path and no second
// arithmetic, so the PDF cannot round differently from the screen a person
// approved on. What this module does with a figure is choose where it goes.
//
// THE DISCOUNT, AND WHY IT IS NOT RE-LABELLED
// -------------------------------------------
// Some BOE templates label that row "Design Fees" and others "Discount", for the
// same cell with the same meaning. buildCommercialRows already resolved that —
// it always says "Discount", and the parser keeps the workbook's own wording for
// audit. This prints the row it is given. Deciding again here would be a second
// answer to a question that already has one.
//
// THE RUPEE SIGN
// --------------
// Helvetica is a built-in PDF font and covers Latin-1 only, so ₹ is not
// available to it. The repository owns no licensed Unicode font asset, and
// downloading one is not this session's to do — so the existing convention
// stands: the amounts read `Rs. 1,20,000`, exactly as the showroom quotation PDF
// has since it shipped. This is a PRESENTATION LIMITATION, recorded as one. It
// changes no figure, and it is a one-line fix the day a licensed font lands in
// the repository — see toPdfText.

import { formatBillingPercentage, readBillingPercentage, billingValue } from './billingPercentage'
import { persistedCommercial, persistedHeader, persistedProducts } from './draftsView'
import type { PersistedItem, PersistedProduct } from './draftsView'
import type { OrderPiRow } from './orderPiHandoff'
import {
  buildCommercialRows,
  buildHeaderRows,
  formatInr,
  formatPiDate,
  orDash,
  type PiAmountRow,
} from '@/lib/pi/previewView'
import { commercialBreakdownRows } from '@/app/orders/drafts/[submissionId]/piDetailView'

// ── Text ──────────────────────────────────────────────────────────────────────

/** Said once, so the code, the tests and the release note cannot word it
 *  differently. */
export const PDF_CURRENCY_NOTE =
  'Amounts read "Rs." rather than the rupee sign: the built-in PDF fonts cover '
  + 'Latin-1 only and this repository owns no licensed Unicode font asset. A '
  + 'presentation limitation; no figure is affected.'

/**
 * Text that the built-in PDF fonts can actually render.
 *
 * WinAnsi covers Latin-1 plus a handful of typographic characters. The
 * application legitimately uses four things outside it, and each has a faithful
 * ASCII stand-in:
 *
 *   ₹  the rupee sign        → `Rs. `   (see PDF_CURRENCY_NOTE)
 *   −  U+2212 minus          → `-`      formatInr's negative sign
 *   ₨  the older rupee sign  → `Rs. `   in case a workbook carries one
 *   ×  is IN WinAnsi and is deliberately left alone.
 *
 * ANY OTHER character outside the range is replaced rather than passed through.
 * pdfkit does not refuse an unmappable glyph — it renders something else — so a
 * client's name in Devanagari would come out as mojibake in a document sent to
 * that client. A visible `?` is a defect somebody reports; silent mojibake is
 * one nobody does.
 *
 * ONE PLACE. Every string the renderer draws goes through here, so there is no
 * second escaping rule that could disagree.
 */
export function toPdfText(value: string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return [...String(value)]
    .map(ch => {
      if (ch === '₹' || ch === '₨') return 'Rs. '
      if (ch === '−') return '-'
      const code = ch.codePointAt(0) ?? 0
      // Tab, newline and carriage return are handled by the caller's layout;
      // everything else below 0x20 is a control character and is dropped.
      if (code === 9 || code === 10 || code === 13) return ch
      if (code < 0x20) return ''
      if (code <= 0xff) return ch
      // The typographic characters WinAnsi does carry above U+00FF.
      if ('‘’‚“”„†‡•…‰‹›€™ŠšŽžŒœŸƒˆ˜–—'.includes(ch)) return ch
      return '?'
    })
    .join('')
}

/** An amount as the PDF prints it: the SAME formatted string the screen shows,
 *  with only the currency symbol substituted. No arithmetic happens here. */
export function pdfAmount(text: string): string {
  return toPdfText(text)
}

// ── The model ─────────────────────────────────────────────────────────────────

export type PdfField = { label: string; value: string }

export type PdfProductRow = {
  /** The worksheet row, which is what an image is keyed by. */
  row: number
  code: string
  name: string
  quantity: string
  dimensions: string
  material: string
  customization: string
  rate: string
  lineTotal: string
  /** How tall this row needs to be, in points. Decided by paginate(). */
  height: number
  /** True when a product photograph is expected for this row. */
  hasImage: boolean
}

export type PdfCommercialRow = {
  key: string
  label: string
  value: string
  emphasis: boolean
  /** A hairline is drawn above this row. */
  groupStart: boolean
  /** The record does not carry this figure — printed muted, never as zero. */
  missing: boolean
}

export type ConfirmedPdfModel = {
  /** `BOE/0001` — the confirmed number, as the document's own identity. */
  orderNumber: string
  clientName: string
  /** Who to bill, and where. */
  billTo: PdfField[]
  /** Who to ship to, and where. */
  shipTo: PdfField[]
  /** Contact number, PI creator, confirm date, due date, billing percentage. */
  meta: PdfField[]
  products: PdfProductRow[]
  commercial: PdfCommercialRow[]
  /** The verified-payment position, or null when it is not to be printed. */
  payment: PdfField[] | null
  /** One quiet line under the totals. */
  currencyNote: string
}

// ── Labels ────────────────────────────────────────────────────────────────────

export const PDF_TITLE = 'CONFIRMED ORDER'
export const PDF_ORDER_NUMBER_LABEL = 'Order No.'
export const PDF_BILL_TO_TITLE = 'Bill to'
export const PDF_SHIP_TO_TITLE = 'Ship to'
export const PDF_PRODUCTS_TITLE = 'Products'
export const PDF_COMMERCIAL_TITLE = 'Commercial summary'
export const PDF_PAYMENT_TITLE = 'Payment'

/** The product table's column headings — REPEATED on every page that carries
 *  product rows. A continuation page whose table has no head is a page of
 *  unlabelled numbers. */
export const PDF_PRODUCT_COLUMNS = [
  'Code', 'Image', 'Product', 'Qty', 'Dimensions', 'Material', 'Customization', 'Rate', 'Amount',
] as const

// ── Building it ───────────────────────────────────────────────────────────────

export type ConfirmedPdfInput = {
  /** The Order's confirmed display number. Never derived, never allocated. */
  orderNumber: string
  /** The approved PI row, exactly as ORDER_PI_HANDOFF_COLUMNS returns it. */
  submission: OrderPiRow
  /** Its product lines. */
  items: readonly PersistedItem[]
  /** Which worksheet rows have a product photograph to embed. */
  imageRows?: ReadonlySet<number>
  /**
   * The verified-payment position, already formatted by the database's own
   * summary. Null when it is not to be printed — see buildConfirmedPdfModel.
   */
  payment?: {
    receivedText: string
    percentText: string
    /** Money Finance has not decided. Never folded into the figure above. */
    awaitingCount: number
  } | null
}

const clean = (v: string | null | undefined): string => {
  const t = (v ?? '').trim()
  return t === '' || t === '—' ? '' : t
}

export function buildConfirmedPdfModel(input: ConfirmedPdfInput): ConfirmedPdfModel {
  const sub = input.submission

  const headerRows = buildHeaderRows(persistedHeader(sub))
  const confirmed = headerRows.find(r => r.key === 'confirmed')?.value ?? ''

  // THE SAME ROWS THE SCREEN SHOWS, minus the advance — a pre-approval condition
  // that no longer applies to an Order that already exists.
  const rows = commercialBreakdownRows(buildCommercialRows(persistedCommercial(sub)))

  const products = persistedProducts(input.items)

  const percent = readBillingPercentage(sub.billing_percentage ?? null)
  const beforeGst = numericOf(sub.total_before_gst)
  const billed = billingValue({ totalBeforeGst: beforeGst, percentage: percent })

  const meta: PdfField[] = []
  const contact = clean(sub.contact_number) || clean(sub.bill_to_phone) || clean(sub.ship_to_phone)
  if (contact) meta.push({ label: 'Contact', value: toPdfText(contact) })
  // "PI created by" is the DOCUMENT's own author where the workbook named one.
  const author = clean(sub.source_created_by)
  if (author) meta.push({ label: 'PI created by', value: toPdfText(author) })
  if (clean(confirmed)) meta.push({ label: 'Confirm date', value: toPdfText(confirmed) })
  meta.push({
    label: 'Due date',
    // formatPiDate re-spells the ISO string WITHOUT constructing a Date — the
    // timezone-safe path every other date in this system uses.
    value: sub.due_date
      ? toPdfText(formatPiDate({ iso: sub.due_date, text: sub.due_date, source: 'serial' }))
      : 'Not set',
  })
  // UNDECLARED IS SAID IN WORDS, never as 0%.
  meta.push({ label: 'Billing percentage', value: toPdfText(formatBillingPercentage(percent)) })
  if (percent !== null) {
    meta.push({
      label: 'Billing value',
      // MISSING IS NOT ZERO: formatInr renders an absent figure as an em dash.
      value: pdfAmount(formatInr(billed)),
    })
  }

  return {
    orderNumber: toPdfText(input.orderNumber),
    clientName: toPdfText(clean(sub.client_name) || clean(sub.bill_to_name) || 'Not provided'),
    billTo: party(clean(sub.bill_to_name), clean(sub.billing_address), clean(sub.bill_to_phone)),
    shipTo: party(clean(sub.ship_to_name), clean(sub.shipping_address), clean(sub.ship_to_phone)),
    meta,
    products: products.map(p => productRow(p, input.imageRows)),
    commercial: rows.map(commercialRow),
    payment: input.payment
      ? [
          { label: 'Verified payment', value: pdfAmount(input.payment.receivedText) },
          { label: 'Of order value', value: toPdfText(input.payment.percentText) },
          ...(input.payment.awaitingCount > 0
            ? [{
                label: 'Awaiting verification',
                // NOT COUNTED ABOVE, and the line says so. A payment Finance has
                // not decided may not move a figure that reads as money in hand.
                value: `${input.payment.awaitingCount} payment${input.payment.awaitingCount === 1 ? '' : 's'} — not counted above`,
              }]
            : []),
        ]
      : null,
    currencyNote: PDF_CURRENCY_NOTE,
  }
}

function party(name: string, address: string, phone: string): PdfField[] {
  const out: PdfField[] = []
  if (name) out.push({ label: 'Name', value: toPdfText(name) })
  if (address) out.push({ label: 'Address', value: toPdfText(address) })
  if (phone) out.push({ label: 'Phone', value: toPdfText(phone) })
  // A block with nothing in it prints its own absence rather than a run of
  // labelled holes.
  return out
}

function productRow(p: PersistedProduct, imageRows?: ReadonlySet<number>): PdfProductRow {
  return {
    row: p.row,
    code: toPdfText(orDash(p.itemSequence)),
    name: toPdfText(orDash(p.productName)),
    quantity: p.quantity === null ? '—' : String(p.quantity),
    dimensions: toPdfText(orDash(p.dimensions)),
    material: toPdfText(orDash(p.material)),
    customization: toPdfText(orDash(p.customization)),
    rate: pdfAmount(formatInr(p.costPerPiece)),
    lineTotal: pdfAmount(formatInr(p.lineTotal)),
    height: 0,
    hasImage: imageRows?.has(p.row) ?? false,
  }
}

function commercialRow(row: PiAmountRow): PdfCommercialRow {
  return {
    key: row.key,
    label: toPdfText(row.label),
    value: pdfAmount(row.value),
    emphasis: row.emphasis === 'total',
    groupStart: row.groupStart === true,
    missing: row.kind === 'missing',
  }
}

function numericOf(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

// ── Pagination ────────────────────────────────────────────────────────────────
//
// EXPLICIT, AND DECIDED HERE rather than left to pdfkit's automatic flow.
//
// pdfkit will happily start a new page in the middle of a row: the product name
// lands at the foot of page 1 and its price at the head of page 2, with no table
// head above it. On a document a client is sent, that is a price attached to
// nothing.
//
// So every row's height is measured first, rows are placed only where they FIT
// WHOLE, and each page that carries product rows gets the column head again.

/** A4 at 72dpi, matching the showroom quotation PDF. */
export const PDF_PAGE_HEIGHT = 842
export const PDF_PAGE_WIDTH = 595
export const PDF_MARGIN = 36

/** Reserved at the foot of every page for the rule, the address line and the
 *  page number. Nothing is ever placed inside it. */
export const PDF_FOOTER_HEIGHT = 44

/** The product table's column head, redrawn at the top of every continuation. */
export const PDF_TABLE_HEAD_HEIGHT = 18

/** The tallest a single product row may be. A row that would exceed it is
 *  CLAMPED rather than allowed to overflow a page on its own — its text is
 *  clipped by the renderer, which is a visible truncation rather than a row
 *  that silently vanishes because it fits nowhere. */
export const PDF_MAX_ROW_HEIGHT = 220

/** The floor: a row with a thumbnail is at least this tall. */
export const PDF_IMAGE_ROW_HEIGHT = 64
export const PDF_MIN_ROW_HEIGHT = 22

export type PdfPage = {
  /** 1-based. */
  index: number
  /** The product rows placed on this page, in order. May be empty on a page
   *  that carries only the header or only the totals. */
  rows: PdfProductRow[]
  /** True when this page draws the product table's column head. */
  tableHead: boolean
}

export type PaginationInput = {
  rows: readonly PdfProductRow[]
  /** Vertical space the header block consumes on page 1. */
  firstPageTop: number
  /** Vertical space the header block consumes on a continuation page. */
  laterPageTop: number
  /** Space the commercial summary and payment block need after the last row. */
  tailHeight: number
}

/** How tall one row needs to be, before pagination. Pure, so the tests can pin
 *  it without measuring text in a PDF. */
export function measureRowHeight(row: PdfProductRow, longestText: number): number {
  // Roughly one extra line per 34 characters in the widest wrapping column, at
  // the 7.5pt the renderer uses. Deliberately generous: a row given too much
  // space looks airy, a row given too little collides with the next one.
  const lines = Math.max(1, Math.ceil(longestText / 34))
  const textHeight = PDF_MIN_ROW_HEIGHT + (lines - 1) * 10
  const base = row.hasImage ? Math.max(textHeight, PDF_IMAGE_ROW_HEIGHT) : textHeight
  return Math.min(base, PDF_MAX_ROW_HEIGHT)
}

/** The widest wrapping column's length, which is what decides a row's height. */
export function longestWrappingText(row: PdfProductRow): number {
  return Math.max(row.name.length, row.dimensions.length, row.material.length, row.customization.length)
}

/**
 * Place every product row on a page, whole.
 *
 * GUARANTEES, each of which is asserted by a test:
 *   * every row appears exactly once, in order — none is dropped and none is
 *     duplicated at a boundary;
 *   * no row straddles a page;
 *   * every page carrying rows draws the column head;
 *   * nothing is placed inside the footer band;
 *   * the commercial summary gets its reserved space, on the last page or on a
 *     page of its own.
 */
export function paginateProductRows(input: PaginationInput): PdfPage[] {
  const usableBottom = PDF_PAGE_HEIGHT - PDF_MARGIN - PDF_FOOTER_HEIGHT

  const measured = input.rows.map(row => ({
    ...row,
    height: measureRowHeight(row, longestWrappingText(row)),
  }))

  const pages: PdfPage[] = []
  let page: PdfPage = { index: 1, rows: [], tableHead: measured.length > 0 }
  let y = input.firstPageTop + (measured.length > 0 ? PDF_TABLE_HEAD_HEIGHT : 0)

  for (const row of measured) {
    if (y + row.height > usableBottom) {
      pages.push(page)
      page = { index: pages.length + 1, rows: [], tableHead: true }
      y = input.laterPageTop + PDF_TABLE_HEAD_HEIGHT
    }
    page.rows.push(row)
    y += row.height
  }

  pages.push(page)

  // THE TOTALS GET THEIR OWN PAGE IF THEY DO NOT FIT. A commercial summary split
  // across a page break is the one block on this document that must be read as a
  // whole, and a Grand Total orphaned onto page 3 alone is worse than a short
  // page 2.
  if (y + input.tailHeight > usableBottom && measured.length > 0) {
    pages.push({ index: pages.length + 1, rows: [], tableHead: false })
  }

  return pages
}
