// ── What a payment is connected to ────────────────────────────────────────────
//
// THE ONE CLASSIFICATION, stated once, for Order Management and for Finance, and
// mirrored exactly by the `finance_received_payments` projection in SQL.
//
// A payment may be connected to one or more Confirmed Orders, to one or more PI
// Drafts, to BOTH at once through split allocations, or to nothing at all —
// money that arrived and still has to be given a home. Those four situations are
// the four views this module defines:
//
//   all         every payment in scope
//   orders      any money attributed to a Confirmed Order
//   pi_drafts   any money attributed to a PI Draft / submission
//   available   a positive unallocated balance
//
// THE FIRST THREE ARE NOT A PARTITION, AND MUST NOT BE. A payment split between
// an Order and a PI belongs in BOTH `orders` and `pi_drafts`, and a partly
// allocated payment appears in `available` as well as wherever its allocated
// half went. A filter that forced a payment into one bucket would have to pick a
// winner, and picking one is how a mixed payment becomes invisible from the
// other side.
//
// IT IS NOT A SECOND ATTRIBUTION FORMULA
// --------------------------------------
// Every figure below comes from the canonical rule in ./paymentAttribution.ts —
// the rule merged in PR #49 and implemented in SQL by order_linked_payment_total()
// and the finance_received_payments projection:
//
//   1. Any active allocation → the allocations are authoritative, and the
//      payment's own legacy `order_id` contributes NOTHING.
//   2. No active allocation → the legacy `order_id` attributes the WHOLE payment
//      to that Order.
//   3. A reversed allocation is a withdrawn claim and counts for nothing.
//   4. Whatever is left after active allocations is the AVAILABLE balance.
//   5. Attributed + available === the payment amount, exactly — except on an
//      over-allocated row, where the excess stays visible rather than being
//      capped.
//
// This module adds ONE thing the rule does not itself state: WHICH KIND of
// target each attributed rupee went to. That is a split of a figure the rule
// already produced, never a re-derivation of it.
//
// A RETIRED ORDER REQUEST ATTRIBUTES NOTHING, and that falls out of the rule
// rather than being a special case bolted on here. Rule 2 names `order_id` and
// only `order_id`; `order_request_id` has never attributed a rupee under the
// canonical rule. So a historical payment parked on an Order Request, with no
// allocations, reads as fully AVAILABLE — which is exactly what it now is, since
// the Order Request workflow is retired and that money needs a real home.
//
// WHAT `available` REQUIRES, AND WHY IT IS SOMETIMES WITHHELD
// ----------------------------------------------------------
// The balance is `amount - attributed`, and `attributed` turns on the total of
// EVERY active allocation against the payment — a fact a reader may not be
// entitled to see all of. finance_payment_allocations is read as the caller, so
// a reader who can see a payment through PI or Order participation sees only the
// allocations naming records THEY can open, and their sum understates.
//
// An understated `attributed` OVERSTATES `available`, which is the one direction
// that must never happen: it would tell somebody there is free money to allocate
// when there is not. So `available` is reported only when the reader's sight of
// the allocation table is COMPLETE for that payment — company-wide Finance sight
// or their own submitted payment, the same two cases
// payment_active_allocation_totals() already treats as complete. Otherwise it is
// null, and the payment simply does not appear in the `available` view.
//
// REJECTED MONEY IS NOT MONEY. A rejected payment is excluded from every view,
// including `all`. Awaiting-verification money is NOT excluded — it is real,
// recorded, and allocatable (allocate_payment_to_target admits it) — but it is
// reported under its own verification state so it is never added to verified
// money without somebody choosing to.

import {
  ZERO,
  addExact,
  clampAtZero,
  compareExact,
  exactToString,
  isZero,
  parseExact,
  subtractExact,
  type ExactDecimal,
} from './exactMoney'
import { paymentPosition } from './paymentAttribution'
import type { QueryClause } from '@/app/finance/listQuery'

// ── The four views ────────────────────────────────────────────────────────────

export const PAYMENT_VIEWS = ['all', 'orders', 'pi_drafts', 'available'] as const

export type PaymentView = typeof PAYMENT_VIEWS[number]

