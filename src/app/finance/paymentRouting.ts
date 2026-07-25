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
// all? Either kind of record counts:
//
//   linked   → order_id IS NOT NULL  OR  order_request_id IS NOT NULL
//   unlinked → order_id IS NULL     AND  order_request_id IS NULL
//
// An Order-Request linkage IS a linkage. The payment has been allocated: someone
// has said which piece of business it belongs to, and conversion later moves it
// onto the Order without anyone touching it again. Non-Linked is therefore not
// "no Confirmed Order yet" — it is the genuinely unallocated queue, money that
// has arrived with nothing at all pointing at it, which is the only set that
// needs someone to act.
//
// The two predicates are exhaustive and mutually exclusive over the pair of
// columns, so every received payment lands on exactly one page — asserted by the
// tests. 20260698's CHECK forbids both columns being set at once, so the OR only
// ever matches one of them in practice.

export type PaymentLinkageMode = 'linked' | 'unlinked'

export function linkageModeFor(row: {
  order_id: string | null
  order_request_id: string | null
}): PaymentLinkageMode {
  return (row.order_id || row.order_request_id) ? 'linked' : 'unlinked'
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

export const LINKED_OR_PREDICATE = 'order_id.not.is.null,order_request_id.not.is.null'

// Structural, not Supabase-typed: this only needs `.or()` and `.is()`, and
// naming them here keeps ../paymentRouting free of a supabase-js import (it is
// otherwise pure, and its tests run without one).
type LinkageScopable<T> = {
  or(filters: string): T
  is(column: string, value: null): T
}

export function applyLinkageScope<T extends LinkageScopable<T>>(
  query: T,
  mode: PaymentLinkageMode,
): T {
  return mode === 'linked'
    ? query.or(LINKED_OR_PREDICATE)
    : query.is('order_id', null).is('order_request_id', null)
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
}): LinkedAgainst {
  if (row.order_id) {
    const number = row.order_number ?? row.order_id
    return { kind: 'order', prefix: 'Order', number, label: `Order ${number}` }
  }
  if (row.order_request_id) {
    const number = row.order_request_number ?? row.order_request_id
    return { kind: 'request', prefix: 'Order Request', number, label: `Order Request ${number}` }
  }
  return { kind: 'none', label: 'Not linked' }
}
