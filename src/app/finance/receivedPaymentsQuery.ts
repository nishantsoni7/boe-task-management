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
 * `human_payment_id` LEADS — it is now THE Payment ID shown to users
 * (20261011000000 §1), and the row's Payment ID column prints it, not
 * `request_number`. `request_number` stays searchable too: it is still in the
 * database and still on historical records somebody may have written down.
 * `allocated_order_number` is here for the same reason as both — the row
 * displays it, so the row must be findable by it.
 */
export const RECEIVED_PAYMENTS_SEARCH_COLUMNS = [
  'human_payment_id',
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
}): boolean {
  return sanitizeSearchTerm(state.search) !== ''
    || dateBound(state.dateFrom) !== null
    || dateBound(state.dateTo) !== null
}

// ── The allocation narrowing, and why it is not here any more ────────────────
//
// A `<select>` used to offer Any allocation / Unallocated / Partly / Fully /
// Over-allocated, backed by ALLOCATION_FILTER_OPTIONS, allocationFilterClauses()
// and a feature-probe, allocationFilterAvailable(). All of it is gone.
//
// It was the SECOND control for one narrowing. CONFIRMED_ALLOCATION_FILTERS in
// paymentSurfaces.ts offers the identical five states over the same
// `confirmed_allocation_status` column in the same query, as the tab strip the
// page leads with — so the two could be set to contradict each other and the
// reader had to know which won. The tabs are what survives.
//
// The probe went with it, and that is a round trip saved on every page load: it
// existed only to decide whether to draw the dropdown.
