// ── What the Received Payments list asks the database ─────────────────────────
//
// What is SPECIFIC to Received Payments: which columns a search matches, what
// each of the four classification views narrows to, and what an allocation state
// narrows to. The rules
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
//    filter that claims to find it. That filter is now the canonical
//    classification (src/lib/finance/paymentClassification.ts), computed by the
//    projection, so the narrowing and the figures beside it are one statement.
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
import {
  PAYMENT_CLASSIFICATION_COLUMNS,
  paymentViewClauses,
  type PaymentView,
} from '@/lib/finance/paymentClassification'

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
  // KEPT, THOUGH THE WORKFLOW IS RETIRED. Historical payments still carry a
  // request number, a Finance user reconciling an old record still has it
  // written down, and a search that could not find the row would be a search
  // that lies about its own scope. Nothing here offers the workflow; it finds a
  // record that exists.
  'order_request_number',
  'allocated_order_number',
] as const

/** The `or=` filter for a term across every column this list searches. */
export function receivedPaymentsSearchFilter(raw: string): string | null {
  return searchFilter(raw, RECEIVED_PAYMENTS_SEARCH_COLUMNS)
}

// ── The classification narrowing ─────────────────────────────────────────────
//
// THE FOUR VIEWS — All, Orders, PI Drafts, Available — are defined ONCE, in
// src/lib/finance/paymentClassification.ts, and mirrored by the
// finance_received_payments projection in SQL. This module re-exports them
// rather than restating them, because the whole point of one canonical
// classification is that Order Management and Finance cannot end up narrowing
// differently.
//
// WHAT THEY REPLACED. A `LinkageFilter` of All / Confirmed Order / Order Request
// lived here and split the Linked page's rows by which of two columns was set.
// Both halves of that are now wrong: the Order Request workflow is retired
// (20261007000000) so its branch narrows to a set nothing can add to, and the
// pair could not express a payment SPLIT between an Order and a PI Draft, which
// belongs in both views at once.

export {
  PAYMENT_VIEWS,
  PAYMENT_VIEW_LABEL,
  PAYMENT_VIEW_OPTIONS,
  DEFAULT_PAYMENT_VIEW,
  CLASSIFIED_PAYMENT_STATUSES,
  isPaymentView,
  readPaymentView,
  paymentClassificationAvailable,
  PAYMENT_CLASSIFICATION_COLUMNS,
} from '@/lib/finance/paymentClassification'
export type { PaymentView } from '@/lib/finance/paymentClassification'

/**
 * The classification narrowing as PostgREST filters.
 *
 * Re-exported under this module's name so a page needs one import for the whole
 * read, and so the call site reads as "narrow this payments list", not as
 * "reach into the classification module".
 */
export function paymentViewFilterClauses(view: PaymentView): QueryClause[] {
  return paymentViewClauses(view)
}

/** The projection columns a classified row needs selected. Named once. */
export const RECEIVED_PAYMENTS_CLASSIFICATION_COLUMNS = PAYMENT_CLASSIFICATION_COLUMNS

// ── What the toolbar says it is doing ────────────────────────────────────────

/**
 * True when anything is narrowing the list, so the page can offer to clear it.
 *
 * THE VIEW IS NOT A NARROWING, and that is why it is absent here.
 *
 * A tab is where the reader IS; a filter is something they applied on top and
 * can clear. Counting the tab as a narrowing would offer "Clear filters" on a
 * freshly opened Available tab and then, on pressing it, leave them exactly
 * where they were — the control would appear to do nothing.
 */
export function isNarrowed(state: {
  search: string
  dateFrom: string | null
  dateTo: string | null
  allocation?: AllocationFilter
}): boolean {
  return sanitizeSearchTerm(state.search) !== ''
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
