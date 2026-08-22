// ── What the Received Payments list asks the database ─────────────────────────
//
// The pure half of the two Finance list pages: what a search term is allowed to
// become, which linkage a filter narrows to, and how a page of results is
// bounded. No Supabase import, no React — so every rule here is testable
// directly, and the two pages cannot grow separate versions of it.
//
// THREE DEFECTS THIS FILE EXISTS TO CLOSE
// ---------------------------------------
//
// 1. THE LIST WAS UNBOUNDED, AND POSTGREST TRUNCATES SILENTLY.
//    The query carried no .range() and no .limit(). PostgREST caps a response at
//    1000 rows on this project — a CAP, not an error: no error field, no
//    warning, and a plausible-looking array (src/lib/supabasePaging.ts documents
//    the day this cost the Performance module three quarters of its data). The
//    list is ordered created_at DESC, so at 1001 approved payments the OLDEST
//    would begin disappearing from Finance with the row count beside them
//    reading a confident "1000 payments". Money is exactly the wrong thing to
//    lose quietly, so the list is now paged and says what page it is on.
//
// 2. THE LINKAGE FILTER COULD NOT SEE AN ALLOCATED PAYMENT.
//    resolveLinkedAgainst (paymentRouting.ts) learned in Phase 3 to read a
//    Confirmed Order out of an ACTIVE ALLOCATION — that is how a PI's money
//    reaches its Order without the payment row being rewritten. The FILTER
//    beside it never learned: it tested `order_id` alone. So a payment attached
//    to an Order by allocation displayed "Order ORD-…" in its own row, and then
//    vanished from BOTH narrowings — it is not order_id, and it is not an Order
//    Request either. Exactly the money PI conversion produces, unfindable by the
//    filter that claims to find it.
//
// 3. SEARCH DID NOT COVER THE COLUMN THE TABLE LEADS WITH.
//    The first column of the table is Payment Request #, and searching for one
//    returned nothing: search read client_name, order_number and
//    order_request_number only. It also could not find a payment by the Order
//    its allocation names — the very number the row displays.
//
// WHAT IT DOES NOT DO
// -------------------
// It shapes a read. It authorizes nothing: RECEIVED_PAYMENTS_SOURCE is a
// security_invoker view, so every filter below narrows a set RLS has ALREADY
// decided the caller may see. A filter that matched every row in the table would
// still return only that caller's rows.

import type { PaymentLinkageMode } from './paymentRouting'

// ── Paging ────────────────────────────────────────────────────────────────────

/**
 * Rows per page.
 *
 * 50, matching the other paged lists in the product (tasks/all,
 * attendance/records, attendance/correction-log) so a Finance page behaves like
 * every other long list here. Comfortably under PostgREST's 1000-row ceiling,
 * which is the point: a page can never be silently truncated.
 */
export const RECEIVED_PAYMENTS_PAGE_SIZE = 50

/** The inclusive `range(from, to)` bounds for a 1-based page number. */
export function pageRange(page: number, pageSize = RECEIVED_PAYMENTS_PAGE_SIZE): { from: number; to: number } {
  // A page below 1 is a URL somebody typed, not a state the controls produce.
  // It reads as the first page rather than as a negative offset, which
  // PostgREST would refuse.
  const safe = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1
  const from = (safe - 1) * pageSize
  return { from, to: from + pageSize - 1 }
}

