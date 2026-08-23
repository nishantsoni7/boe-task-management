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

// ── The one payments surface, and how a row is classified ────────────────────
//
// WHAT USED TO BE HERE, AND WHY IT IS GONE
// ----------------------------------------
// `linkageModeFor`, `applyLinkageScope`, `LINKED_OR_PREDICATE` and
// `resolveLinkedAgainst` split every received payment into "Linked" and
// "Non-Linked" across two sibling pages, and the split counted THREE things as a
// linkage: an active allocation onto an Order, the payment's own `order_id`, and
// an `order_request_id`.
//
// The third of those was the load-bearing one, and it is no longer true. It read
// "someone has said which piece of business this belongs to, and conversion will
// move it onto the Order by itself" — but the Order Request workflow is retired
// (20261007000000), nothing will ever convert, and the canonical attribution
// rule has never attributed a rupee through `order_request_id` in any case: rule
// 2 names `order_id` and only `order_id`. So money parked on a retired request
// was being shown as spoken for while every figure beside it said it was free.
//
// It was also the wrong SHAPE. A payment split between an Order and a PI Draft
// belongs in both of those views and, if anything is left over, in Available
// too — three memberships a two-page partition cannot express, and which is
// exactly what a payments surface has to show.
//
// The replacement is ONE classification, defined once in
// src/lib/finance/paymentClassification.ts and computed by the
// finance_received_payments projection, filtered and counted in the DATABASE so
// it survives paging. Nothing in this file decides it any more.

/**
 * The allocation-aware projection every payments surface and counter reads.
 *
 * A `security_invoker` VIEW over finance_payment_requests (20260921000000 §8a,
 * extended by 20261004000000 and 20261008000000): every underlying policy is
 * evaluated as the caller, so it can show nothing the base tables would not, and
 * it yields exactly one row per payment. Named once here so the lists and the
 * counts cannot end up reading different things.
 *
 * EVERY MUTATION STILL TARGETS THE BASE TABLE by the payment's own id — the
 * projection is read-only and carries no write privilege at all.
 */
export const RECEIVED_PAYMENTS_SOURCE = 'finance_received_payments'

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
