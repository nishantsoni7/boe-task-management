// ── Finance payment TARGETS ───────────────────────────────────────────────────
// The pure half of the other question a payment record answers: which stage of
// the sales lifecycle was this money submitted against?
//
// THREE STORED VALUES, TWO OF WHICH A FORM MAY STILL CHOOSE:
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
// value would print a blank where a historical fact belongs. What is removed is
// the CHOICE: PAYMENT_TARGET_OPTIONS no longer offers it, so no new payment can
// be raised against one.
//
// Nothing here touches Supabase, permissions or approval. It maps a form state
// to a submission payload and back, so the modal, the edit form and the tests
// all read one definition. Every gate stays where it already is: RLS, the
// finance_payment_requests_derive_target trigger (which re-derives every
// authoritative value server-side and is what actually enforces the rules
// below), and the approval / conversion RPCs.
//
// See paymentRouting.ts for the SEPARATE question of where an already-submitted
// record is displayed. Target is about origin; routing is about current state.

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

export const PAYMENT_TARGET_LABEL: Record<PaymentTargetType, string> = {
  unallocated:     'New Order',
  order_request:   'Order Request',
  confirmed_order: 'Confirmed Order',
}

/**
 * The targets a NEW payment may be raised against.
 *
 * TWO, NOT THREE. Order Request was the third and is retired: the workflow no
 * longer exists, the database refuses a payment that names one, and a card
 * offering it would be an invitation to a submission the trigger would reject.
 *
 * Money that belongs to a PI Draft is NOT a third card here. A PI is reached
 * through ALLOCATION, not through the payment's own linkage columns — the
 * schema has no `order_submission_id` on the payment row — so it is recorded as
 * New Order money and allocated afterwards, which is what the allocation
 * controls on the payments surface are for.
 */
export const SELECTABLE_PAYMENT_TARGET_TYPES = ['unallocated', 'confirmed_order'] as const

export type SelectablePaymentTargetType = typeof SELECTABLE_PAYMENT_TARGET_TYPES[number]

export function isSelectablePaymentTarget(value: string): value is SelectablePaymentTargetType {
  return (SELECTABLE_PAYMENT_TARGET_TYPES as readonly string[]).includes(value)
}

// Card copy for the selector. The description is what stops the choice from
// being a guess: each names the situation it is for, not what it does to the
// database.
export const PAYMENT_TARGET_OPTIONS: {
  value: SelectablePaymentTargetType
  label: string
  description: string
}[] = [
  {
    value: 'unallocated',
    label: PAYMENT_TARGET_LABEL.unallocated,
    description: 'No confirmed Order yet — allocate it later',
  },
  {
    value: 'confirmed_order',
    label: PAYMENT_TARGET_LABEL.confirmed_order,
    description: 'Against an approved, numbered Order',
  },
]

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

// ── Selectable records ────────────────────────────────────────────────────────

// THE ORDER REQUEST OPTION IS GONE. `OrderRequestOption`,
// `ORDER_REQUEST_SELECTABLE_STATUSES`, `isSelectableOrderRequest` and
// `orderRequestResultLabel` lived here and existed for one purpose: letting a
// submission form search Order Requests and attach money to one. That is the
// retired workflow, and the database now refuses the write
// (20261007000000 §3) — so the search, its status whitelist and its result
// label are removed rather than left behind for something to call.

export type ConfirmedOrderOption = {
  id: string
  display_number: string
  client_name: string
  status: string
  total_value: number | null
}

// Result rows, one line each, prefixed with what kind of record they are so a
// reader scanning a dropdown never has to infer it from the number format.
export function confirmedOrderResultLabel(o: Pick<ConfirmedOrderOption, 'display_number' | 'client_name'>): string {
  return `Confirmed Order · ${o.display_number} · ${o.client_name}`
}

// ── Form state ────────────────────────────────────────────────────────────────
// One object holding the choice AND both possible selections. Keeping the two
// selections in the state rather than in a union is what makes switchTarget's
// clearing rule explicit and testable — the alternative (dropping the field
// when the variant changes) makes "did switching clear it?" unanswerable.

export type PaymentTargetState = {
  target: SelectablePaymentTargetType
  /** Typed by hand. Used ONLY when target is 'unallocated'. */
  manualClientName: string
  selectedOrder: ConfirmedOrderOption | null
}

export const EMPTY_TARGET_STATE: PaymentTargetState = {
  target: 'unallocated',
  manualClientName: '',
  selectedOrder: null,
}

// Switching target CLEARS every field the new target cannot carry — including
// the client name, which belongs to the selected record for two of the three
// targets and must never be a leftover from the one before.
//
// Switching to the SAME target is a no-op on the selections, so a re-render or
// a double click on the active card cannot wipe a selection the user made.
export function switchTarget(
  state: PaymentTargetState,
  target: SelectablePaymentTargetType,
): PaymentTargetState {
  if (target === state.target) return state
  return {
    target,
    manualClientName: '',
    selectedOrder: null,
  }
}

// The client name that will actually be submitted. For the two linked targets it
// comes from the selected record and the manual field is not consulted at all —
// the database re-derives it either way (derive_target for a request,
// enforce_finance_payment_request_client_name for an Order), so this only
// decides what the form shows and sends.
export function targetClientName(state: PaymentTargetState): string {
  switch (state.target) {
    case 'confirmed_order': return state.selectedOrder?.client_name?.trim() ?? ''
    default:                return state.manualClientName.trim()
  }
}

// Is the target half of the form complete? A linked target needs its record
// selected, and every target needs a non-empty client name — which for a linked
// target means the selected record actually has one on file, a condition the
// database also refuses (ORDER_REQUEST_NO_CLIENT / the existing Order message).
export function isTargetComplete(state: PaymentTargetState): boolean {
  if (state.target === 'confirmed_order' && !state.selectedOrder) return false
  return targetClientName(state) !== ''
}

// ── Submission payload ────────────────────────────────────────────────────────

export type PaymentTargetPayload = {
  client_name: string
  payment_against: 'new_order' | 'existing_order'
  order_id: string | null
  order_number: string | null
  order_request_id: string | null
  order_request_number: string | null
}

// The linkage half of an insert/update payload, built so that AT MOST ONE of
// order_id / order_request_id is ever non-null. Both are always PRESENT as keys,
// which is what makes this safe to spread over an UPDATE: switching target has
// to null the columns the previous target used, and an omitted key would leave
// them behind.
//
// order_request_id and order_request_number are ALWAYS NULL now, and they are
// still SENT. The keys have to be present so that spreading this over an UPDATE
// clears a retired linkage a historical row is carrying rather than leaving it
// behind — which is also the one way a request-linked payment can be moved onto
// a real target. Sending them as null is not a write the retirement guard
// refuses: it refuses ESTABLISHING a link, never clearing one.
//
// payment_target_type is NOT in this payload, and that is the design: the
// database derives it from the linkage columns below, so there is exactly one
// thing a caller has to get right instead of two that could contradict.
export function buildTargetPayload(state: PaymentTargetState): PaymentTargetPayload {
  const base = {
    client_name: targetClientName(state),
    payment_against: paymentAgainstFor(state.target),
    order_id: null,
    order_number: null,
    order_request_id: null,
    order_request_number: null,
  } as PaymentTargetPayload

  if (state.target === 'confirmed_order' && state.selectedOrder) {
    return {
      ...base,
      order_id: state.selectedOrder.id,
      order_number: state.selectedOrder.display_number,
    }
  }
  return base
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
