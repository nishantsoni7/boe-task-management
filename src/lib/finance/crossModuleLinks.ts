// ── Where one module points at another ────────────────────────────────────────
//
// Order Management and Finance are two module views over ONE set of records. A
// reader who is looking at a payment on the Order screen and wants its full
// Finance history, or at a payment in Finance and wants the Order it belongs to,
// should not have to go back to a list and search. These are those routes, in
// one file, so a link's shape has one source and cannot drift from the route it
// points at.
//
// THREE RULES THIS FILE HOLDS ITSELF TO
// -------------------------------------
//
// 1. A LINK IS NOT A PERMISSION. Every href here reaches a page that re-reads
//    its record under the caller's own RLS and refuses anything they may not
//    open. Nothing is authorized by being linked to, and an id in a URL is not
//    a capability — which is the rule changePiHref (submissionWorkflow.ts)
//    already states for the Change PI route.
//
// 2. BUT A DEAD LINK IS STILL A DEFECT. The callers gate on the viewer's own
//    capabilities before drawing a control, so a reader is not offered a door
//    that will shut in their face. `canOpen…` below are those gates, stated
//    here so both modules ask the question the same way. They are a DRAWING
//    rule, never an authorization one.
//
// 3. NO NEW ROUTE IS INVENTED. Every target already exists and already handles
//    the parameters used here: /finance/received resolves ?payment= to whichever
//    of its two child pages holds the row and opens the details modal, which is
//    the behaviour the Admin Action Queue and Finance notifications already
//    rely on. This file adds navigation between existing screens and no screen
//    of its own.

/** The Finance query parameter that selects one payment. Named once. */
export const FINANCE_PAYMENT_PARAM = 'payment'

/**
 * One payment's Finance record.
 *
 * Deliberately the PARENT route and not one of the two child pages: whether a
 * payment is Linked or Non-Linked is a fact that changes when somebody
 * allocates it, and /finance/received resolves that itself and forwards. A
 * caller that guessed the child page would send a reader to the list that does
 * not hold the row.
 */
export function financePaymentHref(paymentId: string): string {
  return `/finance/received?${FINANCE_PAYMENT_PARAM}=${encodeURIComponent(paymentId)}`
}

/** One Confirmed Order. The same shape orderHref (finalApproval.ts) produces. */
export function orderDetailHref(orderId: string): string {
  return `/orders/${encodeURIComponent(orderId)}`
}

/** One PI submission. The same shape draftDetailHref (draftsView.ts) produces. */
export function piSubmissionHref(submissionId: string): string {
  return `/orders/drafts/${encodeURIComponent(submissionId)}`
}

// ── The drawing gates ─────────────────────────────────────────────────────────
//
// Each answers "would this reader get through the door?" using the capability
// the destination's own module gate requires — nothing finer. A reader may hold
// module entry and still be refused a particular record by RLS, and that is
// correct and unavoidable: the alternative is resolving every record's
// visibility before drawing a list, which is a round trip per row.
//
// The asymmetry is deliberate. Entry is cheap to know and already in hand on
// every one of these screens; per-record visibility is not, and guessing at it
// would be worse than a link that occasionally lands on "not available to you".

/**
 * Whether to offer a link into Finance.
 *
 * `finance.view` — module entry, which is exactly what /finance/layout.tsx
 * enforces. NOT finance.view_all: a reader who may see only their own payments
 * still legitimately opens the Finance record of a payment they submitted.
 */
export function canOpenFinanceRecord(canAccessFinanceModule: boolean | null | undefined): boolean {
  return Boolean(canAccessFinanceModule)
}

/**
 * Whether to offer a link into Order Management.
 *
 * `orders.view` — module entry, which is what /orders/layout.tsx enforces.
 * Holding it says nothing about which Orders are visible; the Order page reads
 * its own row under RLS and shows "not available" for one this reader may not
 * open.
 */
export function canOpenOrderRecord(canAccessOrdersModule: boolean | null | undefined): boolean {
  return Boolean(canAccessOrdersModule)
}

// ── What a Payment Request is FOR, as a door ─────────────────────────────────

/** The fields of a payment destination this needs — see paymentDestination.ts. */
export type LinkableDestination = {
  kind: 'confirmed_order' | 'pi_draft' | 'mixed' | 'suspense'
  orderId: string | null
  submissionId: string | null
  /**
   * The record's own reference, or null. The destinations projection is
   * security_invoker, so a single destination whose record the reader may NOT
   * open comes back with no reference ("Not visible to you"). That null is the
   * evidence this link needs.
   */
  reference: string | null
}

/**
 * The page of the ONE Order or PI Draft a payment is for — or null.
 *
 * All three must hold, or the cell stays plain text:
 *   1. the reader has Orders module entry (canOpenOrderRecord);
 *   2. the destination names exactly one record (a mixed or suspense payment
 *      names none, so it links to none);
 *   3. that record came back under the reader's OWN RLS (a reference was read).
 *
 * A visible name is not permission to open the record, and this adds none: the
 * destination page re-reads its row under the same session.
 */
export function destinationRecordHref(
  destination: LinkableDestination | null | undefined,
  canAccessOrdersModule: boolean,
): string | null {
  if (!canOpenOrderRecord(canAccessOrdersModule) || !destination || !destination.reference) return null
  if (destination.kind === 'confirmed_order' && destination.orderId) return orderDetailHref(destination.orderId)
  if (destination.kind === 'pi_draft' && destination.submissionId) return piSubmissionHref(destination.submissionId)
  return null
}