export function isPaymentView(value: string | null | undefined): value is PaymentView {
  return (PAYMENT_VIEWS as readonly string[]).includes(value ?? '')
}

/** The view a bad or missing query parameter resolves to. */
export const DEFAULT_PAYMENT_VIEW: PaymentView = 'all'

export function readPaymentView(raw: string | null | undefined): PaymentView {
  return isPaymentView(raw) ? raw : DEFAULT_PAYMENT_VIEW
}

export const PAYMENT_VIEW_OPTIONS: {
  value: PaymentView
  /** The tab label. */
  label: string
  /** One line under the list saying what the reader is looking at. */
  description: string
}[] = [
  { value: 'all',       label: 'All',       description: 'Every payment received, whatever it is attached to.' },
  { value: 'orders',    label: 'Orders',    description: 'Money attributed to one or more Confirmed Orders.' },
  { value: 'pi_drafts', label: 'PI Drafts', description: 'Money attributed to one or more PI Drafts awaiting approval.' },
  { value: 'available', label: 'Available', description: 'Money with an unallocated balance, waiting to be given a home.' },
]

export const PAYMENT_VIEW_LABEL: Record<PaymentView, string> =
  Object.fromEntries(PAYMENT_VIEW_OPTIONS.map(o => [o.value, o.label])) as Record<PaymentView, string>

// ── Verification, kept separate from attribution ──────────────────────────────
//
// TWO INDEPENDENT AXES, deliberately not folded together. Whether the money
// ARRIVED (verification) and whose business it BELONGS TO (attribution) are
// different questions decided by different people, and a screen that merged them
// would have to invent a precedence nobody chose.

export type PaymentVerification = 'verified' | 'awaiting' | 'rejected'

/**
 * The verification state of one payment, from its ledger status.
 *
 * The status vocabulary is finance_payment_requests': `approved_unlinked` and
 * `approved_linked` are verified money (CONFIRMED_PAYMENT_STATUSES in
 * ../../app/finance/paymentRouting.ts, and finance_payment_status_is_verified()
 * in SQL); `rejected` is refused money; everything else is still awaiting a
 * Finance decision.
 */
export function paymentVerification(status: string | null | undefined): PaymentVerification {
  if (status === 'approved_unlinked' || status === 'approved_linked') return 'verified'
  if (status === 'rejected') return 'rejected'
  return 'awaiting'
}

export const PAYMENT_VERIFICATION_LABEL: Record<PaymentVerification, string> = {
  verified: 'Verified',
  awaiting: 'Awaiting Verification',
  rejected: 'Rejected',
}

/**
 * The ledger statuses a classified payment may carry.
 *
 * Rejected money is excluded — it is not money, and counting it would inflate
 * every figure on every payments surface. Stated as a list rather than as "not
 * rejected" so the scope is a positive statement the SQL can mirror exactly.
 */
export const CLASSIFIED_PAYMENT_STATUSES = [
  'approved_unlinked',
  'approved_linked',
  'pending_approval',
  'needs_clarification',
] as const

export function isClassifiedPaymentStatus(status: string | null | undefined): boolean {
  return (CLASSIFIED_PAYMENT_STATUSES as readonly string[]).includes(status ?? '')
}

// ── One payment, classified ───────────────────────────────────────────────────

/**
 * The projection columns a classification needs.
 *
 * Named as a type rather than assembled ad hoc at each call site so a screen
 * cannot select four of the six and silently classify on a partial row. Every
 * amount is `string | number | null` because that is how `numeric` crosses the
 * wire, and nothing here may pass through binary floating point.
 */
export type ClassifiablePayment = {
  id: string
  amount: string | number | null
  status: string | null
  /** The payment's own legacy direct linkage. Rule 2's only input. */
  order_id: string | null
  /**
   * The sum of ACTIVE allocations naming a Confirmed Order, as the caller can
   * see them. Null when the column was not selected.
   */
  order_allocated_total?: string | number | null
  /** The same, for PI submissions. */
  pi_allocated_total?: string | number | null
  /** The sum of EVERY active allocation, whatever it names. */
  allocated_total?: string | number | null
  /** How many active allocations the caller can see. */
  active_allocation_count?: number | null
  /**
   * Whether this caller's sight of the allocation table is complete for this
   * payment — see the note at the top of the file. Absent is read as NOT
   * complete, which withholds `available` rather than guessing it.
   */
  attribution_complete?: boolean | null
}

