// ── Finance payment TARGETS ───────────────────────────────────────────────────
// The pure half of the other question a payment record answers: which stage of
// the sales lifecycle was this money submitted against?
//
// THREE STORED VALUES, NONE OF WHICH A FORM CHOOSES ANY MORE:
//
//   New Order       'unallocated'     money arrived with no Confirmed Order
//                                     behind it. Nothing to link yet; it is
//                                     allocated later, to an Order or to a PI.
//   Confirmed Order 'confirmed_order' the order is approved and numbered. The
//                                     money belongs to that Order.
//   Order Request   'order_request'   RETIRED. Historical rows still carry this
//                                     value and are still labelled by it, but it
//                                     is offered by no form and refused by the
//                                     database (20261007000000).
//
// THE VALUE IS NOT REMOVED FROM THE VOCABULARY, and must not be. Payments
// submitted against an Order Request before the retirement still carry
// `payment_target_type = 'order_request'`, and a screen that could not name that
// value would print a blank where a historical fact belongs.
//
// Nothing here touches Supabase, permissions or approval. It names a stored
// value, so this page, the review modal and the tests all read one definition.
// Every gate stays where it already is: RLS, the
// finance_payment_requests_derive_target trigger (which re-derives every
// authoritative value server-side), and the approval / conversion RPCs.
//
// See paymentRouting.ts for the SEPARATE question of where an already-submitted
// record is displayed. Target is about origin; routing is about current state.

// NO FORM CHOOSES A TARGET FROM HERE ANY MORE. Since 20261013000000 both
// payment-entry forms ask ONE question, from ONE list — PI Draft, Confirmed
// Order, Suspense Entry (src/lib/finance/paymentEntry.ts) — and a Payment
// Request's chosen destination is recorded as an allocation INTENT rather than
// in the payment row's linkage columns. So the selector this module used to
// feed (PaymentTargetFields, PAYMENT_TARGET_OPTIONS, PaymentTargetState,
// switchTarget, buildTargetPayload and the Confirmed-Order option type) is
// deleted rather than left behind for something to call: two lists of
// destinations is exactly the drift the redesign removed.
//
// WHAT REMAINS IS THE READING HALF. payment_target_type is still stored, still
// derived server-side, and still names what a HISTORICAL row was raised
// against — including 'order_request', which no form has offered since
// 20261007000000. A screen that could not name that value would print a blank
// where a fact belongs.

// ── The three targets ─────────────────────────────────────────────────────────

export const PAYMENT_TARGET_TYPES = [
  'unallocated',
  'order_request',
  'confirmed_order',
] as const

export type PaymentTargetType = typeof PAYMENT_TARGET_TYPES[number]

export function isPaymentTargetType(value: string): value is PaymentTargetType {
  return (PAYMENT_TARGET_TYPES as readonly string[]).includes(value)
}

/**
 * ── NOT A DESTINATION LABEL. Do not reach for this one. ──
 *
 * These name what payment_target_type says, and payment_target_type is derived
 * from the payment row's own order_id (finance_payment_requests_derive_target,
 * 20260715000000 §2). Since 20261013000000 the entry doors deliberately leave
 * order_id NULL for EVERY destination, so this column reads 'unallocated' — and
 * this map reads "New Order" — on a request that names a Confirmed Order just as
 * it does on a Suspense entry. Printing it beside a payment is what produced
 * "New Order — no order created yet" on a fully allocated Order.
 *
 * WHAT A SCREEN SHOULD READ INSTEAD: finance_payment_destinations, through
 * src/lib/finance/paymentDestination.ts. It derives the destination from ACTIVE
 * allocations first and PENDING intents second, which is where the answer
 * actually lives.
 *
 * This map survives for the ACTIVITY TRAIL and for the tests that pin the
 * historical vocabulary — a 2026 event payload still carries the column, and a
 * history view has to be able to read what it said at the time.
 */
export const PAYMENT_TARGET_LABEL: Record<PaymentTargetType, string> = {
  unallocated:     'New Order',
  order_request:   'Order Request',
  confirmed_order: 'Confirmed Order',
}

