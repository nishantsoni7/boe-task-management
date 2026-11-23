// Pricing > Training, "In your words" (Price Brain v2, phase 1 part 2; owner, 23 Nov 2026): a pricing note becomes rows
// of a case. The drafting service only copies numbers out of the note (draftPrompt.ts); everything here is pure: the
// answer is cut down to the asked-for shape, turned into rows the person checks, and the rows' sum is compared with
// the price the note states. Nothing counts until the person saves and submits the case.

import { KINDS, emptyLine, type CaseForm, type Kind, type Line } from './doc'
import type { Faces } from './calc'

export type DraftRow = {
  element: string; kind: Kind; way: 'amount' | 'qty_rate' | 'area' | 'percent'
  amount: number | null; quantity: number | null; unit: string; rate: number | null
  faces: Faces | null; pct: number | null; of: 'cost' | 'above'; reasoning: string
}
export type Draft = { rows: DraftRow[]; statedTotal: number | null; width: number | null; depth: number | null; height: number | null; perSet: number | null; missing: string[] }

const MAX_ROWS = 30
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
/** A positive finite number, or null (0 means "not in the note"). */
const pos = (v: unknown, max = 1e8) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < max ? v : null)
const one = <T extends string>(v: unknown, allowed: readonly T[]): T | null => (allowed.includes(v as T) ? (v as T) : null)

/** Keep only the shape asked for; a row that cannot be used is dropped. Null when nothing usable came back. */
export function parseDraft(input: unknown): Draft | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  const rows = (Array.isArray(o.rows) ? o.rows : []).slice(0, MAX_ROWS).flatMap((r): DraftRow[] => {
    if (!r || typeof r !== 'object') return []
    const x = r as Record<string, unknown>
    const element = text(x.element, 120)
    const way = one(x.way, ['amount', 'qty_rate', 'area', 'percent'] as const)
    if (!element || !way) return []
    const row: DraftRow = {
      element, kind: one(x.kind, KINDS) ?? 'other', way,
      amount: pos(x.amount), quantity: pos(x.quantity, 1e6), unit: text(x.unit, 30), rate: pos(x.rate),
      faces: one(x.faces, ['top', 'top_sides', 'all'] as const), pct: pos(x.pct, 1000), of: one(x.of, ['cost', 'above'] as const) ?? 'cost',
      reasoning: text(x.reasoning, 300),
    }
    // A row needs the numbers of its own way, or it is not a row of the note.
    const usable = way === 'amount' ? row.amount !== null : way === 'qty_rate' ? row.quantity !== null && row.rate !== null
      : way === 'area' ? row.faces !== null && row.rate !== null : row.pct !== null
    return usable ? [row] : []
  })
  const missing = (Array.isArray(o.missing) ? o.missing : []).slice(0, 8).map(m => text(m, 200)).filter(Boolean)
  const perSet = typeof o.per_set === 'number' && Number.isInteger(o.per_set) && o.per_set >= 2 && o.per_set <= 50 ? o.per_set : null
  if (rows.length === 0 && missing.length === 0) return null
  return { rows, statedTotal: pos(o.stated_total), width: pos(o.width_in, 1000), depth: pos(o.depth_in, 1000), height: pos(o.height_in, 1000), perSet, missing }
}

const str = (v: number | null) => (v === null ? '' : String(v))

/** The draft as rows of a case: an area or a percentage keeps its rule (calc), the rest are amounts or quantity × rate. */
export function draftToLines(d: Draft): Line[] {
  return d.rows.map(r => {
    const base: Line = { ...emptyLine(), element: r.element, kind: r.kind, reasoning: r.reasoning, from_ai: true }
    switch (r.way) {
      case 'amount': return { ...base, amount: str(r.amount) }
      case 'qty_rate': return { ...base, quantity: str(r.quantity), unit: r.unit, rate: str(r.rate) }
      case 'area': return { ...base, calc: { type: 'area', faces: r.faces ?? 'top', rate: str(r.rate) } }
      case 'percent': return { ...base, calc: { type: 'percent', pct: str(r.pct), of: r.of } }
    }
  })
}

/** What the draft fills on the case, only where the case is still blank. */
export function draftForm(d: Draft, form: CaseForm): Partial<CaseForm> {
  const blank = (k: 'width_in' | 'depth_in' | 'height_in' | 'sold_price' | 'per_set') => !form[k].trim()
  const out: Partial<CaseForm> = {}
  if (d.width && blank('width_in')) out.width_in = str(d.width)
  if (d.depth && blank('depth_in')) out.depth_in = str(d.depth)
  if (d.height && blank('height_in')) out.height_in = str(d.height)
  if (d.statedTotal && blank('sold_price')) out.sold_price = str(d.statedTotal)
  if (d.perSet && blank('per_set')) out.per_set = str(d.perSet)
  return out
}

/** How far the rows' sum is from the price given. Within 1% is taken as rounding (the owner rounds 17,449 to 17,500). */
export function priceCheck(total: number, price: number | null): { pct: number; ok: boolean } | null {
  if (!price || !(total > 0)) return null
  const pct = Math.abs(total - price) / price * 100
  return { pct: Math.round(pct * 10) / 10, ok: pct <= 1 }
}