/** How many pages a total row count makes. Always at least one, so "Page 1 of 1" is the empty state. */
export function pageCount(total: number | null, pageSize = RECEIVED_PAYMENTS_PAGE_SIZE): number {
  if (total === null || !Number.isFinite(total) || total <= 0) return 1
  return Math.max(1, Math.ceil(total / pageSize))
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * The columns a search term is matched against, in the order a reader would
 * expect them to be tried.
 *
 * `request_number` LEADS, and its absence was the defect: it is the first column
 * the table draws, and a Finance user reading a payment reference off an email
 * types exactly that. `allocated_order_number` is here for the same reason —
 * the row displays it, so the row must be findable by it.
 */
export const RECEIVED_PAYMENTS_SEARCH_COLUMNS = [
  'request_number',
  'client_name',
  'order_number',
  'order_request_number',
  'allocated_order_number',
] as const

/**
 * A search term reduced to something that cannot change the SHAPE of a
 * PostgREST filter.
 *
 * `or=(a.ilike.*x*,b.ilike.*x*)` is a structured string, so a term containing a
 * comma, a bracket, a quote or a backslash would not merely fail to match — it
 * would be parsed as more filter, and the query would come back describing a
 * question nobody asked. `%` and `_` are ilike's own wildcards and are stripped
 * for the same reason: a term is a literal, and a reader typing `100%` is
 * searching for a string, not asking to match everything.
 *
 * STRIPPED, NOT REJECTED. Somebody pasting "REQ-2026-0024, ORD-7" is looking for
 * something; giving them the results for the characters that remain is more
 * useful than an error, and the term they typed is still in the box in front of
 * them. Returns '' when nothing usable is left, which callers treat as no search
 * at all rather than as a search for the empty string.
 */
export function sanitizeSearchTerm(raw: string): string {
  return raw
    .replace(/[,()"'\\%_*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The PostgREST `or=` filter for a sanitized term, or NULL for no search.
 *
 * NULL and not an empty string: an empty filter would still be sent, and
 * `or=()` is a parse error rather than a no-op. A caller that gets null simply
 * does not call `.or()`.
 */
export function searchFilter(
  raw: string,
  columns: readonly string[] = RECEIVED_PAYMENTS_SEARCH_COLUMNS,
): string | null {
  const term = sanitizeSearchTerm(raw)
  if (term === '') return null
  return columns.map(column => `${column}.ilike.*${term}*`).join(',')
}

// ── The linkage narrowing, inside a page that is already one linkage mode ─────

/**
 * What the Linked Payments page's filter narrows to.
 *
 * `all` is every row the page already holds. The other two split the page's rows
 * by WHAT they are attached to, and the split is the same one
 * resolveLinkedAgainst draws the badge from — a Confirmed Order wins over an
 * Order Request whenever both are somehow present, and an ACTIVE ALLOCATION onto
 * an Order counts as a Confirmed Order, because that is what it is.
 */
export type LinkageFilter = 'all' | 'order' | 'request'

export const LINKAGE_FILTER_OPTIONS: { value: LinkageFilter; label: string }[] = [
  { value: 'all',     label: 'All linked' },
  { value: 'order',   label: 'Confirmed Order' },
  { value: 'request', label: 'Order Request' },
]

export function isLinkageFilter(value: string): value is LinkageFilter {
  return value === 'all' || value === 'order' || value === 'request'
}

/**
 * The linkage narrowing as PostgREST filters.
 *
 * Returned as a LIST of clauses rather than applied here, so this module needs
 * no Supabase import and the caller decides how to attach them. Each entry is
 * either an `or` group or a plain `is` equality; the caller applies every one,
 * and they compose as AND — which is what a narrowing means.
 *
 * THE ORDER BRANCH INCLUDES THE ALLOCATION, which is defect 2 above. The REQUEST
 * branch is its exact complement within the page: an Order Request linkage
 * counts only when NEITHER Order attachment is present, mirroring
 * resolveLinkedAgainst's priority so a row can satisfy exactly one of the two.
 */
export type QueryClause =
  | { kind: 'or'; filters: string }
  | { kind: 'isNull'; column: string }
  | { kind: 'notNull'; column: string }

export function linkageFilterClauses(filter: LinkageFilter): QueryClause[] {
  if (filter === 'order') {
    return [{ kind: 'or', filters: 'order_id.not.is.null,allocated_order_id.not.is.null' }]
  }
  if (filter === 'request') {
    return [
      { kind: 'isNull',  column: 'order_id' },
      { kind: 'isNull',  column: 'allocated_order_id' },
      { kind: 'notNull', column: 'order_request_id' },
    ]
  }
  return []
}

// ── Date range ────────────────────────────────────────────────────────────────

/**
 * A date bound, or null when the box is empty or holds something that is not a
 * date.
 *
 * Validated rather than passed through: an unparseable value sent as a filter
 * makes PostgREST refuse the whole request, so a half-typed date in a live-bound
 * input would blank the list instead of leaving it alone. `YYYY-MM-DD` is what
 * <input type="date"> produces and what payment_date stores.
 */
export function dateBound(raw: string | null | undefined): string | null {
  if (!raw) return null
  const text = raw.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  // Rejects 2026-13-45. Date.parse accepts an ISO date and yields NaN otherwise.
  const parsed = new Date(`${text}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return null
  // Round-trips only for a real calendar date: 2026-02-31 normalises to March.
  return parsed.toISOString().slice(0, 10) === text ? text : null
}

/**
 * The two bounds, in order, whatever order they were typed in.
 *
 * SWAPPED RATHER THAN REFUSED when `to` is before `from`. Somebody who filled
 * the boxes the other way round meant the range between the two dates, and an
 * empty list would be a silent, confusing answer to a reasonable action.
 */
export function dateRange(fromRaw: string | null | undefined, toRaw: string | null | undefined): {
  from: string | null
  to: string | null
} {
  const from = dateBound(fromRaw)
  const to = dateBound(toRaw)
  if (from && to && to < from) return { from: to, to: from }
  return { from, to }
}

// ── What the toolbar says it is doing ────────────────────────────────────────

/** True when anything is narrowing the list, so the page can offer to clear it. */
export function isNarrowed(state: {
  search: string
  linkage: LinkageFilter
  dateFrom: string | null
  dateTo: string | null
}): boolean {
  return sanitizeSearchTerm(state.search) !== ''
    || state.linkage !== 'all'
    || dateBound(state.dateFrom) !== null
    || dateBound(state.dateTo) !== null
}

/**
 * The row-count line beside the toolbar.
 *
 * SAYS "of N" ONLY WHEN N IS KNOWN. The count comes from PostgREST's exact
 * count, and a caller that could not read one gets null — in which case the line
 * describes the page it has rather than inventing a total. Both the mode and the
 * narrowing change the total, so the wording never claims a filtered count is
 * the whole set.
 */
export function resultSummary(input: {
  loading: boolean
  shown: number
  total: number | null
  narrowed: boolean
  page: number
  pages: number
}): string {
  if (input.loading) return 'Loading…'
  if (input.total === 0) return input.narrowed ? 'No matches' : 'No payments'

  const noun = (n: number) => `payment${n === 1 ? '' : 's'}`
  const scope = input.total === null
    ? `${input.shown} ${noun(input.shown)}`
    : input.narrowed
      ? `${input.total} matching ${noun(input.total)}`
      : `${input.total} ${noun(input.total)}`

  return input.pages > 1 ? `${scope} · page ${input.page} of ${input.pages}` : scope
}

// ── Re-export, so a caller needs one import for the whole read ───────────────
export type { PaymentLinkageMode }
