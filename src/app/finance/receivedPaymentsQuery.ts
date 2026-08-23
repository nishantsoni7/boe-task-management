// ── What the Received Payments list asks the database ─────────────────────────
//
// What is SPECIFIC to Received Payments: which columns a search matches, what
// the linkage filter means, and what an allocation state narrows to. The rules
// it shares with every other paged Finance list — paging, search sanitizing,
// date bounds, the result line — live in ./listQuery and are re-exported here so
// a caller needs one import for the whole read.
//
// THREE DEFECTS THIS FILE EXISTS TO CLOSE
// ---------------------------------------
//
// 1. THE LIST WAS UNBOUNDED, AND POSTGREST TRUNCATES SILENTLY. See ./listQuery:
//    at 1001 approved payments the OLDEST would begin disappearing from Finance
//    with the row count beside them reading a confident "1000 payments".
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
// decided the caller may see.

import { dateBound, sanitizeSearchTerm, searchFilter, type QueryClause } from './listQuery'
import type { PaymentLinkageMode } from './paymentRouting'

// The shared rules, re-exported so a caller needs one import for the whole read.
export {
  FINANCE_PAGE_SIZE as RECEIVED_PAYMENTS_PAGE_SIZE,
  clampPage,
  dateBound,
  dateRange,
  pageCount,
  pageRange,
  resultSummary,
  sanitizeSearchTerm,
  searchFilter,
} from './listQuery'
export type { QueryClause } from './listQuery'

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * The columns a search term is matched against, in the order a reader would
 * expect them to be tried.
 *
 * `request_number` LEADS, and its absence was defect 3: it is the first column
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

/** The `or=` filter for a term across every column this list searches. */
export function receivedPaymentsSearchFilter(raw: string): string | null {
  return searchFilter(raw, RECEIVED_PAYMENTS_SEARCH_COLUMNS)
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
 * THE ORDER BRANCH INCLUDES THE ALLOCATION, which is defect 2 above. The REQUEST
 * branch is its exact complement within the page: an Order Request linkage
 * counts only when NEITHER Order attachment is present, mirroring
 * resolveLinkedAgainst's priority so a row can satisfy exactly one of the two.
 */
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

// ── What the toolbar says it is doing ────────────────────────────────────────

/** True when anything is narrowing the list, so the page can offer to clear it. */
export function isNarrowed(state: {
  search: string
  linkage: LinkageFilter
  dateFrom: string | null
  dateTo: string | null
  allocation?: AllocationFilter
}): boolean {
  return sanitizeSearchTerm(state.search) !== ''
    || state.linkage !== 'all'
    || dateBound(state.dateFrom) !== null
    || dateBound(state.dateTo) !== null
    || (state.allocation !== undefined && state.allocation !== 'all')
}

// ── The allocation narrowing ─────────────────────────────────────────────────
//
// HOW MUCH OF A PAYMENT HAS BEEN GIVEN A HOME — Finance's question, and only
// Finance's: an Order screen reads its own allocations, so it can never say what
// the REST of a payment is doing.
//
// THIS IS THE ONE NARROWING THAT NEEDS THE DATABASE TO CHANGE, and that is why
// it is gated. finance_received_payments deliberately exposes no allocated
// amount and no split (20260921000000 §8a), so the state cannot be filtered
// server-side against the projection as it stands. Filtering it in the browser
// is not an alternative: over a PAGED list that narrows fifty rows and silently
// hides every match on page two, which is precisely the class of defect the
// paging was introduced to end.
//
// So the states below are computed by a forward-only migration that adds
// `allocated_total` to the projection, and `allocationFilterAvailable` reports
// whether that migration has been applied. Until it has, the control is not
// offered at all — see the note on it. Nothing degrades to a wrong answer.

export type AllocationFilter = 'all' | 'unallocated' | 'partial' | 'full' | 'over'

export const ALLOCATION_FILTER_OPTIONS: { value: AllocationFilter; label: string }[] = [
  { value: 'all',         label: 'Any allocation' },
  { value: 'unallocated', label: 'Unallocated' },
  { value: 'partial',     label: 'Partly allocated' },
  { value: 'full',        label: 'Fully allocated' },
  // Kept, because the state is real even though the database refuses to create
  // it: the capacity trigger (20260918000000 §2) rejects an allocation that
  // would exceed its payment, so a row in this state is a signal that something
  // is wrong and must be findable rather than rounded into "Fully".
  { value: 'over',        label: 'Over-allocated' },
]

export function isAllocationFilter(value: string): value is AllocationFilter {
  return ALLOCATION_FILTER_OPTIONS.some(o => o.value === value)
}

/**
 * The projection column the allocation narrowing reads.
 *
 * `allocated_total` — the sum of a payment's ACTIVE allocations, computed in
 * `numeric` in the view. Named once so the filter, the availability probe and
 * the select list cannot disagree about it.
 */
export const ALLOCATED_TOTAL_COLUMN = 'allocated_total'

/**
 * The allocation narrowing as PostgREST filters.
 *
 * COMPARED AGAINST THE PAYMENT'S OWN AMOUNT, not against a constant, so the
 * boundaries are exact at any figure. PostgREST cannot compare two columns in a
 * filter, so the comparison is expressed as a boolean the VIEW computes —
 * `allocation_state` — for the three states that need it, and a plain numeric
 * test for the one that does not.
 *
 * `unallocated` IS A ZERO TEST, not an "is null" test. A payment with no
 * allocations sums to 0 through the view's coalesce, and null would mean the
 * column is missing rather than the money being free.
 */
export function allocationFilterClauses(filter: AllocationFilter): QueryClause[] {
  if (filter === 'all') return []
  return [{ kind: 'eq', column: 'allocation_state', value: filter }]
}

/**
 * Whether the allocation control may be offered.
 *
 * FAILS CLOSED. The projection gains `allocation_state` only when the
 * forward-only migration is applied; until then a probe of the view does not
 * return the column and this is false, so the control is not drawn and no query
 * is ever built against a column that does not exist. A filter that silently
 * matched nothing, or a request PostgREST refused outright, would both be worse
 * than an absent control.
 */
export function allocationFilterAvailable(
  probe: { columns: readonly string[] } | null | undefined,
): boolean {
  if (!probe) return false
  return probe.columns.includes('allocation_state')
    && probe.columns.includes(ALLOCATED_TOTAL_COLUMN)
}

// ── Re-export, so a caller needs one import for the whole read ───────────────
export type { PaymentLinkageMode }
