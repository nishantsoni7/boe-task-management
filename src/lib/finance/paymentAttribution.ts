// ── Who a payment's money belongs to ──────────────────────────────────────────
//
// THE ONE RULE, stated once, for every screen and mirrored exactly by
// order_linked_payment_total() and finance_received_payments in SQL.
//
//   1. If a payment has ANY active allocation, the allocations are
//      authoritative. Each Order or PI receives only its own active allocated
//      share, and the legacy direct linkage is ignored entirely.
//   2. If it has NO active allocation, the legacy direct linkage — the
//      payment's own order_id — attributes the WHOLE payment to that Order.
//   3. Reversed allocations are not active and count for nothing. A payment
//      whose only allocation was reversed falls back to rule 2.
//   4. Whatever is left over after active allocations is UNALLOCATED.
//   5. The sum attributed across every target, plus what is unallocated, is
//      exactly the payment amount — never more.
//
// THE DEFECT THIS REPLACES
// ------------------------
// The old rule was "the legacy link wins": a payment carrying order_id = X was
// credited to X AT ITS FULL AMOUNT, whatever its allocations said. That is
// arithmetically unsound the moment both exist, and both CAN exist —
// allocate_payment_to_target() refuses a rejected payment, a duplicate active
// allocation and an over-capacity one, but it does NOT refuse a payment that
// already carries an order_id.
//
// So a ₹10,00,000 payment linked to Order X and allocated ₹4,00,000 to Order Y
// was credited ₹10,00,000 to X *and* ₹4,00,000 to Y — ₹14,00,000 of attribution
// for ₹10,00,000 of money, with the overstatement landing on the Order that had
// received nothing. Every screen agreed with every other screen, and all of them
// were wrong together.
//
// WHY THE WHOLE-PAYMENT TOTAL IS AN INPUT
// ---------------------------------------
// Rule 1 turns on a fact no single Order can see for itself: whether the payment
// has active allocations ELSEWHERE. An Order reads only the allocations naming
// it, and RLS would not show it an allocation onto somebody else's Order anyway.
// `activeAllocationTotal` is that fact, supplied by the caller from a source
// that can see the whole payment — payment_active_allocation_totals() in the
// database, or the Finance projection's allocated_total.
//
// WHEN IT IS NOT KNOWN, THE FALLBACK IS NOT APPLIED. `null` means "we could not
// determine this", and the rule then attributes only what is provably this
// target's — its own active allocations. That under-states rather than
// over-states, which is the only safe direction: rule 5 says the total may never
// exceed the payment, and a wrong "this Order has been paid in full" is the
// failure that matters.

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

/** How a target came to be attributed part of a payment. */
export type AttributionBasis =
  /** Active allocations naming this target. */
  | 'allocation'
  /** The payment's own direct linkage, used because it has no active allocation. */
  | 'legacy'
  /** Nothing attributes this payment to this target. */
  | 'none'
  /**
   * The payment has a direct linkage to this target, but whether it has active
   * allocations elsewhere could not be determined — so the fallback was withheld
   * rather than guessed. Attributes only what is provably this target's.
   */
  | 'indeterminate'

export type TargetAttribution = {
  paymentId: string
  /** This target's share, exact. Never negative, never more than the payment. */
  share: string
  basis: AttributionBasis
}

export type AttributionInput = {
  paymentId: string
  /** The payment's full ledger amount, exactly as `numeric` sent it. */
  amount: string | number | null
  /**
   * The total of EVERY active allocation against this payment, wherever it
   * points. Null when the caller could not determine it — see the note above.
   */
  activeAllocationTotal: string | number | null | undefined
  /** The active allocations naming THIS target. Empty when there are none. */
  ownActiveAllocations: readonly (string | number | null)[]
  /** True when the payment's own direct linkage names this target. */
  directlyLinkedToTarget: boolean
}

/**
 * What one Order or PI is attributed from one payment.
 *
 * THE ALLOCATION BRANCH IS CHECKED FIRST AND IS TOTAL. If the payment has any
 * active allocation at all, the direct linkage contributes nothing — not even
 * when this target is the one it names. That is rule 1, and it is what stops the
 * same rupee being counted once as a link and again as an allocation.
 */
