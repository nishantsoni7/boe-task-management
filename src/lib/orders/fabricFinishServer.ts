// SERVER-SIDE: the Fabric & Finish sheet, with the service role (the table has
// no client policies). Two jobs: the figures for an Edit PI, priced by the same
// pure function the screen uses, and storing what a workbook's two side sheets
// said, pictures included.

import type { AdminSupabaseClient } from '@/lib/supabase/admin'
import type { PiCellPicture } from '@/lib/pi/drawingAnchors'
import type { FabricFinishForProduct, FabricFinishMatch } from '@/lib/pi/fabricFinishSheets'
import { editQuantities, type PiEditState, type SheetCosts } from './piEdit'
import { sheetCostsForEdit, type FabricFinishLine, type FinishEntry, type LineValues } from './fabricFinishCost'
import { MAX_IMAGE_OBJECT_BYTES, sha256Hex } from './submissionPayload'

export const FABRIC_FINISH_LINE_COLUMNS =
  'item_sequence, sheet_read_at, typed_at, '
  + 'sheet_fabric_metres_per_piece, sheet_fabric_price_per_metre, sheet_packing_cost_per_piece, sheet_packing_type, sheet_finish, '
  + 'typed_fabric_metres_per_piece, typed_fabric_price_per_metre, typed_packing_cost_per_piece, typed_packing_type, typed_finish'

type Row = Record<string, unknown>

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

const finishOf = (raw: unknown): FinishEntry[] => (Array.isArray(raw) ? raw : [])
  .flatMap(e => {
    if (!e || typeof e !== 'object') return []
    const o = e as Row
    const heading = typeof o.heading === 'string' ? o.heading : ''
    const value = typeof o.value === 'string' ? o.value : ''
    return heading ? [{ heading, value, imagePath: typeof o.image_path === 'string' ? o.image_path : null }] : []
  })

const valuesOf = (r: Row, prefix: 'sheet_' | 'typed_'): LineValues => ({
  fabricMetresPerPiece: num(r[`${prefix}fabric_metres_per_piece`]),
  fabricPricePerMetre: num(r[`${prefix}fabric_price_per_metre`]),
  packingCostPerPiece: num(r[`${prefix}packing_cost_per_piece`]),
  packingType: typeof r[`${prefix}packing_type`] === 'string' ? (r[`${prefix}packing_type`] as string) : null,
  finish: finishOf(r[`${prefix}finish`]),
})

/** The stored rows as the pure module reads them; quantity is filled in by the caller. */
export function linesFromRows(rows: readonly Row[]): FabricFinishLine[] {
  return rows.map(r => ({
    itemSequence: String(r.item_sequence ?? ''),
    itemId: null,
    productName: null,
    productCode: null,
    quantity: 0,
    sortOrder: 0,
    sheet: r.sheet_read_at ? valuesOf(r, 'sheet_') : null,
    typed: r.typed_at ? valuesOf(r, 'typed_') : null,
    typedByName: null,
    typedAt: null,
  }))
}

/**
 * The Fabric cost and Packing cost the sheet gives for the quantities this
 * edit proposes, or null when the PI has no sheet data (the PI then keeps what
 * it states). A read failure is treated as no data: the edit still prices.
 */
export async function loadSheetCostsForEdit(
  service: AdminSupabaseClient,
  submissionId: string,
  edit: PiEditState,
): Promise<SheetCosts | null> {
  const { data, error } = await service
    .from('order_submission_fabric_finish_lines')
    .select(FABRIC_FINISH_LINE_COLUMNS)
    .eq('submission_id', submissionId)
  if (error || !data || data.length === 0) return null
  const costs = sheetCostsForEdit(linesFromRows(data as unknown as Row[]), editQuantities(edit))
  return costs.hasSheet ? { fabric: costs.fabric, packing: costs.packing } : null
}

// ── What a workbook's side sheets said ────────────────────────────────────────

