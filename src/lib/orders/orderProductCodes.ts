/**
 * BOE operational Order numbers and permanent item codes — the TS mirror of
 * order_operational_number(text) and the BE-code format assigned by
 * assign_order_product_codes() (migration 20261124000000).
 *
 * The STORED Order number (orders.display_number, e.g. "0524") never changes:
 * its four-digit, zero-padded shape, its CHECK constraint and its uniqueness
 * are all untouched. What changed is what a human is shown — "524", not
 * "0524" — and this file is the one place that formatting happens on the
 * client, so the SQL and TS sides cannot drift apart.
 */

/** '0524' → '524'. Mirrors order_operational_number(text) exactly: null in,
 *  null out; a value with no non-zero digit reads as null rather than ''. */
export function formatOrderOperationalNumber(displayNumber: string | null | undefined): string | null {
  if (displayNumber === null || displayNumber === undefined) return null
  const stripped = displayNumber.replace(/^0+/, '')
  return stripped === '' ? null : stripped
}

/** 1 → 'BE001'. */
export function formatBoeItemCode(boeSequence: number): string {
  return `BE${String(boeSequence).padStart(3, '0')}`
}

/** ('0524', 1) → '524-BE001'. Null when the Order has no display number yet —
 *  which never happens for a Confirmed Order, only guards a caller that asks
 *  before one exists. */
export function formatOrderProductCode(
  displayNumber: string | null | undefined,
  boeSequence: number,
): string | null {
  const operational = formatOrderOperationalNumber(displayNumber)
  if (operational === null) return null
  return `${operational}-${formatBoeItemCode(boeSequence)}`
}

/** One row of public.order_product_codes, shaped the way a `select` off that
 *  table already returns it — snake_case, exactly as PostgREST hands it back. */
export type OrderProductCodeRecord = {
  submission_item_id: string | null
  boe_sequence: number
  source_product_code: string | null
  source_item_sequence: string | null
}

/** The composed Order Product Code for every CURRENT item, keyed by the item's
 *  own id. An item whose code row has gone orphaned (submission_item_id is
 *  null — the row it was issued for was deleted by a money-driven reparse) is
 *  not a current item and is correctly absent from this map. */
export function orderProductCodesByItemId(
  displayNumber: string | null | undefined,
  codes: readonly OrderProductCodeRecord[],
): ReadonlyMap<string, string> {
  const byItem = new Map<string, string>()
  for (const row of codes) {
    if (row.submission_item_id === null) continue
    const code = formatOrderProductCode(displayNumber, row.boe_sequence)
    if (code !== null) byItem.set(row.submission_item_id, code)
  }
  return byItem
}
