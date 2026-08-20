// ── Finance payment routing rules ─────────────────────────────────────────────
// The pure half of one question: where does a payment record belong, and what is
// it attached to? Both Finance pages read these functions rather than repeating
// the predicates inline, so Payment Requests and Received Payments can never
// drift into showing the same row twice — or into showing it nowhere.
//
// Nothing here touches Supabase, permissions, or approval. It maps an already
// loaded row to a destination and a label; every gate stays where it already is
// (RLS, the approval guard triggers, and the linkage RPCs).

// ── Stage 1: the Payment Request ──────────────────────────────────────────────
// A record is a Payment Request only while it is still awaiting a decision, or
// carrying one that keeps it in the requester's hands. The moment an admin
// confirms the money arrived it stops being a request and becomes a received
// payment — a different page, a different workflow, and view-only here.
//
// These are exactly the statuses the Payment Requests page may load. It is the
// same list the page already sends as a server-side filter on every update and
// delete it issues (UNAPPROVED_STATUSES), so the query scope and the mutation
// guard cannot disagree about what a request is.

export const REQUEST_STAGE_STATUSES = [
  'pending_approval',
  'needs_clarification',
  'rejected',
] as const

export type RequestStageStatus = typeof REQUEST_STAGE_STATUSES[number]

export function isRequestStageStatus(status: string): boolean {
  return (REQUEST_STAGE_STATUSES as readonly string[]).includes(status)
}

// ── Stage 2: the received payment ─────────────────────────────────────────────
// The two approved statuses, and the only two. approved_unlinked is money
// received with no Confirmed Order behind it yet; approved_linked is money
// attached to one. Both belong to Received Payments.

export const CONFIRMED_PAYMENT_STATUSES = [
  'approved_unlinked',
  'approved_linked',
] as const

export function isConfirmedPayment(status: string): boolean {
  return (CONFIRMED_PAYMENT_STATUSES as readonly string[]).includes(status)
}

// The two sets are disjoint and together cover every status the table allows —
// asserted by the tests, so adding a sixth status without deciding where it
// belongs fails loudly instead of making a record vanish from both pages.

// ── Which Received Payments page ──────────────────────────────────────────────
// The split axis is ALLOCATION — is this money attached to a business record at
// all? Three things count, and any one of them is enough:
//
//   linked   → an ACTIVE allocation naming a Confirmed Order   (is_order_allocated)
//              OR order_id IS NOT NULL                          (legacy Order link)
//              OR order_request_id IS NOT NULL                  (Order-Request link)
//   unlinked → none of the three
//
// THE ALLOCATION BRANCH IS PHASE 3's. Approving a PI moves its active
// allocations onto the new Order and deliberately leaves the parent payment
// alone — its proof, its verification and the reference the salesperson typed
// all stay where they are, so it still carries `order_id = NULL` and
// `approved_unlinked`. Without this branch that money would sit in Non-Linked
// Payments, which claims to be "money with nothing at all pointing at it", and
// the counters beside it would over-report. The ledger is not rewritten to fix
// that; the READ is corrected, from the allocation table that has been the
// source of truth for what money belongs to since Phase 1.
//
// AN ORDER-REQUEST LINKAGE IS STILL A LINKAGE, unchanged. The payment has been
// allocated: someone has said which piece of business it belongs to, and
// conversion later moves it onto the Order without anyone touching it again.
// Non-Linked is therefore not "no Confirmed Order yet" — it is the genuinely
// unallocated queue, which is the only set that needs someone to act.
//
// The two predicates are exhaustive and mutually exclusive by construction — the
// second is the exact negation of the first — so every received payment lands on
// exactly one page, asserted by the tests. 20260698's CHECK forbids both parent
// columns being set at once, so the OR only ever matches one of them in practice.

/**
 * The allocation-aware projection both Received Payments pages and the sidebar
 * counters read.
 *
 * A `security_invoker` VIEW over finance_payment_requests (20260921000000 §8a):
 * every underlying policy is evaluated as the caller, so it can show nothing the
 * base tables would not, and it yields exactly one row per payment. Named once
 * here so the lists and the counts cannot end up reading different things.
 *
 * EVERY MUTATION STILL TARGETS THE BASE TABLE by the payment's own id — the
 * projection is read-only and carries no write privilege at all.
 */
export const RECEIVED_PAYMENTS_SOURCE = 'finance_received_payments'

export type PaymentLinkageMode = 'linked' | 'unlinked'

export function linkageModeFor(row: {
  order_id: string | null
  order_request_id: string | null
  /**
   * Whether an ACTIVE allocation names a Confirmed Order. Absent on a row read
   * straight from the base table, where it is simply unknown — and treated as
   * false, which is exactly the pre-Phase-3 answer.
   */
  is_order_allocated?: boolean | null
}): PaymentLinkageMode {
  return (row.is_order_allocated || row.order_id || row.order_request_id) ? 'linked' : 'unlinked'
}

// ── The same rule, as a database predicate ────────────────────────────────────
// linkageModeFor classifies a row already in hand; the two Received Payments
// pages and the sidebar counts have to ask the DATABASE the same question
// instead — the pages so they never hold each other's rows, the counts so they
// never pull thousands of rows down just to length them.
//
// Both go through applyLinkageScope, so the list a page shows and the number the
// sidebar prints beside it are the same query shape by construction. Writing the
// filters out at a third call site is what would let them drift.

