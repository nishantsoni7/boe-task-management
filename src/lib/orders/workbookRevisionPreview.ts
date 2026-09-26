// ── A REVISED PI WORKBOOK, READ FOR THE ADMIN BEFORE THEY APPROVE IT ──────────
//
// An edited version carries its proposed PI; a revised WORKBOOK does not — the
// server reads it only when an Admin approves (process-draft under the
// approval lease, 20270116000000). Approval puts it in force at once and
// amends the Order, so the Admin must see what they are approving first: which
// lines change, which are added or removed, and the new totals.
//
// This reads the same workbook with the same parser in the Admin's browser and
// maps it the way the approval does:
//
//   * THE FIGURES AND HEADER the approval REPLACES come from the workbook —
//     the fields buildSubmissionPlan() writes as the submission's parse
//     (header, dates, commercial totals).
//   * THE TERMS the approval KEEPS — city, fabric, payment and billing terms,
//     the terms note, billing % — are carried from the PI in force, so they
//     never show as a change the approval will not make.
//   * LINES CONTINUE BY ITEM NUMBER (column J), exactly as
//     approve_order_pi_revision() matches them: the same number, upper-cased
//     and trimmed, unique on both sides. A blank or repeated number is one the
//     approval will ask the Admin to match; a number not in force is a new
//     product; a line in force with no continuation is removed.
//
// It is a preview. The server parses the workbook again when the Admin
// approves, and that parse is what is applied.

import type { PiAmountOrText, PiProductImage, PiWorkbook } from '@/lib/pi/types'
import { creationDateIso } from '@/lib/pi/masterSheetParser'
import { plausibleDueDate } from './dueDate'
import { percentText, rupees } from './advanceReadiness'
import { normalizePi, type NormalizedPi, type PiContent, type PiContentImage, type PiContentItem } from './piEdit'

/** Fields a workbook revision does not set; the approval keeps what is in force. */
export const WORKBOOK_REVISION_KEPT_FIELDS = [
  'client_city', 'fabric_responsibility', 'billing_percentage',
  'payment_terms', 'billing_terms', 'commercial_terms_note',
] as const

export type WorkbookLineReview = { name: string; sequence: string | null; why: 'no item number' | 'item number used more than once' }

export type WorkbookRevisionPreview = {
  pi: NormalizedPi
  /** Lines the approval will ask the Admin to match (blank or repeated item number). */
  needsReview: WorkbookLineReview[]
}

const text = (v: string | null | undefined): string | null => {
  const t = v?.trim()
  return t ? t : null
}
const seqKey = (v: string | null | undefined): string | null => {
  const t = v?.trim().toUpperCase()
  return t ? t : null
}
const amount = (v: PiAmountOrText | null | undefined): number | null => v?.amount ?? null

/**
 * What approving a proposed version does to the 40% position, in one sentence —
 * or null when the verified advance still covers the proposed value (or either
 * figure is unknown). Approval opens the hold (20270116000000); this says so first.
 */
export function approvalAdvanceNote(verified: number | null, newGrandTotal: number | null, thresholdPercent = 40): string | null {
  if (verified === null || newGrandTotal === null || !(newGrandTotal > 0)) return null
  const required = Math.round(newGrandTotal * thresholdPercent) / 100
  if (verified >= required) return null
  return `Approving this puts production on hold: the verified ${rupees(verified)} is ${percentText(verified / newGrandTotal * 100)} of the new ${rupees(newGrandTotal)}. ${rupees(Math.round((required - verified) * 100) / 100)} more must be verified, or production approved below ${thresholdPercent}%, before Operations can align it.`
}

