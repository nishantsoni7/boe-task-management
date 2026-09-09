// ── Quantity on the quotation screen ──────────────────────────────────────────
//
// Quantity exists in three places on the admin inquiry screen and they had no
// agreed order of authority, which is why edits appeared to revert at random:
//
//   pendingQty[itemId]   the string in the input, while it is being typed
//   inquiry.…[].quantity the last snapshot the server sent back
//   the DB row           the persisted truth
//
// The rule this module encodes:
//
//   The DB is authoritative. A typed value is a PROPOSAL that becomes
//   authoritative only when the server confirms it, and until then it is what
//   the screen shows and what the screen's money is calculated from — so the
//   number, the line total and the quotation total can never disagree with each
//   other, whatever is in flight.
//
// Everything here is pure. The component keeps the fetches; this keeps the
// arithmetic and the decisions, so "what happens when the save fails" is a test
// rather than a thing someone has to reproduce by going offline.

import { MAX_ITEM_QUANTITY } from './cart'

export { MAX_ITEM_QUANTITY }

/** Quantity can never be zero — removing a line is a different action. */
export const MIN_ITEM_QUANTITY = 1

export type QuantityInput = {
  /** The quantity to use for display and for money. Always valid. */
  value: number
  /** True when `value` differs from what the server last confirmed. */
  changed: boolean
  /**
   * False when the box currently holds something that is not a quantity —
   * mid-typing emptiness, a stray letter, a zero. The caller must NOT persist
   * an invalid value, and must NOT discard what the user typed either: an empty
   * box on the way to "12" is not a request to reset anything.
   */
  valid: boolean
}

/**
 * What the box currently means.
 *
 * `raw === undefined` is "not being edited", which is different from "edited to
 * an empty string": the first falls back to the server value, the second is a
 * half-finished edit that must not be treated as a change.
 */
export function parseQuantityInput(
  raw: string | undefined,
  current: number,
): QuantityInput {
  const safeCurrent = clampQuantity(current)

  if (raw === undefined) return { value: safeCurrent, changed: false, valid: true }

  const trimmed = raw.trim()
  if (trimmed === '') return { value: safeCurrent, changed: false, valid: false }

  // Integers only, and no coercion of things like "5px" or "1e3": a quotation
  // line is a count of pieces.
  if (!/^\d+$/.test(trimmed)) return { value: safeCurrent, changed: false, valid: false }

  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed < MIN_ITEM_QUANTITY) {
    return { value: safeCurrent, changed: false, valid: false }
  }

  const value = clampQuantity(parsed)
  return { value, changed: value !== safeCurrent, valid: true }
}

/** Force any number into the allowed range. */
export function clampQuantity(n: number): number {
  const rounded = Math.round(Number(n))
  if (!Number.isFinite(rounded)) return MIN_ITEM_QUANTITY
  return Math.min(MAX_ITEM_QUANTITY, Math.max(MIN_ITEM_QUANTITY, rounded))
}

/**
 * The quantity the screen should USE — for the line total, the subtotal, and
 * the payload sent to the quotation route.
 *
 * A valid in-flight edit wins over the server snapshot. That is the whole fix
 * for "the money on screen was computed from the old quantity": previously the
 * input showed the typed value while every total read the server's, so a line
 * could read `5 × Rs. 9,200 = Rs. 9,200` until a round-trip completed.
 */
export function effectiveQuantity(current: number, raw: string | undefined): number {
  return parseQuantityInput(raw, current).value
}

/** Sum of `rate × quantity` using the quantity each line is actually showing. */
export function subtotalOf<T>(
  items: T[],
  rateOf: (item: T) => number,
  quantityOf: (item: T) => number,
): number {
  return items.reduce((sum, item) => sum + rateOf(item) * quantityOf(item), 0)
}

// ── Reconciling a confirmed save ──────────────────────────────────────────────

/**
 * Replace one line with the row the server just confirmed.
 *
 * Used instead of re-fetching the whole inquiry after a quantity change. The
 * PATCH already returns the saved row, and the old code threw that away and
 * issued a second request — during which the input, having already dropped its
 * pending value, fell back to the PRE-EDIT snapshot and visibly snapped back.
 *
 * Only the fields the server confirmed are taken, so this can never clobber a
 * rate or note the user is still editing in another column.
 */
export function applyConfirmedQuantity<T extends { id: string; quantity: number }>(
  items: T[],
  itemId: string,
  quantity: number,
): T[] {
  return items.map(item =>
    item.id === itemId ? { ...item, quantity: clampQuantity(quantity) } : item,
  )
}

/**
 * Which lines still hold an unsaved quantity, as `[itemId, quantity]`.
 *
 * Preview and Generate call this first: a quantity typed but not blurred was
 * previously never sent anywhere, so the PDF was built from the last saved
 * value while the screen showed the new one. Invalid entries are excluded —
 * they are not a quantity to save, and the caller reports them rather than
 * silently writing something the user did not type.
 */
export function pendingQuantityWrites(
  items: Array<{ id: string; quantity: number }>,
  pending: Record<string, string | undefined>,
): Array<{ id: string; quantity: number }> {
  const writes: Array<{ id: string; quantity: number }> = []
  for (const item of items) {
    const parsed = parseQuantityInput(pending[item.id], item.quantity)
    if (parsed.valid && parsed.changed) writes.push({ id: item.id, quantity: parsed.value })
  }
  return writes
}

/** True when any line holds a value that is not a usable quantity. */
export function hasInvalidQuantity(
  items: Array<{ id: string; quantity: number }>,
  pending: Record<string, string | undefined>,
): boolean {
  return items.some(item => !parseQuantityInput(pending[item.id], item.quantity).valid)
}
