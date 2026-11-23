// The echo guard (Price Brain v2, phase 3A; owner, 23 Nov 2026: a price set with "Use" and not changed is left out of
// learning). "Use" on a suggested price writes this tag into the line's internal note (never shown to a client); the
// price points (pricing_pool, pricing_all_points, 20270824000000) skip a line whose price still equals the tagged one.
// shortcut: a tag in a note, read by a text match, like the taught pick; move both to columns if notes get crowded.

const TAG = /\s*\[Used suggestion \d+\]/g

/** The note with the tag for a price set by "Use" (any earlier one replaced). Whatever else is written stays. */
export function withUsedTag(note: string | null | undefined, price: number): string {
  const rest = (note ?? '').replace(TAG, '').trim()
  return [rest, `[Used suggestion ${Math.round(price)}]`].filter(Boolean).join(' ')
}

/** The price "Use" set, read from a note, or null. */
export function usedPrice(note: string | null | undefined): number | null {
  const m = /\[Used suggestion (\d+)\]/.exec(note ?? '')
  return m ? Number(m[1]) : null
}

/** True when a line's price is still the one "Use" set: the model's own guess, which learning leaves out. */
export const isEcho = (note: string | null | undefined, price: number | null | undefined) => price !== null && price !== undefined && usedPrice(note) === Math.round(price)