export type PaymentClassification = {
  paymentId: string
  verification: PaymentVerification
  /** Exact, never negative. Money attributed to Confirmed Orders. */
  orderLinked: string
  /** Exact, never negative. Money attributed to PI Drafts. */
  piLinked: string
  /** orderLinked + piLinked. Equals the canonical attributed total. */
  attributed: string
  /** amount - attributed, floored at zero. Null when it may not be stated. */
  available: string | null
  /** How many active allocations the reader can see. */
  allocationCount: number
  /** True when attribution exceeds the payment. Never silently capped. */
  overAllocated: boolean
  /** The views this payment belongs to. A mixed payment belongs to several. */
  views: PaymentView[]
}

/**
 * One payment, under the canonical rule.
 *
 * ACTIVE ALLOCATION ROWS DECIDE EVERYTHING — the total, the Order/PI split and
 * the balance. The legacy `order_id` contributes nothing at all, so a payment
 * with no active allocation is attributed to nobody and its whole amount is
 * available, whatever that column says.
 */
export function classifyPayment(row: ClassifiablePayment): PaymentClassification {
  const verification = paymentVerification(row.status)
  const amount = parseExact(row.amount)
  const orderAllocated = parseExact(row.order_allocated_total) ?? ZERO
  const piAllocated = parseExact(row.pi_allocated_total) ?? ZERO
  const complete = row.attribution_complete === true

  // ALLOCATIONS DECIDE, and they decide the SPLIT as well as the total. There
  // is no second branch: a payment with no active allocation is attributed to
  // nobody, so both shares are zero and the whole amount is available. The
  // legacy `order_id` used to attribute the payment in full to an Order here;
  // it no longer enters the calculation at all.
  const orderShare: ExactDecimal = orderAllocated
  const piShare: ExactDecimal = piAllocated

  const attributed = addExact(orderShare, piShare)

  // ── The whole-payment position, from the canonical function, not restated ──
  //
  // paymentPosition owns `unallocated` and the over-allocation verdict. Deriving
  // them again here is exactly how two implementations of one rule begin to
  // disagree, which is the defect PR #49 exists to have ended.
  const position = paymentPosition({
    amount: row.amount,
    activeAllocationTotal: row.allocated_total,
  })

  // WITHHELD RATHER THAN GUESSED. An incomplete view of the allocations
  // understates `attributed`, which OVERSTATES the balance — the one direction
  // that would put money into an allocation queue that is not there.
  const available = complete ? position.unallocated : null

  const views: PaymentView[] = ['all']
  if (!isZero(orderShare)) views.push('orders')
  if (!isZero(piShare)) views.push('pi_drafts')
  if (available !== null) {
    const balance = parseExact(available)
    if (balance && !isZero(balance)) views.push('available')
  }

  return {
    paymentId: row.id,
    verification,
    orderLinked: exactToString(clampAtZero(orderShare)),
    piLinked: exactToString(clampAtZero(piShare)),
    attributed: exactToString(clampAtZero(attributed)),
    available,
    allocationCount: Math.max(0, row.active_allocation_count ?? 0),
    // OVER IS SHOWN, NEVER CAPPED. The capacity trigger refuses to create this
    // state, so a row here is legacy data that needs a person — and rounding it
    // away would erase the only evidence of it.
    overAllocated: position.state === 'over'
      || Boolean(amount && compareExact(attributed, amount) > 0),
    views,
  }
}

/** Whether one payment belongs in one view. The list filter's exact meaning. */
export function paymentIsInView(row: ClassifiablePayment, view: PaymentView): boolean {
  if (!isClassifiedPaymentStatus(row.status)) return false
  return classifyPayment(row).views.includes(view)
}