export const LINKED_OR_PREDICATE =
  'is_order_allocated.is.true,order_id.not.is.null,order_request_id.not.is.null'

// Structural, not Supabase-typed: this only needs `.or()` and `.is()`, and
// naming them here keeps ../paymentRouting free of a supabase-js import (it is
// otherwise pure, and its tests run without one).
type LinkageScopable<T> = {
  or(filters: string): T
  is(column: string, value: null | boolean): T
}

/**
 * The same rule as a database filter, applied to a query over
 * RECEIVED_PAYMENTS_SOURCE.
 *
 * The unlinked branch is the EXACT NEGATION of the linked one — all three
 * conditions false — so the two scopes partition the confirmed set and a payment
 * can never appear on both pages or on neither.
 */
export function applyLinkageScope<T extends LinkageScopable<T>>(
  query: T,
  mode: PaymentLinkageMode,
): T {
  return mode === 'linked'
    ? query.or(LINKED_OR_PREDICATE)
    : query.is('is_order_allocated', false).is('order_id', null).is('order_request_id', null)
}

// ── What a payment is linked against ──────────────────────────────────────────
// One resolution, used by both Received Payments tables, in strict priority:
//
//   1. a Confirmed Order      → "Order ORD-2026-0007"
//   2. an Order Request       → "Order Request REQ-2026-0024"
//   3. neither                → "Not linked"
//
// The Order wins whenever both are somehow present, so a request that has since
// been converted reads as its Order without anything having to migrate the row's
// display. (20260698 adds a CHECK forbidding both columns at once, so in
// practice the ordering only ever settles the null cases — it is stated
// explicitly here so the rule survives that constraint being relaxed.)
//
// `number` falls back to the id only when the denormalised number column is
// missing, which no current write path produces. It exists so a half-written row
// still identifies itself instead of rendering a bare prefix.

export type LinkedAgainst =
  | { kind: 'order';   prefix: 'Order';         number: string; label: string }
  | { kind: 'request'; prefix: 'Order Request'; number: string; label: string }
  | { kind: 'none';    label: 'Not linked' }

export function resolveLinkedAgainst(row: {
  order_id: string | null
  order_number: string | null
  order_request_id: string | null
  order_request_number: string | null
  /** The Confirmed Order an ACTIVE allocation names, from the projection. */
  allocated_order_id?: string | null
  allocated_order_number?: string | null
}): LinkedAgainst {
  if (row.order_id) {
    const number = row.order_number ?? row.order_id
    return { kind: 'order', prefix: 'Order', number, label: `Order ${number}` }
  }
  // THE ALLOCATION, SECOND AND AHEAD OF THE REQUEST. A Confirmed Order is the
  // more final fact, and the priority above already says the Order wins whenever
  // both are somehow present. The label is identical in shape to the legacy one
  // — the row simply stops reading "Not linked" for money that is attached.
  //
  // The number falls back to the id when the reader may not open that Order:
  // whether the money is allocated is derived from the ALLOCATION, so a caller
  // who cannot see the Order still sees the linkage and loses only its number.
  if (row.allocated_order_id) {
    const number = row.allocated_order_number ?? row.allocated_order_id
    return { kind: 'order', prefix: 'Order', number, label: `Order ${number}` }
  }
  if (row.order_request_id) {
    const number = row.order_request_number ?? row.order_request_id
    return { kind: 'request', prefix: 'Order Request', number, label: `Order Request ${number}` }
  }
  return { kind: 'none', label: 'Not linked' }
}

// ── Who may VERIFY a payment, and when ────────────────────────────────────────
//
// THE DEFECT THIS EXISTS TO PREVENT RECURRING. Verification used to be reachable
// from exactly one place: clicking a table row, which opened the review modal
// only when the viewer held the approval capability. The row's explicit "View"
// button — the obvious action in the action column — opened the DETAILS modal
// instead, and that modal had no verification control at all. An administrator
// who took the obvious route could send a payment back or reject it, but could
// not confirm it. The rule now lives here, in one place, so both surfaces ask
// the same question.
//
// This is a DRAWING rule, never an authorization one. Every call to
// approve_finance_payment_request re-derives the actor, the finance.approve
// permission and the row's status under a row lock, so hiding the control
// protects nobody and showing it grants nothing.

/**
 * Whether a Verify Payment control should be offered.
 *
 * `mayApprove` is the finance.approve capability — deliberately NOT
 * finance.manage, finance.view, finance.view_all or finance.allocate. Correcting
 * a recorded payment, seeing payments and deciding which business money belongs
 * to are three different authorities, and none of them is the authority to say
 * the money arrived.
 *
 * Only `pending_approval` is verifiable. A payment awaiting clarification or
 * already rejected has to travel back through the existing correction and
 * reapply route first — the RPC refuses anything else, and this agrees with it.
 */
export function canVerifyPayment(
  status: string | null | undefined,
  mayApprove: boolean | null | undefined,
): boolean {
  return Boolean(mayApprove) && status === 'pending_approval'
}
