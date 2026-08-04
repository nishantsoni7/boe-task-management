// ── Global product lookup ─────────────────────────────────────────────────────
// Finding one product when you do not know its category.
//
// Product Master is category navigation, and that is deliberate — but it took
// away the one thing the old "All Products" tab was genuinely used for: reading
// a code off a QR label and jumping straight to that product. This restores the
// LOOKUP without restoring the browse-everything screen: it locates a single
// product and navigates to it. It is not a filter, it has no status control, no
// sort, no paging and no counts, and it never becomes a catalogue view.
//
// Everything here is pure so the request shape, the result cap and the keyboard
// rules can be asserted without a DOM or a network.

import { productEditHref } from './productNav'

/**
 * How many matches the lookup shows.
 *
 * Small on purpose. This is a "jump to it" control, not a result set — if the
 * answer is not in the first few rows the term was too vague, and the fix is to
 * type more of the code, not to scroll. Also the ceiling the API applies, so a
 * broad term can never drag the whole catalogue into the sidebar.
 */
export const LOOKUP_RESULT_LIMIT = 8

/** Debounce before a typed term becomes a request. */
export const LOOKUP_DEBOUNCE_MS = 220

/** The route the lookup calls — the existing products route, in `lookup=1` mode. */
export const LOOKUP_PATH = '/api/showroom/admin/products'

/** One match. Exactly the four fields the sidebar renders — nothing else is requested. */
export type ProductLookupResult = {
  id: string
  product_code: string
  name: string
  category: string | null
}

/** Trim and collapse inner whitespace, so " BOE  1042 " and "BOE 1042" are one query. */
export function normalizeLookupQuery(raw: string | null | undefined): string {
  return (raw ?? '').trim().replace(/\s+/g, ' ')
}

/**
 * Whether a term is worth a request.
 *
 * A blank or whitespace-only box must never reach the network: an empty `q`
 * would match every product, which is precisely the catalogue-wide read this
 * feature is not allowed to become.
 */
export function shouldRunLookup(raw: string | null | undefined): boolean {
  return normalizeLookupQuery(raw).length > 0
}

/**
 * The request URL, or null when nothing should be fetched.
 *
 * Returning null rather than an empty string means "no request" is a value the
 * caller has to handle, instead of a falsy string that could be fetched by
 * accident.
 */
export function lookupRequestPath(raw: string | null | undefined): string | null {
  const q = normalizeLookupQuery(raw)
  if (!q) return null
  const params = new URLSearchParams({ lookup: '1', q, limit: String(LOOKUP_RESULT_LIMIT) })
  return `${LOOKUP_PATH}?${params.toString()}`
}

/**
 * The PostgREST `or` expression, built from an ALREADY-ESCAPED term.
 *
 * Code and name only. Category is deliberately not matched: the sidebar already
 * lists categories, and including it would turn a one-word term into "every
 * product in that category" — a catalogue browse wearing a lookup's clothes.
 */
export function lookupOrExpression(escapedTerm: string): string {
  return `name.ilike."%${escapedTerm}%",product_code.ilike."%${escapedTerm}%"`
}

/**
 * Where a result goes: the product's edit page, with no `from=` breadcrumb.
 *
 * There is no list view behind a lookup, so there is nothing to replay. Back on
 * that page then resolves through the ordinary productNav rule — the product's
 * own category — which is a real Product Master URL and cannot leave the module.
 * The list's return marker is deliberately not written either, so Back will
 * navigate rather than reach into history it did not create.
 */
export function lookupResultHref(productCode: string): string {
  return productEditHref(productCode, null)
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

export type LookupKeyAction =
  | { action: 'move'; index: number }
  | { action: 'open'; index: number }
  | { action: 'close' }
  | { action: 'clear' }
  | null

/**
 * Move the highlight, wrapping at both ends so the list is a loop rather than a
 * dead end. -1 means nothing is highlighted yet; the first Down goes to 0.
 */
export function moveLookupHighlight(current: number, count: number, delta: number): number {
  if (count <= 0) return -1
  if (current < 0) return delta > 0 ? 0 : count - 1
  return (current + delta + count) % count
}

/**
 * What a keypress does in the lookup box.
 *
 * Escape is two-stage on purpose: the first press dismisses the results and
 * leaves the term, so a mis-aimed Enter is recoverable; the second clears the
 * box. Neither ever navigates.
 */
export function resolveLookupKey(input: {
  key: string
  resultsOpen: boolean
  count: number
  highlight: number
  hasQuery: boolean
}): LookupKeyAction {
  const { key, resultsOpen, count, highlight, hasQuery } = input

  if (key === 'Escape') {
    if (resultsOpen) return { action: 'close' }
    return hasQuery ? { action: 'clear' } : null
  }

  if (key === 'ArrowDown' || key === 'ArrowUp') {
    if (!resultsOpen || count <= 0) return null
    return { action: 'move', index: moveLookupHighlight(highlight, count, key === 'ArrowDown' ? 1 : -1) }
  }

  if (key === 'Enter') {
    if (!resultsOpen || count <= 0) return null
    // Enter with nothing highlighted opens the first match — the common case is
    // typing a full code, getting one row, and pressing Enter.
    return { action: 'open', index: highlight >= 0 ? highlight : 0 }
  }

  return null
}