// ── The same classification, as a database narrowing ──────────────────────────
//
// THE FILTER AND THE COUNT ARE THE DATABASE'S, NOT THE BROWSER'S. The payments
// list is paged; a view computed over the fifty rows in hand would narrow those
// fifty and silently hide every match on page two, and the count beside it would
// describe a page rather than a set. So the projection carries three booleans
// and a balance, and the narrowing is a predicate over them.
//
// Every clause below narrows a set RLS has ALREADY decided the caller may see —
// finance_received_payments is security_invoker — so no filter here can widen
// anything.

/** The projection columns the classification reads. Named once. */
export const PAYMENT_CLASSIFICATION_COLUMNS = [
  'order_allocated_total',
  'pi_allocated_total',
  'allocated_total',
  'attributed_total',
  'available_balance',
  'active_allocation_count',
  'attribution_complete',
  'is_linked_to_order',
  'is_linked_to_pi',
  'is_available_to_allocate',
] as const

/** The classification narrowing as PostgREST filters. */
export function paymentViewClauses(view: PaymentView): QueryClause[] {
  if (view === 'orders') return [{ kind: 'eq', column: 'is_linked_to_order', value: 'true' }]
  if (view === 'pi_drafts') return [{ kind: 'eq', column: 'is_linked_to_pi', value: 'true' }]
  if (view === 'available') return [{ kind: 'eq', column: 'is_available_to_allocate', value: 'true' }]
  return []
}

/**
 * Whether the classification may be trusted for this reader at all.
 *
 * FAILS CLOSED, the same way allocationFilterAvailable does: the columns exist
 * only once the forward-only migration is applied, and until then the tabs are
 * not drawn and no query is ever built against a column that does not exist. A
 * filter that silently matched nothing would be worse than an absent control.
 */
export function paymentClassificationAvailable(
  probe: { columns: readonly string[] } | null | undefined,
): boolean {
  if (!probe) return false
  return PAYMENT_CLASSIFICATION_COLUMNS.every(column => probe.columns.includes(column))
}

// ── What a row says about itself ──────────────────────────────────────────────

/**
 * The money figures one payment row prints, already formatted as exact strings.
 *
 * Returned as data rather than as JSX so the numbers can be asserted directly —
 * a table cell is not a testable statement about money.
 */
export type PaymentRowFigures = {
  orderLinked: string
  piLinked: string
  available: string | null
  allocationCount: number
  verification: PaymentVerification
  overAllocated: boolean
}

export function paymentRowFigures(row: ClassifiablePayment): PaymentRowFigures {
  const classification = classifyPayment(row)
  return {
    orderLinked: classification.orderLinked,
    piLinked: classification.piLinked,
    available: classification.available,
    allocationCount: classification.allocationCount,
    verification: classification.verification,
    overAllocated: classification.overAllocated,
  }
}

/**
 * The conservation statement for a classified payment, so a test can assert the
 * law rather than re-deriving it.
 *
 * orderLinked + piLinked + available === amount, exactly, for every payment that
 * is neither over-allocated nor withheld. An over-allocated row fails it
 * DELIBERATELY: the excess is a defect in stored data and a function that
 * quietly rebalanced it would erase the only evidence.
 */
export function classificationConservationHolds(row: ClassifiablePayment): {
  holds: boolean
  reason: 'balanced' | 'over_allocated' | 'not_determinable'
} {
  const c = classifyPayment(row)
  if (c.overAllocated) return { holds: false, reason: 'over_allocated' }
  const amount = parseExact(row.amount)
  const order = parseExact(c.orderLinked)
  const pi = parseExact(c.piLinked)
  const available = parseExact(c.available)
  if (!amount || !order || !pi || !available) return { holds: false, reason: 'not_determinable' }
  const total = addExact(addExact(order, pi), available)
  return { holds: compareExact(total, amount) === 0, reason: 'balanced' }
}

/** The unattributed remainder, for a caller that has the two shares already. */
export function remainderOf(amount: string | number | null, attributed: string): string | null {
  const parsedAmount = parseExact(amount)
  const parsedAttributed = parseExact(attributed)
  if (!parsedAmount || !parsedAttributed) return null
  return exactToString(clampAtZero(subtractExact(parsedAmount, parsedAttributed)))
}
