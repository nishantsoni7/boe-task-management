// ── What the Payment Requests list asks the database ──────────────────────────
//
// The five tabs, as DATABASE predicates rather than as a filter over rows
// already in the browser — plus the columns this list searches. Everything it
// shares with the other paged Finance lists lives in ./listQuery.
//
// THE DEFECT THIS CLOSES
// ----------------------
// The list carried no .range() and no .limit(), and every tab, every count and
// the whole search ran in the browser over whatever came back. PostgREST caps a
// response at 1000 rows on this project — a CAP, not an error: no error field,
// no warning, a plausible-looking array (src/lib/supabasePaging.ts documents the
// day that cost the Performance module three quarters of its data).
//
// Payment Requests is scoped to the three REQUEST-STAGE statuses, so it looks
// like a small queue. It is not bounded like one: `rejected` accumulates
// forever, and the Archive tab exists precisely because it does. Ordered
// created_at DESC, the 1001st request-stage row starts pushing the OLDEST
// records out — and the Archive tab, whose entire purpose is to show the oldest
// rejected requests, is the tab that empties first while its badge still reads a
// confident number.
//
// WHY THE TABS HAD TO MOVE SERVER-SIDE TOO
// ----------------------------------------
// Not for speed. A tab applied in the browser over ONE PAGE narrows fifty rows
// and silently hides every match on page two, so paging without moving the tabs
// would have replaced a truncation defect with a filtering one.
//
// THE PREDICATES ARE THE SAME ONES matchesTab() APPLIES, restated as filters
// rather than reimplemented: same statuses, same archive window, same
// coalesce(rejected_at, updated_at) timestamp, same "both null is not archived"
// rule. tabMatches() below is that shared definition, and the page keeps using
// it as a second, independent gate over whatever is in memory.
//
// WHAT IT DOES NOT DO
// -------------------
// It shapes a read. finance_payment_requests is RLS-protected, so every filter
// narrows a set the database has ALREADY decided the caller may see.

import { searchFilter, type QueryClause } from './listQuery'

// The shared rules, re-exported so a caller needs one import for the whole read.
export {
  FINANCE_PAGE_SIZE as PAYMENT_REQUESTS_PAGE_SIZE,
  clampPage,
  pageCount,
  pageRange,
  resultSummary,
  sanitizeSearchTerm,
} from './listQuery'
export type { QueryClause } from './listQuery'

// ── The tabs ──────────────────────────────────────────────────────────────────

export type FilterTab = 'pending' | 'clarification' | 'rejected' | 'archive' | 'all'

export const FILTER_TAB_KEYS: FilterTab[] = ['pending', 'clarification', 'rejected', 'archive', 'all']

/**
 * An incoming `?tab=` value mapped to a known tab, defaulting to 'pending'.
 *
 * Never throws on an invalid or stale deep link. A link from before confirmed
 * payments left this page (`?tab=order_pending`) is simply not in the list and
 * falls through to the default.
 */
export function parseFilterTab(value: string | null): FilterTab {
  return (FILTER_TAB_KEYS as string[]).includes(value ?? '') ? (value as FilterTab) : 'pending'
}

/**
 * How long a rejected request stays in the active Rejected tab before it moves
 * to Archive. Thirty days.
 */
export const ARCHIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/**
 * The instant that separates active from archived, as an ISO timestamp.
 *
 * TAKES `now` RATHER THAN READING THE CLOCK, so the same cutoff can be used for
 * the query, for the counts and for the in-memory gate within one render — and
 * so a test can pin it. A list whose five count queries each computed their own
 * `Date.now()` could, at the boundary, return counts that do not sum.
 */
export function archiveCutoffIso(now: number): string {
  return new Date(now - ARCHIVE_WINDOW_MS).toISOString()
}

/**
 * The three statuses this page may load, and the only three.
 *
 * A confirmed payment is not a payment request in any state — it belongs to
 * Received Payments from the moment of approval. Filtering POSITIVELY means a
 * status added later has to be named here to appear, rather than appearing by
 * default.
 */
export const REQUEST_STAGE_STATUSES = ['pending_approval', 'needs_clarification', 'rejected'] as const

// ── The archive predicate, in both forms ─────────────────────────────────────
//
// A rejected request is ARCHIVED when its timestamp — rejected_at, or updated_at
// when that is null — is at or before the cutoff. A row with NEITHER timestamp
// is never archived, so a record that lost its dates cannot silently vanish from
// the active view.
//
// PostgREST cannot express coalesce() in a filter, so the three cases are spelled
// out as a nested or/and group. They are exhaustive and mutually exclusive:
//
//   rejected_at IS NOT NULL          → compare rejected_at
//   rejected_at IS NULL, updated_at  → compare updated_at
//   both NULL                        → not archived, always
//
// `.not.is.null` is deliberately absent from the first branch: `rejected_at.lte`
// is already false for a null, so naming the null case again would only add a
// way for the two forms to disagree.

