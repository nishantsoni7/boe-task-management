// ── BDPI: an OLD order's PI workbook turned into what create_bdpi takes ───────
//
// Owner, 2026-10-29: the 50+ old orders were never uploaded as Orders. Their
// PI workbooks (the same Master format) are uploaded as "BDPI" records so the
// Payment plan can run for them. This decides, from the parser's answer alone,
// what is kept and what refuses the upload. Pure: no I/O.
//
// THE SAME PARSER, A LITTLE MORE FORGIVING. A missing or odd picture, or a
// missing hidden item sequence, does not refuse an old order — the plan does
// not need them (a line without a sequence is keyed by its sheet row). Every
// other blocking issue (a product without a name, quantity or price; a footer
// that cannot be found; totals that do not add up) still refuses it.
//
// COMPLETE DETAILS (owner): the fabric / packing / transport figures (or the
// words in those cells), who supplies the fabric, the terms note, and per line
// size, material, customization and the Fabric & Finish sheets' figures and
// specs (which fabric / finish was chosen).

import type { PiParseResult, PiProductImage } from '@/lib/pi/types'
import { matchFabricFinishSheets } from '@/lib/pi/fabricFinishSheets'

/** Blocking codes an old order may carry and still be recorded. */
export const BDPI_TOLERATED_BLOCKING = new Set([
  'PRODUCT_IMAGE_REQUIRED',
  'PRODUCT_IMAGE_AMBIGUOUS',
  'PRODUCT_IMAGE_UNSUPPORTED_FORMAT',
  'PRODUCT_ITEM_SEQUENCE_MISSING',
])

/** Picture formats the order-files bucket accepts. */
const STORABLE = new Set(['png', 'jpeg', 'webp'])

export type BdpiItemPayload = {
  item_sequence: string
  product_name: string | null
  quantity: number
  rate: number
  line_total: number | null
  dimensions: string | null
  material: string | null
  customization: string | null
  fabric_metres_per_piece: number | null
  fabric_price_per_metre: number | null
  packing_cost_per_piece: number | null
  packing_type: string | null
  finish_specs: { heading: string; value: string }[]
}

export type BdpiPayload = {
  old_order_no: string
  client_name: string
  workbook_name: string | null
  fabric_responsibility: 'boe' | 'client' | 'not_selected' | null
  commercial_terms_note: string | null
  commercial: {
    gross_product_amount: number | null
    discount_amount: number | null
    subtotal_after_discount: number | null
    fabric_cost: number | null
    fabric_cost_text: string | null
    packing_cost: number | null
    packing_cost_text: string | null
    transportation_amount: number | null
    transportation_text: string | null
    total_before_gst: number | null
    gst_amount: number | null
    grand_total: number | null
  }
  items: BdpiItemPayload[]
}

export type BdpiPicture = { itemSequence: string; image: PiProductImage }

export type BdpiFromWorkbook =
  | { ok: true; payload: BdpiPayload; pictures: BdpiPicture[]; notes: string[] }
  | { ok: false; reason: string }

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t === '' ? null : t
}

/**
 * The workbook as a BDPI. `typed` wins over what the workbook says: the old
 * order number (else Master B20) and the client (else the Bill-to name).
 */
