// ── What a Finance list asks the database ─────────────────────────────────────
//
// The rules every paged Finance list shares: how a page is bounded, what a
// search term is allowed to become, how a date bound is validated, and how the
// toolbar describes the result. No Supabase import, no React — so each rule is
// testable directly, and the three lists that read them cannot grow separate
// versions.
//
// EXTRACTED, NOT INVENTED. Received Payments proved these rules first
// (receivedPaymentsQuery.ts); Payment Requests needed the same ones and copying
// them would have been the beginning of two lists that page differently and
// sanitize differently. What stays in each list's own module is the part that is
// genuinely its own: which columns it searches, and what its filters mean.
//
// THE DEFECT THESE RULES EXIST TO CLOSE
// -------------------------------------
// A Finance list with no .range() and no .limit() is SILENTLY TRUNCATED.
// PostgREST caps a response at 1000 rows on this project — a cap, not an error:
// no error field, no warning, and a plausible-looking array. That is the failure
// src/lib/supabasePaging.ts documents costing the Performance module three
// quarters of its data. Ordered newest-first, a Finance list crossing 1000 rows
// begins dropping the OLDEST money with a confident row count beside it.
//
// WHAT THEY DO NOT DO
// -------------------
// They shape a read. They authorize nothing: every list these serve reads a
// security_invoker projection or an RLS-protected table, so each filter narrows
// a set the database has ALREADY decided the caller may see. A filter that
// matched every row in the table would still return only that caller's rows.

// ── Paging ────────────────────────────────────────────────────────────────────

/**
 * Rows per page, for every Finance list.
 *
 * 50, matching the other paged lists in the product (tasks/all,
 * attendance/records, attendance/correction-log) so a Finance page behaves like
 * every other long list here. Comfortably under PostgREST's 1000-row ceiling,
 * which is the point: a page can never be the thing that gets clipped.
 */
export const FINANCE_PAGE_SIZE = 50

/** The inclusive `range(from, to)` bounds for a 1-based page number. */
export function pageRange(page: number, pageSize = FINANCE_PAGE_SIZE): { from: number; to: number } {
  // A page below 1 is a URL somebody typed, not a state the controls produce.
  // It reads as the first page rather than as a negative offset, which
  // PostgREST would refuse outright — blanking the list instead of showing it.
  const safe = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1
  const from = (safe - 1) * pageSize
  return { from, to: from + pageSize - 1 }
}

/** How many pages a total makes. Always at least one, so "Page 1 of 1" is the empty state. */
export function pageCount(total: number | null, pageSize = FINANCE_PAGE_SIZE): number {
  if (total === null || !Number.isFinite(total) || total <= 0) return 1
  return Math.max(1, Math.ceil(total / pageSize))
}

/**
 * The page a reader should be on after the result set changed size.
 *
 * Staying on page four of a set that now has one page shows an empty table over
 * a filter that matches plenty — an empty state that is a lie about the data.
 */
export function clampPage(page: number, total: number | null, pageSize = FINANCE_PAGE_SIZE): number {
  const pages = pageCount(total, pageSize)
  if (!Number.isFinite(page) || page < 1) return 1
  return Math.min(Math.floor(page), pages)
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * A search term reduced to something that cannot change the SHAPE of a
 * PostgREST filter.
 *
 * `or=(a.ilike.*x*,b.ilike.*x*)` is a structured string, so a term containing a
 * comma, a bracket, a quote or a backslash would not merely fail to match — it
 * would be parsed as MORE FILTER, and the query would come back describing a
 * question nobody asked. `%` and `_` are ilike's own wildcards and are stripped
 * for the same reason: a term is a literal, and somebody typing `100%` is
 * searching for a string, not asking to match every row in the ledger.
 *
 * STRIPPED, NOT REJECTED. Somebody pasting "REQ-2026-0024, ORD-7" is looking for
 * something; giving them the results for what remains is more useful than an
 * error, and the term they typed is still in the box in front of them. Returns
 * '' when nothing usable is left, which callers treat as no search at all rather
 * than as a search for the empty string.
 */
export function sanitizeSearchTerm(raw: string): string {
  return raw
    .replace(/[,()"'\\%_*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The PostgREST `or=` filter matching a term against every named column, or
 * NULL for no search.
 *
 * NULL and not an empty string: an empty filter would still be sent, and `or=()`
 * is a parse error rather than a no-op. A caller that gets null simply does not
 * call `.or()`.
 */
export function searchFilter(raw: string, columns: readonly string[]): string | null {
  const term = sanitizeSearchTerm(raw)
  if (term === '') return null
  return columns.map(column => `${column}.ilike.*${term}*`).join(',')
}

// ── Filter clauses ────────────────────────────────────────────────────────────

/**
 * One narrowing, as data rather than as an applied query.
 *
 * Returned as a list so these modules need no Supabase import and the caller
 * decides how to attach them. Every clause a caller applies composes as AND,
 * which is what a narrowing means.
 */
export type QueryClause =
  | { kind: 'or'; filters: string }
  | { kind: 'isNull'; column: string }
  | { kind: 'notNull'; column: string }
  | { kind: 'eq'; column: string; value: string }
  | { kind: 'in'; column: string; values: readonly string[] }
  // Strictly greater than, for a NUMERIC column. Added for the payment
  // classification, whose `Available to Allocate` narrowing is "a positive
  // unallocated balance" — a comparison the database has to make, because a
  // balance computed over the fifty rows in hand would narrow those fifty and
  // hide every match on page two.
  | { kind: 'gt'; column: string; value: string }

// ── Date range ────────────────────────────────────────────────────────────────

/**
 * A date bound, or null when the box is empty or holds something that is not a
 * date.
 *
 * Validated rather than passed through: an unparseable value sent as a filter
 * makes PostgREST refuse the WHOLE request, so a half-typed date in a live-bound
 * input would blank the list instead of leaving it alone. `YYYY-MM-DD` is what
 * <input type="date"> produces and what payment_date stores.
 */
export function dateBound(raw: string | null | undefined): string | null {
  if (!raw) return null
  const text = raw.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
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

/**
 * The row-count line beside a list's toolbar.
 *
 * SAYS "of N" ONLY WHEN N IS KNOWN. The count comes from PostgREST's exact
 * count, and a caller that could not read one gets null — in which case the line
 * describes the page it has rather than inventing a total. The narrowing changes
 * the total, so the wording never claims a filtered count is the whole set.
 */
export function resultSummary(input: {
  loading: boolean
  shown: number
  total: number | null
  narrowed: boolean
  page: number
  pages: number
  /** What one row is called. Defaults to 'payment'. */
  noun?: string
}): string {
  const singular = input.noun ?? 'payment'
  if (input.loading) return 'Loading…'
  if (input.total === 0) return input.narrowed ? 'No matches' : `No ${singular}s`

  const plural = (n: number) => `${singular}${n === 1 ? '' : 's'}`
  const scope = input.total === null
    ? `${input.shown} ${plural(input.shown)}`
    : input.narrowed
      ? `${input.total} matching ${plural(input.total)}`
      : `${input.total} ${plural(input.total)}`

  return input.pages > 1 ? `${scope} · page ${input.page} of ${input.pages}` : scope
}
