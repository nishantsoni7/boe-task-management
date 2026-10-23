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

/** Digits in a BOE item code (owner, 2026-10-20; was 3). Display only:
 *  order_product_codes stores the integer boe_sequence. */
export const BOE_ITEM_CODE_DIGITS = 4

/** 1 → 'BE0001'. */
export function formatBoeItemCode(boeSequence: number): string {
  return `BE${String(boeSequence).padStart(BOE_ITEM_CODE_DIGITS, '0')}`
}

/** Re-pads a code SQL built in the old 3-digit shape ('BE001' → 'BE0001'). A few
 *  database functions still return that label inside jsonb (PI revision line
 *  matching); anything that is not a BE code passes through unchanged. */
export function normalizeBoeItemCode(code: string | null | undefined): string | null {
  if (code === null || code === undefined) return null
  const m = /^BE([0-9]+)$/.exec(code.trim())
  return m ? formatBoeItemCode(Number(m[1])) : code
}

/** The number inside a PI line number — 'B004', 'BE004' and 'BE0004' all read 4.
 *  Null for anything that is not a plain B/BE number. */
export function piLineNumber(code: string | null | undefined): number | null {
  const m = /^BE?0*([0-9]+)$/i.exec((code ?? '').trim())
  return m ? Number(m[1]) : null
}

/** What a PI shows for a line number: 'B004' (the workbook template's shape) →
 *  'BE0004', the same shape the Order's product codes use. Anything else prints
 *  as typed; blank stays blank. */
export function formatPiLineCode(code: string | null | undefined): string | null {
  if (code === null || code === undefined || code.trim() === '') return null
  const n = piLineNumber(code)
  return n === null || n === 0 ? code.trim() : formatBoeItemCode(n)
}

/** ('0524', 1) → '524-BE0001'. Null when the Order has no display number yet —
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