/** Lower-case hex SHA-256, as order_submission_item_images.sha256 stores it. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function previewWorkbookRevision(
  workbook: PiWorkbook,
  current: PiContent,
  hash: (bytes: Uint8Array) => Promise<string> = sha256Hex,
): Promise<WorkbookRevisionPreview> {
  const h = workbook.header
  const c = workbook.commercial
  const cur = current.submission

  // ── Header and figures: what the approval writes from the workbook ──
  const confirmation = h.orderConfirmationDate?.iso ?? null
  const created = creationDateIso(h) ?? (cur.creation_date as string | null) ?? null
  const submission: Record<string, unknown> = {
    ...cur,
    client_name: text(h.billToName),
    creation_date: created,
    // A blank cell is filled from the salesperson's number on approval; the
    // preview keeps the number in force rather than show a blank as a change.
    contact_number: text(h.contactNumber) ?? cur.contact_number ?? null,
    bill_to_name: text(h.billToName),
    bill_to_phone: text(h.billToPhone),
    bill_to_gst: text(h.billToGst),
    billing_address: text(h.billingAddress),
    ship_to_name: text(h.shipToName),
    ship_to_phone: text(h.shipToPhone),
    ship_to_gst: text(h.shipToGst),
    shipping_address: text(h.shippingAddress),
    order_confirmation_date: confirmation,
    dispatch_commitment: text(h.dispatchCommitment?.text ?? null),
    due_date: plausibleDueDate({
      candidate: h.dispatchCommitment?.iso ?? h.dispatchCommitment?.text ?? null,
      orderConfirmationDate: confirmation,
      creationDate: h.creationDate?.iso ?? null,
    }),
    gross_product_amount: c.grossProductAmount,
    discount_amount: c.discount,
    total_before_gst: amount(c.totalBeforeGst),
    gst_amount: amount(c.gst),
    grand_total: amount(c.grandTotal),
  }
  for (const key of WORKBOOK_REVISION_KEPT_FIELDS) submission[key] = cur[key] ?? null

  // ── Lines: continue by item number, exactly as the approval does ──
  const inForceBySeq = new Map<string, PiContentItem[]>()
  for (const item of current.items) {
    const k = seqKey(item.item_sequence)
    if (k) inForceBySeq.set(k, [...(inForceBySeq.get(k) ?? []), item])
  }
  const revisedSeqCount = new Map<string, number>()
  for (const p of workbook.products) {
    const k = seqKey(p.itemSequence)
    if (k) revisedSeqCount.set(k, (revisedSeqCount.get(k) ?? 0) + 1)
  }

  const photoInForce = new Map(current.images.filter(m => m.role === 'representative').map(m => [m.item_id, m]))
  const repByRow = new Map<number, PiProductImage>()
  for (const img of workbook.representativeImages) repByRow.set(img.row, img)

  const needsReview: WorkbookLineReview[] = []
  const items: PiContentItem[] = []
  const images: PiContentImage[] = []

  for (const [index, p] of workbook.products.entries()) {
    const k = seqKey(p.itemSequence)
    let continues: PiContentItem | null = null
    if (!k) {
      needsReview.push({ name: p.productName ?? `Row ${p.row}`, sequence: null, why: 'no item number' })
    } else if ((revisedSeqCount.get(k) ?? 0) > 1 || (inForceBySeq.get(k)?.length ?? 0) > 1) {
      needsReview.push({ name: p.productName ?? `Row ${p.row}`, sequence: p.itemSequence, why: 'item number used more than once' })
    } else {
      continues = inForceBySeq.get(k)?.[0] ?? null
    }
    // A line with no continuation gets an id the PI in force cannot have, so
    // the comparison shows it as added — and the in-force line as removed.
    const id = continues?.id ?? `workbook-row-${p.row}`
    items.push({
      id,
      source_row: p.row,
      item_sequence: p.itemSequence,
      source_product_code: p.sourceProductCode,
      product_name: p.productName,
      quantity: p.quantity,
      dimensions: p.dimensions,
      material: p.material,
      customization: p.customization,
      cost_per_piece: p.costPerPiece,
      total_amount: p.lineTotal ?? ((p.quantity ?? 0) * (p.costPerPiece ?? 0)),
      sort_order: index,
    })

    // THE PHOTO, compared by content: the same picture keeps the path in force
    // (no change shown); a different one is marked as a new photo.
    const rep = repByRow.get(p.row) ?? p.representativeImage
    if (rep) {
      const sha = await hash(rep.bytes)
      const before = continues ? photoInForce.get(continues.id) : undefined
      images.push({
        item_id: id, role: 'representative', position: 0,
        storage_path: before && before.sha256 === sha ? before.storage_path : `workbook-photo:${sha}`,
        mime_type: null, sha256: sha, anchor_row: p.row,
      })
    }
  }

  return { pi: normalizePi({ submission, items, images }), needsReview }
}
