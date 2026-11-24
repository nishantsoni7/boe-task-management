// "Teach this?" (Price Brain v2, phase 4; owner approved 24 Nov 2026). When somebody who may correct the price logic types a
// price more than 10% away from the suggested one, the line asks once, with reason chips; one tap sends a note to Price
// learning, where "Teach this price" turns it into a Training case. The line remembers that it asked for that price with
// a tag in its internal note (never shown to a client), so a reload does not ask again; a new price asks again.
// shortcut: a tag in a note, read by a text match, like the "Use" and taught-pick tags; move all three to columns if notes get crowded.

import { isEcho } from './echo'

/** More than this far from the suggestion (either way) asks. */
export const ASK_GAP = 0.1

/** The reasons offered as chips, in the words the inbox shows. */
export const TEACH_REASONS = ['Material or wood', 'Size', 'Finish or fabric', 'Work or design', 'Client or volume', 'Market rate', 'Other'] as const

const TAG = /\s*\[Asked to teach \d+\]/g

/** The note with the tag for the price that was asked about (any earlier one replaced). Whatever else is written stays. */
export function withAskedTag(note: string | null | undefined, price: number): string {
  const rest = (note ?? '').replace(TAG, '').trim()
  return [rest, `[Asked to teach ${Math.round(price)}]`].filter(Boolean).join(' ')
}

/** The price already asked about, read from a note, or null. */
export function askedPrice(note: string | null | undefined): number | null {
  const m = /\[Asked to teach (\d+)\]/.exec(note ?? '')
  return m ? Number(m[1]) : null
}

/** The gap as a signed fraction: +0.22 is 22% above the suggestion. */
export const gapOf = (price: number, suggested: number) => price / suggested - 1

/** Whether to ask: a typed price (not one "Use" set), more than ASK_GAP from the suggestion, not asked about before. */
export function shouldAsk(price: number | null | undefined, suggested: number | null | undefined, note: string | null | undefined): boolean {
  if (!(Number(price) > 0) || !(Number(suggested) > 0)) return false
  const p = Math.round(Number(price))
  if (isEcho(note, p) || askedPrice(note) === p) return false
  // In rupees, not as a ratio: 5,500 / 5,000 − 1 is a hair above 0.1 in floating point, and exactly 10% must not ask.
  return Math.abs(p - Number(suggested)) > ASK_GAP * Number(suggested)
}

/** The feedback kind: a price below the suggestion says the suggestion is too high, above it too low. */
export const kindFor = (price: number, suggested: number): 'too_high' | 'too_low' => (price < suggested ? 'too_high' : 'too_low')
