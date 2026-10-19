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

export type SourcePiFigures = {
  subtotal_after_discount: number | string | null
  grand_total: number | string | null
} | null

export type OrderListValueInput = {
  total_value: number | string | null
  total_product_value: number | string | null
  source_pi: SourcePiFigures | SourcePiFigures[] | undefined
}

/** Named, so the list's select and its tests name the same columns. */
export const ORDER_LIST_SOURCE_PI_EMBED =
  'source_pi:order_submissions!source_order_submission_id(subtotal_after_discount, grand_total)'

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
