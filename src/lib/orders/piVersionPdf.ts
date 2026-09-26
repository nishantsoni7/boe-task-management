// ── One PI version's PDF, from that version's own content (20270116000000) ────
//
// The Confirmed PDF is rendered from rows, never from the uploaded workbook
// (confirmedPdf.ts). So any version can be printed as it was, provided we know
// what it contained:
//
//   live       the version in force — the PI's current rows
//   captured   a replaced version — the content captured the moment a later
//              version replaced it (order_pi_version_contents), codes included
//   proposal   an edit revision not (yet) in force — its server-built proposal
//   staged     a workbook revision an admin approved under #205's staging
//
// 'snapshot' and 'none' (a version replaced before content was captured) carry
// no header, terms or pictures: printing one would invent a document, so it is
// refused in words instead.
//
// Pure: the route does the reading and the rendering.

import type { OrderPiRow } from './orderPiHandoff'
import type { PersistedItem } from './draftsView'
import { formatOrderProductCode } from './orderProductCodes'
import { isCanonicalPiImageKey } from './piImageKey'

export type PiVersionDetail = { source: string; content: unknown }

export type PiVersionPdfSource =
  | {
      ok: true
      submission: OrderPiRow
      items: PersistedItem[]
      /** Representative picture per item id (a storage key). */
      pictureByItem: Map<string, string>
      /** The BOE code per item id, as the version itself held them. */
      productCodes: Map<string, string>
    }
  | { ok: false; code: 'VERSION_CONTENT_NOT_RECORDED'; message: string }

type Row = Record<string, unknown>

const obj = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {})
const arr = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : [])
const str = (v: unknown): string | null => (typeof v === 'string' ? v : v == null ? null : String(v))

export const VERSION_CONTENT_NOT_RECORDED =
  'This version was replaced before the app recorded what each version contained, so its PDF cannot be produced. Its uploaded workbook, if it had one, is still available.'

function toItems(rows: Row[]): PersistedItem[] {
  return rows
    .map((r, n) => ({
      id: String(r.id ?? ''),
      source_row: Number(r.source_row ?? n + 1),
      item_sequence: str(r.item_sequence),
      source_product_code: str(r.source_product_code),
      product_name: str(r.product_name),
      quantity: (r.quantity ?? null) as number | string | null,
      dimensions: str(r.dimensions),
      material: str(r.material),
      customization: str(r.customization),
      cost_per_piece: (r.cost_per_piece ?? null) as number | string | null,
      total_amount: (r.total_amount ?? null) as number | string | null,
      sort_order: Number(r.sort_order ?? n),
    }))
    .filter(i => i.id !== '')
    .sort((a, b) => a.sort_order - b.sort_order || a.source_row - b.source_row)
}

function pictures(rows: Row[], submissionId: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of rows) {
    if (m.role !== 'representative') continue
    const item = str(m.item_id)
    const path = str(m.storage_path)
    // Only THIS PI's canonical key for THIS line is ever read — the whole key,
    // never a prefix: a "../" inside one would reach any object in any bucket.
    if (!item || !path || out.has(item)
        || !isCanonicalPiImageKey(path, { submissionId, itemId: item, role: 'representative' })) continue
    out.set(item, path)
  }
  return out
}

/**
 * The PDF inputs for a version that is NOT the one in force. `live` is read
 * by the caller from the PI's rows; everything else comes from `detail`.
 */
export function piVersionPdfSource(input: {
  detail: PiVersionDetail
  submissionId: string
  orderDisplayNumber: string
  /** Item id → code for the lines that still hold one (a proposal's continuing lines). */
  liveCodes: ReadonlyMap<string, string>
}): PiVersionPdfSource {
  const { detail, submissionId } = input
  const c = obj(detail.content)

  if (detail.source === 'captured') {
    const items = toItems(arr(c.items))
    const codes = new Map<string, string>()
    for (const [itemId, seq] of Object.entries(obj(c.codes))) {
      const code = formatOrderProductCode(input.orderDisplayNumber, Number(seq))
      if (code) codes.set(itemId, code)
    }
    return {
      ok: true,
      submission: { id: submissionId, ...obj(c.submission) } as unknown as OrderPiRow,
      items,
      pictureByItem: pictures(arr(c.images), submissionId),
      productCodes: codes,
    }
  }

  if (detail.source === 'proposal' || detail.source === 'staged') {
    const payload = obj(c.payload)
    const items = toItems(arr(payload.items))
    const codes = new Map<string, string>()
    for (const i of items) {
      const code = input.liveCodes.get(i.id)
      if (code) codes.set(i.id, code)
    }
    return {
      ok: true,
      submission: {
        id: submissionId,
        ...obj(payload.header),
        ...obj(payload.commercial),
        ...obj(c.terms),
        // An edited version has no workbook of its own; never print V1's.
        source_workbook_name: null,
        source_workbook_path: null,
      } as unknown as OrderPiRow,
      items,
      pictureByItem: pictures(arr(payload.item_images), submissionId),
      productCodes: codes,
    }
  }

  return { ok: false, code: 'VERSION_CONTENT_NOT_RECORDED', message: VERSION_CONTENT_NOT_RECORDED }
}

// ── The actions, named for what they are ─────────────────────────────────────

/** The PDF is generated from the version's details — never the uploaded workbook. */
export const PI_VERSION_PDF_VIEW_LABEL = (versionNumber: number) => `View PI V${versionNumber} (PDF)`
export const PI_VERSION_PDF_DOWNLOAD_LABEL = 'Download PDF'
/** The uploaded .xlsx is a separate thing, and says so. */
export const PI_UPLOADED_WORKBOOK_LABEL = 'Uploaded workbook (.xlsx)'
export const PI_EDITED_VERSION_WORKBOOK_NOTE = (versionNumber: number) =>
  `V${versionNumber} was edited in the app and has no workbook of its own. Its PDF is generated from its details; the uploaded workbook belongs to V1.`

export function piVersionPdfHref(orderId: string, versionId: string, download: boolean): string {
  return `/api/orders/${orderId}/pi-versions/${versionId}/pdf${download ? '?download=1' : ''}`
}

/** "Order-524-PI-V2.pdf" — a filename a person can recognise in Downloads. */
export function piVersionPdfFilename(orderNumber: string, versionNumber: number): string {
  const safe = orderNumber.replace(/[^0-9A-Za-z-]/g, '') || 'Order'
  return `Order-${safe}-PI-V${versionNumber}.pdf`
}