/** `coalesce(rejected_at, updated_at) <= cutoff` — the archived side. */
function archivedGroup(cutoffIso: string): string {
  return `rejected_at.lte.${cutoffIso},and(rejected_at.is.null,updated_at.lte.${cutoffIso})`
}

/** Its exact negation: everything a rejected row can be that is NOT archived. */
function activeRejectedGroup(cutoffIso: string): string {
  return `rejected_at.gt.${cutoffIso}`
    + `,and(rejected_at.is.null,updated_at.gt.${cutoffIso})`
    + `,and(rejected_at.is.null,updated_at.is.null)`
}

/**
 * One tab, as PostgREST filters.
 *
 * Every tab is additionally scoped by the caller to REQUEST_STAGE_STATUSES, so a
 * confirmed payment cannot surface in any of them — including 'all'.
 */
export function tabClauses(tab: FilterTab, cutoffIso: string): QueryClause[] {
  switch (tab) {
    case 'pending':
      return [{ kind: 'eq', column: 'status', value: 'pending_approval' }]
    case 'clarification':
      return [{ kind: 'eq', column: 'status', value: 'needs_clarification' }]
    case 'rejected':
      return [
        { kind: 'eq', column: 'status', value: 'rejected' },
        { kind: 'or', filters: activeRejectedGroup(cutoffIso) },
      ]
    case 'archive':
      return [
        { kind: 'eq', column: 'status', value: 'rejected' },
        { kind: 'or', filters: archivedGroup(cutoffIso) },
      ]
    default:
      // 'all' is every request-stage record EXCEPT archived rejected. A row that
      // is not rejected can never be archived, so it passes on the first branch
      // without the timestamp cases having to say so.
      return [{ kind: 'or', filters: `status.neq.rejected,${activeRejectedGroup(cutoffIso)}` }]
  }
}

/**
 * The same rule for a row already in hand.
 *
 * THE PAGE STILL APPLIES THIS, over whatever is in memory, as a second and
 * independent gate: a locally stale row approved by somebody else since the page
 * loaded must not linger in a tab the query would no longer return it for. The
 * query and this function are the same definition, which is what stops the two
 * from drifting.
 */
export function tabMatches(
  row: { status: string; rejected_at?: string | null; updated_at?: string | null },
  tab: FilterTab,
  cutoffMs: number,
): boolean {
  if (!(REQUEST_STAGE_STATUSES as readonly string[]).includes(row.status)) return false
  const archived = isArchivedRejected(row, cutoffMs)
  switch (tab) {
    case 'pending':       return row.status === 'pending_approval'
    case 'clarification': return row.status === 'needs_clarification'
    case 'rejected':      return row.status === 'rejected' && !archived
    case 'archive':       return archived
    default:              return !archived
  }
}

export function isArchivedRejected(
  row: { status: string; rejected_at?: string | null; updated_at?: string | null },
  cutoffMs: number,
): boolean {
  if (row.status !== 'rejected') return false
  const ts = row.rejected_at ?? row.updated_at ?? null
  if (!ts) return false
  return new Date(ts).getTime() <= cutoffMs
}

// ── The tab badges ────────────────────────────────────────────────────────────

/**
 * Which tabs need a count query of their own.
 *
 * FOUR, NOT FIVE. 'all' is exactly pending + clarification + rejected — the
 * request-stage statuses are those three, and 'all' excludes only archived
 * rejected, which is what the 'rejected' count already excludes. Deriving it
 * saves a fifth round trip and cannot disagree with the tabs it is the sum of.
 */
export const COUNTED_TABS: FilterTab[] = ['pending', 'clarification', 'rejected', 'archive']

/** The five badge numbers, from the four the database was asked for. */
export function tabCounts(counted: Record<string, number | null>): Record<FilterTab, number | null> {
  const pending       = counted.pending       ?? null
  const clarification = counted.clarification ?? null
  const rejected      = counted.rejected      ?? null
  const archive       = counted.archive       ?? null

  // A badge whose parts are not all known says nothing rather than a wrong
  // number: a partial sum would understate the tab and send somebody looking
  // for records it claims are not there.
  const all = pending === null || clarification === null || rejected === null
    ? null
    : pending + clarification + rejected

  return { pending, clarification, rejected, archive, all }
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * The columns a search term is matched against.
 *
 * `request_number` LEADS, and its absence was the same defect Received Payments
 * had: it is the first column the table draws, and somebody reading a reference
 * off an email types exactly that. The previous search read client_name and
 * order_number only.
 */
export const PAYMENT_REQUESTS_SEARCH_COLUMNS = [
  'request_number',
  'client_name',
  'order_number',
  'order_request_number',
] as const

export function paymentRequestsSearchFilter(raw: string): string | null {
  return searchFilter(raw, PAYMENT_REQUESTS_SEARCH_COLUMNS)
}
