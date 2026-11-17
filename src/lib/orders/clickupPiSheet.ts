// ── DRAFT ORDERS (CLICKUP): THE PI SHEET AS A LIST ─────────────────────────────
//
// Owner, 2026-11-17: an old order's PI Excel should read as a product list, like
// a New Order, instead of being downloaded to be looked at. Only orders numbered
// 300 and up (below that the Excel is kept as a file). Pure: the route reads the
// stored workbook and the page draws what this returns; nothing is saved.
//
// The reader is the PI parser in its `oldOrder` mode (src/lib/pi/legacySheet.ts).
// Nine old orders were never a PI: their Excel is the app's own quotation export
// (one tab "Quotation"), read by src/lib/pi/quotationSheet.ts and drawn by the same
// card with `kind: 'quotation'`. Export sheets (prices in dollars or euros),
// dispatch sheets and repair sheets are neither and are not shown: the page says
// why and the download stays.

import { formatINR } from '@/lib/currency'
import type { QuotationSheet } from '@/lib/pi/quotationSheet'
import type { PiAmountOrText, PiParseResult } from '@/lib/pi/types'
import { dayIst, type DraftFile } from './clickupDrafts'

export const PI_SHEET_FROM_ORDER_NO = 300

/** Orders from 300 up. Anything else (no number, a name with letters) keeps the Excel as a file. */
export function piSheetApplies(orderNo: string | null | undefined): boolean {
  return /^\d{1,6}$/.test(orderNo ?? '') && Number(orderNo) >= PI_SHEET_FROM_ORDER_NO
}

/** The Excel files an order holds, newest upload first (a file with no date goes last). */
export function piSheetCandidates(files: readonly DraftFile[]): DraftFile[] {
  return files
    .filter(f => /\.xlsx$/i.test(f.name))
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (b.f.uploaded_at ?? '').localeCompare(a.f.uploaded_at ?? '') || a.i - b.i)
    .map(x => x.f)
}

export type PiSheetLine = {
  row: number
  code: string | null
  name: string | null
  quantity: number | null
  /** The size of a PI line; the description of a quotation line. */
  size: string | null
  material: string | null
  /** The rate of a PI line; the unit price of a quotation line. */
  rate: number | null
  total: number | null
  /** The customization of a PI line; the notes of a quotation line. */
  customization: string | null
  /** A small picture as a data URL, or null. */
  picture: string | null
}

export type PiSheetParty = { name: string | null; phone: string | null; address: string | null }

export type PiSheetView = {
  /** A PI sheet (the Master tab) or a quotation (the Quotation tab); the card words its headings from this. */
  kind: 'pi' | 'quotation'
  /** The quotation's title line; null for a PI. */
  title: string | null
  /** The PI number, or the quotation's Ref. */
  piNo: string | null
  date: string | null
  salesperson: string | null
  billTo: PiSheetParty
  shipTo: PiSheetParty
  lines: PiSheetLine[]
  totals: { label: string; value: string }[]
  /** Free-text rows under a quotation's totals ("Packing extra - 25000/-"). */
  footnotes: string[]
  /** Plain words about what could not be read; empty when the sheet is sound. */
  problems: string[]
  missingPictures: number
}

const amountOf = (a: PiAmountOrText): string | null => {
  if (a.amount !== null && a.text === null) return formatINR(a.amount)
  if (a.text !== null) return a.text
  return a.amount !== null ? formatINR(a.amount) : null
}

// What the old-order screen says for a blocking code. Picture and sequence issues are not problems here: an old sheet may lack them.
const TOLERATED = new Set(['PRODUCT_IMAGE_REQUIRED', 'PRODUCT_IMAGE_AMBIGUOUS', 'PRODUCT_IMAGE_UNSUPPORTED_FORMAT', 'PRODUCT_ITEM_SEQUENCE_MISSING'])

function problemWords(code: string, row: number, message: string): string {
  switch (code) {
    case 'PRODUCT_NAME_MISSING': return `Row ${row} has no product name.`
    case 'PRODUCT_QUANTITY_INVALID': return `Row ${row} has no valid quantity.`
    case 'PRODUCT_COST_INVALID': return `Row ${row} has no valid price.`
    case 'FOOTER_NOT_FOUND': return 'The totals block could not be found, so no totals are shown.'
    case 'GRAND_TOTAL_MISSING': return 'The grand total is missing from the sheet.'
    default: return message
  }
}