// ── Origin flag ───────────────────────────────────────────────────────────────
// payment_against predates the three-target model and still has exactly two
// values. It is DERIVED from the target — server-side by
// finance_payment_requests_derive_target, and here so the client sends a
// consistent payload rather than a value the trigger has to correct.
//
// Anything that is not a Confirmed Order is 'new_order': it has no Order behind
// it and approves to suspense rather than straight to a linked payment. The
// retired Order Request target derived the same value, which is why nothing
// about historical rows changes.

export function paymentAgainstFor(target: PaymentTargetType): 'new_order' | 'existing_order' {
  return target === 'confirmed_order' ? 'existing_order' : 'new_order'
}

// The inverse, for reading a HISTORICAL row back. order_request_id is what
// separates the two new_order targets — exactly the rule the migration's
// backfill applies, so a row classified here and a row classified by the
// database agree. No new row can be produced with 'order_request'; this branch
// exists so old ones still name themselves correctly.
export function targetTypeOf(row: {
  payment_against: string
  order_request_id: string | null
}): PaymentTargetType {
  if (row.payment_against === 'existing_order') return 'confirmed_order'
  return row.order_request_id ? 'order_request' : 'unallocated'
}

// Prefer the stored column when the caller has it; fall back to deriving it, so
// a component that has not been updated to select the column still renders a
// correct label instead of blank.
export function readTargetType(row: {
  payment_target_type?: string | null
  payment_against: string
  order_request_id: string | null
}): PaymentTargetType {
  const stored = row.payment_target_type
  if (typeof stored === 'string' && isPaymentTargetType(stored)) return stored
  return targetTypeOf(row)
}

// ── Failure messages ──────────────────────────────────────────────────────────
// finance_payment_requests_derive_target and approve_finance_payment_request
// raise greppable code prefixes, one per rule. Each maps to a sentence naming
// the rule that refused, so the reader knows whether to pick a different record,
// ask for access, or reload — never a single "please try again" that hides
// which of the three it was.
//
// Returns null when the failure is not a target failure, so the caller can fall
// through to its own generic mapping rather than mislabelling an unrelated
// error.

export function paymentTargetErrorMessage(message: string | null | undefined): string | null {
  const m = message ?? ''
  // The retirement guard (20261007000000 §3). Tested FIRST because it is the
  // refusal a caller reaching for the retired workflow will now actually get,
  // and because it is the only one of these that tells them what to do instead.
  if (m.includes('ORDER_REQUESTS_RETIRED')) {
    return 'Order Requests are retired. Attach this payment to a Confirmed Order, or record it as a New Order payment and allocate it to a PI Draft.'
  }
  if (m.includes('ORDER_REQUEST_NOT_PERMITTED')) {
    return 'You cannot attach a payment to this Order Request. It belongs to another salesperson.'
  }
  if (m.includes('ORDER_REQUEST_CONVERTED')) {
    return 'That Order Request has already been converted to a Confirmed Order. Choose Confirmed Order and select it instead.'
  }
  if (m.includes('ORDER_REQUEST_NOT_ACTIVE')) {
    return 'That Order Request is no longer open for new payments. Refresh and choose another target.'
  }
  if (m.includes('ORDER_REQUEST_NOT_AVAILABLE') || m.includes('ORDER_REQUEST_NOT_FOUND')) {
    return 'That Order Request is no longer available. Refresh and select it again.'
  }
  if (m.includes('ORDER_REQUEST_NO_CLIENT')) {
    return 'That Order Request has no client name on file. Correct the request before submitting a payment against it.'
  }
  if (m.includes('PAYMENT_TARGET_CHANGED')) {
    return 'This payment request was re-targeted while you were approving it. Refresh and try again.'
  }
  if (m.includes('finance_payment_requests_one_link_target')) {
    return 'A payment request can be attached to an Order Request or a Confirmed Order, never both.'
  }
  if (m.includes('finance_payment_requests_request_link_invariant')) {
    return 'This payment request cannot hold an Order Request link in its current state.'
  }
  if (m.includes('An existing order must be selected')) {
    return 'Select the Confirmed Order this payment belongs to.'
  }
  return null
}