type SheetFinish = { heading: string; value: string; picture?: PiCellPicture; image_path?: string; image_sha256?: string }

export type SheetLine = {
  item_sequence: string
  fabric_metres_per_piece: number | null
  fabric_price_per_metre: number | null
  packing_cost_per_piece: number | null
  packing_type: string | null
  finish: SheetFinish[]
}

/** One sheet line per Master product that has a stored line and a row on either sheet. */
export function sheetLinesFor(
  match: FabricFinishMatch,
  keyOf: (product: FabricFinishForProduct) => string | null | undefined,
): SheetLine[] {
  return match.products.flatMap(p => {
    const key = keyOf(p)
    if (!key || (!p.cost && !p.finish)) return []
    return [{
      item_sequence: key,
      fabric_metres_per_piece: p.cost?.fabricMetresPerPiece ?? null,
      fabric_price_per_metre: p.cost?.fabricPricePerMetre ?? null,
      packing_cost_per_piece: p.cost?.packingCostPerPiece ?? null,
      packing_type: p.cost?.packingType ?? null,
      finish: (p.finish?.specs ?? []).map(s => ({ heading: s.heading, value: s.value, picture: s.picture })),
    }]
  })
}

/** The line's part of a picture key, as the save function's check allows it. */
const LINE_KEY = /^[A-Za-z0-9._-]{1,60}$/
/** Uploads in flight at once: a workbook repeats one picture across many lines. */
const PICTURE_UPLOADS_AT_ONCE = 6

type StoredPicture = { path: string; sha256: string }

async function storePicture(
  service: AdminSupabaseClient,
  submissionId: string,
  itemSequence: string,
  picture: PiCellPicture,
): Promise<StoredPicture | null> {
  if (!LINE_KEY.test(itemSequence) || picture.bytes.byteLength === 0 || picture.bytes.byteLength > MAX_IMAGE_OBJECT_BYTES) return null
  const sha256 = sha256Hex(picture.bytes)
  const path = `submissions/${submissionId}/fabric-finish/${itemSequence}/${sha256}.${picture.extension}`
  // Content-addressed: the same bytes for the same line are the same key, so a
  // re-read of a workbook is not a second picture.
  const { error } = await service.storage.from('order-files')
    .upload(path, picture.bytes, { contentType: picture.mimeType, upsert: true })
  return error ? null : { path, sha256 }
}

/**
 * Stores the pictures, then the lines. A picture that cannot be stored is
 * dropped and its text is kept: the sheets are optional, so a lost picture is
 * never a reason to lose the rest. Typed values stay (the save function's rule).
 */
export async function saveFabricFinishSheets(
  service: AdminSupabaseClient,
  submissionId: string,
  workbookSha256: string,
  lines: readonly SheetLine[],
): Promise<{ saved: boolean; pictures: number }> {
  const pending = lines.flatMap(line => line.finish.flatMap(entry => (entry.picture ? [{ line, entry }] : [])))
  let pictures = 0
  for (let at = 0; at < pending.length; at += PICTURE_UPLOADS_AT_ONCE) {
    await Promise.all(pending.slice(at, at + PICTURE_UPLOADS_AT_ONCE).map(async ({ line, entry }) => {
      const stored = await storePicture(service, submissionId, line.item_sequence, entry.picture as PiCellPicture)
      if (!stored) return
      entry.image_path = stored.path
      entry.image_sha256 = stored.sha256
      pictures += 1
    }))
  }
  const payload = lines.map(line => ({
    ...line,
    finish: line.finish
      .filter(({ value, image_path }) => value !== '' || image_path)
      .map(({ heading, value, image_path, image_sha256 }) => ({ heading, value, image_path, image_sha256 })),
  }))
  const { error } = await service.rpc('order_submission_fabric_finish_save_sheet', {
    p_submission_id: submissionId, p_workbook_sha256: workbookSha256, p_lines: payload,
  })
  return { saved: !error, pictures }
}
