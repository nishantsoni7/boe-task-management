// The Control Center's switch for price approval on quotations (owner, 15 Nov 2026: the price estimate is not
// strong enough yet, so nobody should be held up by it).
//
// There is no flag in the database. quotation_price_check asks for approval only while a limit is set, so
// approval is OFF when BOTH limits are empty, and the switch reads and writes the two limits. Switching off
// therefore forgets them; switching on starts from the owner's original 5% and 90%.

export const DEFAULT_DISCOUNT_LIMIT = '5'
export const DEFAULT_PRICE_LIMIT = '90'

export const approvalIsOn = (s: { max_discount_pct: number | null; min_price_pct: number | null }) =>
  s.max_discount_pct !== null || s.min_price_pct !== null

/** A limit as typed: empty = that check is off (null); anything else must be a number. */
export function readLimit(text: string): number | null {
  const t = text.trim()
  if (t === '') return null
  const n = Number(t)
  if (!Number.isFinite(n)) throw new Error('Type a number, or leave the limit empty.')
  return n
}