export function attributeToTarget(input: AttributionInput): TargetAttribution {
  const own = sumOwnShares(input.ownActiveAllocations)
  const activeTotal = parseExact(input.activeAllocationTotal)

  // Rule 1 — allocations exist, so allocations decide. This target gets its own
  // share, which is legitimately ZERO when the money went somewhere else.
  if (own.count > 0 || (activeTotal && !isZero(activeTotal))) {
    return { paymentId: input.paymentId, share: exactToString(own.total), basis: 'allocation' }
  }

  // The total could not be determined. The fallback is withheld: what is
  // provably this target's is its own allocations, which here is nothing.
  if (activeTotal === null && input.directlyLinkedToTarget) {
    return { paymentId: input.paymentId, share: exactToString(own.total), basis: 'indeterminate' }
  }

  // Rule 2 — no active allocation anywhere, so the direct linkage attributes the
  // WHOLE payment to the target it names.
  if (input.directlyLinkedToTarget) {
    const amount = parseExact(input.amount)
    return {
      paymentId: input.paymentId,
      share: amount ? exactToString(amount) : exactToString(ZERO),
      basis: amount ? 'legacy' : 'none',
    }
  }

  return { paymentId: input.paymentId, share: exactToString(ZERO), basis: 'none' }
}

/**
 * Where a payment stands as a whole: how much is spoken for, how much is free,
 * and what to call that.
 *
 * `unallocated` HONOURS THE DIRECT LINKAGE. A payment linked to an Order with no
 * allocations is fully attributed to that Order, so nothing about it is free —
 * reporting the whole amount as unallocated would put money into Finance's
 * suspense queue that is already committed, and would break rule 5 in the other
 * direction (the Order counts it, and so would "unallocated").
 */
export type PaymentPosition = {
  /** Total attributed across every target. Null when it could not be determined. */
  attributed: string | null
  /** amount - attributed, floored at zero. Null when not determinable. */
  unallocated: string | null
  state: 'unallocated' | 'partial' | 'full' | 'over' | 'unknown'
}

export function paymentPosition(input: {
  amount: string | number | null
  /** Total of every active allocation, or null when unknown. */
  activeAllocationTotal: string | number | null | undefined
  /** True when the payment carries a direct linkage to some Order. */
  hasDirectLink: boolean
}): PaymentPosition {
  const amount = parseExact(input.amount)
  const activeTotal = parseExact(input.activeAllocationTotal)

  // No readable total means no position. Never "unallocated" on a gap: that is
  // the distinction paymentAllocations.ts refuses to collapse, for the same
  // reason.
  if (activeTotal === null) {
    return { attributed: null, unallocated: null, state: 'unknown' }
  }

  // Rule 1 — allocations decide.
  if (!isZero(activeTotal)) {
    if (!amount) return { attributed: exactToString(activeTotal), unallocated: null, state: 'unknown' }
    const comparison = compareExact(activeTotal, amount)
    return {
      attributed: exactToString(activeTotal),
      unallocated: exactToString(clampAtZero(subtractExact(amount, activeTotal))),
      // OVER IS SHOWN, NEVER CAPPED. The capacity trigger
      // (20260918000000 §2) refuses to create this state and the amount guard
      // refuses to lower a payment into it, so a row here is legacy data that
      // needs a person — and rounding it into 'full' would hide exactly that.
      state: comparison > 0 ? 'over' : comparison === 0 ? 'full' : 'partial',
    }
  }

  // Rule 2 — no active allocation. A direct linkage attributes the whole
  // payment, so nothing is free.
  if (input.hasDirectLink) {
    return {
      attributed: amount ? exactToString(amount) : null,
      unallocated: amount ? exactToString(ZERO) : null,
      state: amount ? 'full' : 'unknown',
    }
  }

  return {
    attributed: exactToString(ZERO),
    unallocated: amount ? exactToString(amount) : null,
    state: 'unallocated',
  }
}

/**
 * The conservation invariant, as a checkable statement.
 *
 * attributed + unallocated === amount, exactly, for every payment that is not
 * over-allocated. Exposed so tests and assertions state the same law the rule is
 * built to satisfy rather than re-deriving it.
 *
 * An OVER-ALLOCATED payment fails it deliberately and reports so: the excess is
 * a defect in stored data, and a function that quietly rebalanced it would erase
 * the only evidence.
 */
export function conservationHolds(input: {
  amount: string | number | null
  position: PaymentPosition
}): { holds: boolean; reason: 'balanced' | 'over_allocated' | 'not_determinable' } {
  if (input.position.state === 'over') return { holds: false, reason: 'over_allocated' }
  const amount = parseExact(input.amount)
  const attributed = parseExact(input.position.attributed)
  const unallocated = parseExact(input.position.unallocated)
  if (!amount || !attributed || !unallocated) return { holds: false, reason: 'not_determinable' }
  return {
    holds: compareExact(addExact(attributed, unallocated), amount) === 0,
    reason: 'balanced',
  }
}

function sumOwnShares(shares: readonly (string | number | null)[]): { total: ExactDecimal; count: number } {
  let total: ExactDecimal = ZERO
  let count = 0
  for (const share of shares) {
    const parsed = parseExact(share)
    if (!parsed) continue
    total = addExact(total, parsed)
    count++
  }
  return { total, count }
}