export function bdpiFromWorkbook(
  parsed: PiParseResult,
  typed: { oldOrderNo?: string | null; clientName?: string | null; workbookName?: string | null },
): BdpiFromWorkbook {
  if (!parsed.ok) {
    return { ok: false, reason: `This file could not be read as a BOE PI (${parsed.errors.map(e => e.code).join(', ')}).` }
  }
  const refusing = parsed.blockingIssues.filter(i => !BDPI_TOLERATED_BLOCKING.has(i.code))
  if (refusing.length > 0) {
    const where = refusing.slice(0, 3).map(i => (i.row ? `row ${i.row}` : i.cell ?? i.code)).join(', ')
    return { ok: false, reason: `The PI has problems to fix first: ${[...new Set(refusing.map(i => i.code))].join(', ')} (${where}).` }
  }

  const w = parsed.data
  const oldOrderNo = clean(typed.oldOrderNo) ?? clean(w.header.sourceOrderNumber)
  if (!oldOrderNo) return { ok: false, reason: 'Type the old order number: the PI does not carry one.' }
  const clientName = clean(typed.clientName) ?? clean(w.header.billToName) ?? clean(w.header.shipToName)
  if (!clientName) return { ok: false, reason: 'Type the client name: the PI does not carry one.' }
  if (w.products.length === 0) return { ok: false, reason: 'The PI has no product lines.' }
  if (!(w.commercial.totalBeforeGst.amount && w.commercial.totalBeforeGst.amount > 0)) {
    return { ok: false, reason: 'The PI has no total before GST.' }
  }

  const ff = w.fabricFinish ? matchFabricFinishSheets(w.fabricFinish, w.products) : null
  const ffByRow = new Map((ff?.products ?? []).map(p => [p.productRow, p]))

  const used = new Set<string>()
  const items: BdpiItemPayload[] = []
  const pictures: BdpiPicture[] = []
  const notes: string[] = []
  let unstorable = 0
  for (const p of w.products) {
    if (p.quantity === null || p.costPerPiece === null) {
      return { ok: false, reason: `Row ${p.row} has no quantity or price.` }
    }
    let seq = clean(p.itemSequence) ?? `R${p.row}`
    if (used.has(seq)) seq = `${seq}-R${p.row}`
    used.add(seq)
    const match = ffByRow.get(p.row)
    items.push({
      item_sequence: seq,
      product_name: clean(p.productName),
      quantity: p.quantity,
      rate: p.costPerPiece,
      line_total: p.lineTotal,
      dimensions: clean(p.dimensions),
      material: clean(p.material),
      customization: clean(p.customization),
      fabric_metres_per_piece: match?.cost?.fabricMetresPerPiece ?? null,
      fabric_price_per_metre: match?.cost?.fabricPricePerMetre ?? null,
      packing_cost_per_piece: match?.cost?.packingCostPerPiece ?? null,
      packing_type: clean(match?.cost?.packingType),
      finish_specs: (match?.finish?.specs ?? []).map(s => ({ heading: s.heading, value: s.value })),
    })
    const img = p.representativeImage
    if (img && STORABLE.has(img.format)) pictures.push({ itemSequence: seq, image: img })
    else if (img) unstorable += 1
  }
  if (unstorable > 0) notes.push(`${unstorable} picture(s) are in a format that cannot be stored and were left out.`)
  const missing = items.length - pictures.length - unstorable
  if (missing > 0) notes.push(`${missing} line(s) have no picture in the PI.`)

  const c = w.commercial
  return {
    ok: true,
    payload: {
      old_order_no: oldOrderNo,
      client_name: clientName,
      workbook_name: clean(typed.workbookName),
      fabric_responsibility: w.piTerms.fabricResponsibility,
      commercial_terms_note: clean(w.piTerms.commercialTermsNote),
      commercial: {
        gross_product_amount: c.grossProductAmount,
        discount_amount: c.discount,
        subtotal_after_discount: c.subtotalAfterDiscount.amount,
        fabric_cost: c.fabricCost.amount,
        fabric_cost_text: clean(c.fabricCost.text),
        packing_cost: c.packingCost.amount,
        packing_cost_text: clean(c.packingCost.text),
        transportation_amount: c.transportation.amount,
        transportation_text: clean(c.transportation.text),
        total_before_gst: c.totalBeforeGst.amount,
        gst_amount: c.gst.amount,
        grand_total: c.grandTotal.amount,
      },
      items,
    },
    pictures,
    notes,
  }
}

/** The storage key of a BDPI line's picture: bdpi/<id>/items/<safe sequence>.<ext>. */
export function bdpiPicturePath(bdpiId: string, itemSequence: string, image: Pick<PiProductImage, 'format'>): string {
  const safe = itemSequence.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60) || 'line'
  const ext = image.format === 'jpeg' ? 'jpg' : image.format
  return `bdpi/${bdpiId}/items/${safe}.${ext}`
}

export const bdpiWorkbookPath = (bdpiId: string) => `bdpi/${bdpiId}/workbook.xlsx`

/** Plain words for the database's refusals at upload. */
export function describeBdpiError(message: string): string {
  if (/BDPI_OLD_ORDER_EXISTS/.test(message)) return 'A BDPI for this old order number already exists.'
  if (/PAYMENT_PLAN_FORBIDDEN/.test(message)) return 'You do not have access to create a BDPI. An Admin can grant "Edit Payment plan".'
  if (/BDPI_OLD_ORDER_REQUIRED/.test(message)) return 'Type the old order number.'
  if (/BDPI_CLIENT_REQUIRED/.test(message)) return 'Type the client name.'
  if (/BDPI_TOTAL_REQUIRED/.test(message)) return 'The PI has no total before GST.'
  if (/BDPI_ITEM_INVALID/.test(message)) return 'A product line has a quantity or price the app cannot store (more than two decimals?).'
  return 'The BDPI could not be saved. Please try again.'
}
