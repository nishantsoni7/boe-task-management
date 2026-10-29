// SERVER-SIDE: the Fabric & Finish sheet's figures for an Edit PI, read with
// the service role (the table has no client policies) and priced by the same
// pure function the screen uses. Nothing here writes.

import type { AdminSupabaseClient } from '@/lib/supabase/admin'
import { editQuantities, type PiEditState, type SheetCosts } from './piEdit'
import { sheetCostsForEdit, type FabricFinishLine, type FinishEntry, type LineValues } from './fabricFinishCost'

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
