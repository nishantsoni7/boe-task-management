// ── Product codes as people type them ─────────────────────────────────────────
//
// A product code is stored one way and read off a sticker every other way. The
// manual-entry fallback on the scan screen has to accept what a person standing
// in a showroom actually types — lower case, a leading space, a code pasted with
// a stray space inside it — and turn it into the exact form
// `/api/showroom/products/by-code/[product_code]` matches, which uppercases and
// trims and then compares for equality.
//
// One place, because the client normalises before it navigates and the route
// normalises before it queries. If those two disagree, a code that works when
// typed 404s when scanned, or the other way round.

/**
 * The canonical form of a typed product code, or `''` when there is nothing
 * usable.
 *
 * Uppercased and trimmed to match the route. Whitespace *inside* the value is
 * also removed, which the route does not do — a code pasted as `BOE-SR- 105`
 * should find `BOE-SR-105`, and it is safe because no stored code contains
 * whitespace (verified against all 253 rows: every one is `BOE-SR-<n>` or
 * `BOE-CH-<n>`, upper case, no spaces).
 *
 * It does not invent separators: `BOE SR 105` becomes `BOESR105` and correctly
 * finds nothing, because guessing where hyphens belong would be a different
 * product code than the one on the label.
 */
export function normalizeProductCode(raw: string | null | undefined): string {
  return (raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
}