/** What the page draws from one parsed workbook. `pictures` maps a sheet row to its thumbnail. */
export function piSheetViewOf(parsed: Extract<PiParseResult, { ok: true }>, pictures: ReadonlyMap<number, string>): PiSheetView {
  const { header, products, commercial } = parsed.data
  const lines: PiSheetLine[] = products
    .filter(p => p.productName !== null || p.quantity !== null || p.costPerPiece !== null)
    .map(p => ({
      row: p.row,
      code: p.sourceProductCode,
      name: p.productName,
      quantity: p.quantity,
      size: p.dimensions,
      material: p.material,
      rate: p.costPerPiece,
      total: p.lineTotal,
      customization: p.customization,
      picture: pictures.get(p.row) ?? null,
    }))

  const rows: [string, PiAmountOrText | null][] = [
    ['Products', commercial.grossProductAmount > 0 ? { amount: commercial.grossProductAmount, text: null, zeroMeaning: null } as PiAmountOrText : null],
    [commercial.discountLabel?.trim() || 'Discount', commercial.discount > 0 ? { amount: commercial.discount, text: null, zeroMeaning: null } as PiAmountOrText : null],
    ['Subtotal', commercial.subtotalAfterDiscount],
    ['Fabric', commercial.fabricCost],
    ['Packing', commercial.packingCost],
    ['Transport', commercial.transportation],
    ['Total before GST', commercial.totalBeforeGst],
    ['GST', commercial.gst],
    ['Grand total', commercial.grandTotal],
  ]
  const totals = rows.flatMap(([label, a]) => {
    const value = a ? amountOf(a) : null
    return value === null ? [] : [{ label, value }]
  })

  const problems = [...new Set(parsed.blockingIssues.filter(i => !TOLERATED.has(i.code)).map(i => problemWords(i.code, i.row, i.message)))]
  const party = (name: string | null, phone: string | null, address: string | null): PiSheetParty => ({ name, phone, address })
  return {
    kind: 'pi',
    title: null,
    piNo: header.sourceOrderNumber,
    date: header.creationDate ? (header.creationDate.iso ? dayIst(header.creationDate.iso) : header.creationDate.text) : null,
    salesperson: header.createdBy,
    billTo: party(header.billToName, header.billToPhone, header.billingAddress),
    shipTo: party(header.shipToName, header.shipToPhone, header.shippingAddress),
    lines,
    totals,
    footnotes: [],
    problems: problems.length > 6 ? [...problems.slice(0, 6), `…and ${problems.length - 6} more.`] : problems,
    missingPictures: lines.filter(l => l.picture === null).length,
  }
}

const rupees = (n: number) => (n < 0 ? `-${formatINR(-n)}` : formatINR(n))

/** The same card for a quotation's Excel. The totals are the sheet's own, as printed; nothing is recomputed. */
export function piSheetViewOfQuotation(q: QuotationSheet, pictures: ReadonlyMap<number, string>): PiSheetView {
  const lines: PiSheetLine[] = q.lines.map(l => ({
    row: l.row, code: l.code, name: l.name, quantity: l.quantity, size: l.description, material: null,
    rate: l.unitPrice, total: l.total, customization: l.notes, picture: pictures.get(l.row) ?? null,
  }))
  return {
    kind: 'quotation',
    title: q.title,
    piNo: q.ref,
    date: q.date,
    salesperson: null,
    billTo: { name: q.client, phone: null, address: null },
    shipTo: { name: null, phone: null, address: null },
    lines,
    totals: q.totals.map(t => ({ label: t.label, value: rupees(t.amount) })),
    footnotes: q.footnotes,
    problems: q.problems,
    missingPictures: lines.filter(l => l.picture === null).length,
  }
}

/** Why a sheet is not shown as a list, in words for the owner. */
export function piSheetReason(errors: readonly { code: string }[]): string {
  const codes = new Set(errors.map(e => e.code))
  if (codes.has('MASTER_SHEET_MISSING')) return 'This Excel has no PI or Quotation sheet (it may be a dispatch sheet or a repair sheet).'
  if (codes.has('TEMPLATE_FINGERPRINT_MISMATCH')) return 'The columns of this sheet are laid out differently from a BOE PI (for example prices in dollars or euros), so it cannot be shown as a list.'
  if (codes.has('NO_PRODUCT_ROWS')) return 'This PI sheet has no product rows.'
  return 'This Excel could not be read as a PI.'
}
