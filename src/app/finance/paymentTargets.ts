// ── Finance payment TARGETS ───────────────────────────────────────────────────
// The pure half of the other question a payment record answers: which stage of
// the sales lifecycle was this money submitted against?
//
// Three targets, and only three. They are not three shades of one idea — they
// carry different linkage columns, different permissions and different approval
// behaviour, which is why the submission form offers them as three explicit
// choices rather than folding two of them together:
//
//   New Order       'unallocated'     money arrived, no Order Request and no
//                                     Confirmed Order exists. Nothing to link.
//   Order Request   'order_request'   an Order Request exists and has not been
//                                     approved or converted. The advance belongs
//                                     to that proposed order, and the admin
//                                     reviewing the request has to see it before
//                                     deciding.
//   Confirmed Order 'confirmed_order' the order is approved and numbered. The
//                                     money belongs to that Order.
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

// Card copy for the three-way selector. The description is what stops the
// choice from being a guess: each names the situation it is for, not what it
// does to the database.
export const PAYMENT_TARGET_OPTIONS: {
  value: PaymentTargetType
  label: string
  description: string
}[] = [
  {
    value: 'unallocated',
    label: PAYMENT_TARGET_LABEL.unallocated,
    description: 'No Order Request or Order yet',
  },
  {
    value: 'order_request',
    label: PAYMENT_TARGET_LABEL.order_request,
    description: 'Advance against a request awaiting approval',
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
// Both New Order and Order Request are 'new_order': neither has a Confirmed
// Order behind it, and both approve to suspense rather than straight to a
// linked payment.

export function paymentAgainstFor(target: PaymentTargetType): 'new_order' | 'existing_order' {
  return target === 'confirmed_order' ? 'existing_order' : 'new_order'
}

// The inverse, for reading a row back. order_request_id is what separates the
// two new_order targets — exactly the rule the migration's backfill applies, so
// a row classified here and a row classified by the database agree.
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

export type OrderRequestOption = {
  id: string
  request_number: string
  client_name: string
  status: string
  total_value: number | null
}

export type ConfirmedOrderOption = {
  id: string
  display_number: string
  client_name: string
  status: string
  total_value: number | null
}

// Which Order Request statuses may receive a NEW payment request. Deliberately
// narrower than the admin linkage RPC's list, which also accepts 'rejected'
// (20260699 §2, a separate and deliberate decision about already-approved
// money): a rejected request is not a proposed order anyone should be raising
// fresh advances against. finance_payment_requests_derive_target enforces
// exactly this list server-side for a pre-approval payment.
export const ORDER_REQUEST_SELECTABLE_STATUSES = ['submitted', 'needs_clarification'] as const

export function isSelectableOrderRequest(r: { status: string }): boolean {
  return (ORDER_REQUEST_SELECTABLE_STATUSES as readonly string[]).includes(r.status)
}

// Result rows, one line each, prefixed with what kind of record they are so a
// reader scanning a dropdown never has to infer it from the number format.
export function orderRequestResultLabel(r: Pick<OrderRequestOption, 'request_number' | 'client_name'>): string {
  return `Order Request · ${r.request_number} · ${r.client_name}`
}

export function confirmedOrderResultLabel(o: Pick<ConfirmedOrderOption, 'display_number' | 'client_name'>): string {
  return `Confirmed Order · ${o.display_number} · ${o.client_name}`
}

// ── Form state ────────────────────────────────────────────────────────────────
// One object holding the choice AND both possible selections. Keeping the two
// selections in the state rather than in a union is what makes switchTarget's
// clearing rule explicit and testable — the alternative (dropping the field
// when the variant changes) makes "did switching clear it?" unanswerable.

export type PaymentTargetState = {
  target: PaymentTargetType
  /** Typed by hand. Used ONLY when target is 'unallocated'. */
  manualClientName: string
  selectedRequest: OrderRequestOption | null
  selectedOrder: ConfirmedOrderOption | null
}

export const EMPTY_TARGET_STATE: PaymentTargetState = {
  target: 'unallocated',
  manualClientName: '',
  selectedRequest: null,
  selectedOrder: null,
}

// Switching target CLEARS every field the new target cannot carry — including
// the client name, which belongs to the selected record for two of the three
// targets and must never be a leftover from the one before.
//
// Switching to the SAME target is a no-op on the selections, so a re-render or
// a double click on the active card cannot wipe a selection the user made.
export function switchTarget(state: PaymentTargetState, target: PaymentTargetType): PaymentTargetState {
  if (target === state.target) return state
  return {
    target,
    manualClientName: '',
    selectedRequest: null,
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
    case 'order_request':   return state.selectedRequest?.client_name?.trim() ?? ''
    case 'confirmed_order': return state.selectedOrder?.client_name?.trim() ?? ''
    default:                return state.manualClientName.trim()
  }
}

// Is the target half of the form complete? A linked target needs its record
// selected, and every target needs a non-empty client name — which for a linked
// target means the selected record actually has one on file, a condition the
// database also refuses (ORDER_REQUEST_NO_CLIENT / the existing Order message).
export function isTargetComplete(state: PaymentTargetState): boolean {
  if (state.target === 'order_request'   && !state.selectedRequest) return false
  if (state.target === 'confirmed_order' && !state.selectedOrder)   return false
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
// order_request_number is deliberately sent as NULL even when the selected
// request's number is known. It is derived server-side from the locked
// order_requests row (derive_target §4), so sending a client value would only
// create a second, unauthoritative source for it. order_number keeps the
// existing behaviour of carrying the selected Order's display number.
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

  if (state.target === 'order_request' && state.selectedRequest) {
    return { ...base, order_request_id: state.selectedRequest.id }
  }
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
