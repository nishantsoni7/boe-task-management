// ── THE VALUE COLUMN ON CONFIRMED ORDERS IS THE SUBTOTAL ────────────────────
//
// Owner, 2026-10-19: the list's Value is ALWAYS the Subtotal — the products
// minus the discount — and never includes fabric, packing, transport, GST or
// any other amount. (Subtotal = Product value − Discount; Total before GST =
// Subtotal + Fabric + Packing + Transport; Grand Total = Total before GST + GST,
// 20270227000000.)
//
// An Order row stores only total_value, which is the Grand Total. The Subtotal
// lives on the PI the Order was approved from (order_submissions.
// subtotal_after_discount), which a PI revision rewrites when it is applied.
// It is read in the list's ONE query, embedded through
// source_order_submission_id, under the reader's own RLS (an Order viewer may
// read its source PI: can_view_order_submission_via_order, 20260924000000).
//
// THE SAME IDENTITY CHECK AS order_advance_base(): the PI's figure is used
// only while the PI's Grand Total IS the Order's value. If the Order was
// re-valued some other way (a hand amendment), that PI subtotal no longer
// describes it, and the Order's own product value is the best figure there is.
// No source PI (an Order from before PIs) — the same product value. Nothing
// known at all — null, drawn as a dash and sorted last.

import { effectiveSampleType, type SampleType } from './sampleType'

export type SourcePiFigures = {
  subtotal_after_discount: number | string | null
  grand_total: number | string | null
} | null

export type OrderListValueInput = {
  total_value: number | string | null
  total_product_value: number | string | null
  source_pi: SourcePiFigures | SourcePiFigures[] | undefined
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || String(v).trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function orderListSubtotal(o: OrderListValueInput): number | null {
  // PostgREST returns a to-one embed as an object; be tolerant of an array.
  const pi = Array.isArray(o.source_pi) ? (o.source_pi[0] ?? null) : (o.source_pi ?? null)
  const subtotal = num(pi?.subtotal_after_discount)
  const piGrand = num(pi?.grand_total)
  const orderValue = num(o.total_value)
  if (subtotal !== null && subtotal >= 0 && piGrand !== null && orderValue !== null
      && Math.round(piGrand * 100) === Math.round(orderValue * 100)) {
    return subtotal
  }
  return num(o.total_product_value)
}

// ── THE OTHER LIST FACTS (owner, 2026-10-19) ─────────────────────────────────
//
// Two icons beside the Project code, both read from the same source-PI embed:
//   Sample      sampling needed / sample order only — the Order's own choice,
//               else the PI's, else the legacy "Sample order" advance reason
//               (effectiveSampleType in sampleType.ts, 20270320000000).
//   Commission  the PI answered "Yes" to the middleman commission. That row is
//               in its own reader-only table (20270122000000 §1b): a reader RLS
//               does not admit gets no row, so no icon — never a false "No".
// Factory Status is the Order's production alignment: 'aligned' once the
// operations team accepts the PI for production, else not aligned.

/** Named, so the list's select and its tests name the same columns. */
export const ORDER_LIST_SOURCE_PI_EMBED =
  'source_pi:order_submissions!source_order_submission_id(subtotal_after_discount, grand_total, advance_exception_reason_code, sample_type, commission:order_submission_middleman_commissions(middleman_commission))'

type CommissionEmbed = { middleman_commission: string | null } | null

type SourcePiFlags = SourcePiFigures & {
  advance_exception_reason_code?: string | null
  sample_type?: string | null
  commission?: CommissionEmbed | CommissionEmbed[]
}

export type OrderListFlagsInput = {
  sample_type?: string | null
  sample_type_set_at?: string | null
  source_pi: SourcePiFlags | null | undefined | SourcePiFlags[]
}

export function orderListFlags(o: OrderListFlagsInput): { sample: SampleType | null; commission: boolean } {
  const pi = Array.isArray(o.source_pi) ? (o.source_pi[0] ?? null) : (o.source_pi ?? null)
  const c = Array.isArray(pi?.commission) ? (pi?.commission[0] ?? null) : (pi?.commission ?? null)
  return {
    sample: effectiveSampleType({
      orderSampleType: o.sample_type,
      orderSampleTypeSetAt: o.sample_type_set_at,
      piSampleType: pi?.sample_type,
      piAdvanceReasonCode: pi?.advance_exception_reason_code,
    }),
    commission: String(c?.middleman_commission ?? '').trim().toLowerCase() === 'yes',
  }
}

// The short word the Order page already uses (owner, 2026-10-31): the column
// heading says it is about the factory, so the value need not say it again.
export const FACTORY_ALIGNED_LABEL = 'Aligned'
export const FACTORY_NOT_ALIGNED_LABEL = 'Not Aligned'
export const COMMISSION_ICON_LABEL = 'Middleman commission'

export function factoryStatus(productionAlignment: string | null | undefined): { aligned: boolean; label: string } {
  const aligned = productionAlignment === 'aligned'
  return { aligned, label: aligned ? FACTORY_ALIGNED_LABEL : FACTORY_NOT_ALIGNED_LABEL }
}

// ── PROJECT CODE ORDER AND THE CANCELLED GAP (owner, 2026-10-31) ─────────────
//
// The list runs by project code, highest on top, whenever each PI was uploaded.
// A cancelled Order keeps its code for good and that code is never given to
// another Order, so it stays in the sequence as a gap: the code, the word
// cancelled and who it was, with none of the other columns drawn.

// display_number is four numeric digits (20260704), but sort defensively so a
// legacy or unexpected value orders predictably instead of collapsing to NaN.
export function compareOrderNumber(a: string, b: string): number {
  const na = Number(a), nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  return a.localeCompare(b)
}

export const CANCELLED_ORDER_LABEL = 'Cancelled order'

export function cancelledOrderGapText(clientName: string | null | undefined): string {
  const client = (clientName ?? '').trim()
  return client ? `${CANCELLED_ORDER_LABEL} · ${client}` : CANCELLED_ORDER_LABEL
}
