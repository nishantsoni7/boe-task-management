// ── Who a payment's money belongs to ──────────────────────────────────────────
//
// THE ONE RULE, stated once, for every screen:
//
//   1. ACTIVE ALLOCATION ROWS ARE THE ONLY SOURCE OF ATTRIBUTION. Each Order or
//      PI receives the sum of the active allocations naming it, and nothing
//      else.
//   2. A payment with NO active allocation rows is attributed to nobody. It is
//      Zero Allocated, and its whole amount is unallocated — whatever
//      `order_id`, `order_request_id` or `payment_against` say.
//   3. Reversed allocations are not active and count for nothing.
//   4. Whatever is left over after active allocations is UNALLOCATED.
//   5. The sum attributed across every target, plus what is unallocated, is
//      exactly the payment amount — never more.
//
// THE FALLBACK THIS REPLACES
// --------------------------
// Rule 2 used to read the other way: a payment with no active allocation was
// attributed IN FULL to the Order its `order_id` named. That existed to protect
// a real invariant while both mechanisms were live — money linked the old way
// was genuinely committed, and calling it unallocated would have put it in
// Finance's suspense queue while an Order still counted it.
//
// Both mechanisms are no longer live. Link and Unlink are gone from the
// product, the allocation ledger is the only way funds are attached, and the
// legacy columns are dormant data that nothing writes. Keeping the fallback
// would mean money could still be reported as fully attributed with no
// allocation row standing behind it — an attribution nothing in the current
// product can create, correct or reverse, because reversal operates on
// allocation rows and there are none. So the fallback is removed, and
// attribution now has exactly one source.
//
// WHAT FOLLOWS FROM THAT. Attribution to a target no longer depends on any fact
// beyond the target's own allocations — there is no rule left that turns on
// whether the payment has allocations elsewhere. `attributeToTarget` therefore
// needs no whole-payment total, and cannot be indeterminate: a target's share is
// the sum of the rows naming it, which the caller either has or has not read.

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
  /** Active allocations naming this target. The only way money is attributed. */
  | 'allocation'
  /** No active allocation names this target, so it is attributed nothing. */
  | 'none'

export type TargetAttribution = {
  paymentId: string
  /** This target's share, exact. Never negative, never more than the payment. */
  share: string
  basis: AttributionBasis
}

export type AttributionInput = {
  paymentId: string
  /** The active allocations naming THIS target. Empty when there are none. */
  ownActiveAllocations: readonly (string | number | null)[]
}

/**
 * What one Order or PI is attributed from one payment.
 *
 * The sum of the active allocations naming this target, and nothing else. No
 * legacy linkage, and so no dependence on what the payment does elsewhere: this
 * is the whole rule, which is why it takes one input.
 */
export function attributeToTarget(input: AttributionInput): TargetAttribution {
  const own = sumOwnShares(input.ownActiveAllocations)
  if (own.count === 0) {
    return { paymentId: input.paymentId, share: exactToString(ZERO), basis: 'none' }
  }
  return { paymentId: input.paymentId, share: exactToString(own.total), basis: 'allocation' }
}

/**
 * Where a payment stands as a whole: how much is spoken for, how much is free,
 * and what to call that.
 *
 * `unallocated` READS THE ALLOCATION ROWS AND NOTHING ELSE. A payment with no
 * active allocation is Zero Allocated and free in full, whatever legacy linkage
 * columns it carries — see rule 2 at the top of this file.
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
}): PaymentPosition {
  const amount = parseExact(input.amount)
  const activeTotal = parseExact(input.activeAllocationTotal)

  // No readable total means no position. Never "unallocated" on a gap: that is
  // the distinction paymentAllocations.ts refuses to collapse, for the same
  // reason.
  if (activeTotal === null) {
    return { attributed: null, unallocated: null, state: 'unknown' }
  }

  // Rule 1 — active allocation rows decide, and are the only thing that does.
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

  // Rule 2 — no active allocation row, so nothing is attributed and the whole
  // amount is free. Legacy linkage columns do not enter this.
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
