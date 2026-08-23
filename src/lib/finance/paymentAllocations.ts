// ── How much of a payment has been given a home ───────────────────────────────
//
// Finance's question, and only Finance's: a payment is one sum of money that may
// be split across several PIs and Orders, and somebody has to be able to see how
// much of it is still sitting unassigned. The Order screen deliberately cannot
// answer this — it reads only its OWN allocations, so "the rest of this payment"
// is, from there, money it knows nothing about.
//
// WHAT IT READS, AND WHY THAT IS ENOUGH
// -------------------------------------
// finance_payment_allocations, in ONE bounded query keyed on the payment ids
// already on screen. Not a row per payment — that would be the N+1 this codebase
// is careful about — and not an unbounded scan either: the list is paged, so the
// id set is at most one page long.
//
// It is not read through finance_received_payments, which exposes no allocation
// id, no allocated amount and no split by design (20260921000000 §8a). This is
// the table itself, under its own RLS: admin, finance.view_all, the payment's
// own submitter, a PI participant, or an Order participant. Being able to SEE an
// allocation grants no authority to create, reverse, verify or correct one —
// there is no INSERT, UPDATE or DELETE policy on that table for any role.
//
// THE STATE THAT MATTERS MOST IS "UNKNOWN"
// ----------------------------------------
// A caller may legitimately be allowed to read a PAYMENT and not its
// ALLOCATIONS — the two have different policies, and finance.view without
// finance.view_all is exactly that case. When no allocation row comes back there
// are two possible worlds: the money is genuinely unallocated, or the reader is
// not entitled to see where it went. Those must never collapse into the same
// answer, because one of them would tell a Finance user that verified money is
// sitting in suspense when it is not. `unknown` is that distinction, and it is
// the DEFAULT: a payment is only called unallocated when its allocations were
// actually readable and actually summed to nothing.

import {
  ZERO,
  addExact,
  compareExact,
  exactToString,
  isZero,
  parseExact,
  subtractExact,
  type ExactDecimal,
} from './exactMoney'

/**
 * One payment, as the summary reads it.
 *
 * `hasDirectLink` is the payment's own order_id. It matters because the
 * canonical attribution rule (paymentAttribution.ts) uses the direct link as a
 * FALLBACK when a payment has no active allocation — so a linked payment with no
 * allocations is attributed in full to that Order and is NOT free money. Calling
 * it "Unallocated" here would put committed rupees into Finance's suspense
 * queue and would count the same money twice across the two modules.
 */
export type SummarisablePayment = {
  id: string
  amount: string | number | null
  hasDirectLink?: boolean
}

/** One allocation row, as the bounded read returns it. */
export type PaymentAllocationRow = {
  id: string
  payment_request_id: string
  allocated_amount: string | number | null
  status: string
  order_id: string | null
  order_submission_id: string | null
}

/**
 * Where one live allocation points, resolved for display.
 *
 * The NUMBER is optional and its absence is not an error: whether money is
 * allocated is derived from the ALLOCATION, so a reader who may not open the
 * target still sees that the money is spoken for and loses only its name. That
 * is the same choice the finance_received_payments projection makes for
 * allocated_order_number.
 */
export type AllocationTarget = {
  allocationId: string
  kind: 'order' | 'submission'
  targetId: string
  /** The display number, when the caller could read the target. */
  label: string | null
  amount: string
}

export type PaymentAllocationState = 'unknown' | 'unallocated' | 'partial' | 'full' | 'over'

/** What Finance knows about one payment's allocations. */
export type PaymentAllocationSummary = {
  paymentId: string
  state: PaymentAllocationState
  /** Total of ACTIVE allocations, exact. Null when nothing was readable. */
  allocated: string | null
  /** amount - allocated, floored at zero. Null when not computable. */
  unallocated: string | null
  /** The live allocations, newest target first. Empty when none or none readable. */
  targets: AllocationTarget[]
}

export const ALLOCATION_STATE_LABEL: Record<PaymentAllocationState, string> = {
  // "Not visible to you" and not "unknown": the reader is being told the limit
  // of their own sight, which is a fact about them, not a defect in the data.
  unknown:     'Not visible to you',
  unallocated: 'Unallocated',
  partial:     'Partly allocated',
  full:        'Fully allocated',
  // A guard rail, not an expected state: the database's capacity trigger
  // (20260918000000 §2) refuses an allocation that would exceed the payment. If
  // one is ever seen it must be shown, never rounded down into "Fully".
  over:        'Over-allocated',
}

/**
 * Group a bounded allocation read by payment, and classify each one.
 *
 * `payments` is every payment the caller is asking about — its ids decide which
 * summaries exist, so a payment with NO allocation rows still gets an answer
 * rather than being missing from the map.
 *
 * `readable` says whether the allocation read itself succeeded. When it did not
 * — a refusal, a network failure — every payment is `unknown`, because a failed
 * read is emphatically not evidence that money is unallocated.
 */
export function summarizePaymentAllocations(
  payments: readonly SummarisablePayment[],
  allocations: readonly PaymentAllocationRow[],
  options: {
    readable?: boolean
    /**
     * Whether an EMPTY allocation list for a payment is conclusive — whether it
     * really means "no allocation exists" rather than "none that you may see".
     *
     * THIS IS THE WHOLE SAFETY OF THE `unallocated` LABEL. A caller holding
     * finance.view but not finance.view_all reads PAYMENTS through one RLS
     * policy and ALLOCATIONS through another: they can be entitled to a payment
     * and not to the allocations that spend it, in which case the read succeeds
     * and comes back empty for money that is fully allocated. Calling that
     * "Unallocated" would put verified money into a Finance user's suspense
     * queue that is not in suspense.
     *
     * So it DEFAULTS TO FALSE. Only a reader who can see every allocation —
     * admin, or finance.view_all — may be told "unallocated" on the strength of
     * an empty list. Everyone else is told the truthful thing, which is that
     * they cannot see.
     */
    emptyIsConclusive?: boolean
    /** Display numbers for allocation targets, by target id, where readable. */
    labels?: ReadonlyMap<string, string>
  } = {},
): Map<string, PaymentAllocationSummary> {
  const readable = options.readable !== false
  const emptyIsConclusive = options.emptyIsConclusive === true
  const labels = options.labels ?? new Map<string, string>()

  const byPayment = new Map<string, PaymentAllocationRow[]>()
  if (readable) {
    for (const row of allocations) {
      // ACTIVE ONLY. A reversed allocation is a claim that was withdrawn; it
      // stays in the Finance trail, where its reason is, and it is not money
      // that is currently spoken for.
      if (row.status !== 'active') continue
      const list = byPayment.get(row.payment_request_id) ?? []
      list.push(row)
      byPayment.set(row.payment_request_id, list)
    }
  }

  const result = new Map<string, PaymentAllocationSummary>()

  for (const payment of payments) {
    const rows = byPayment.get(payment.id) ?? []

    // A failed read is emphatically not evidence that money is unallocated, and
    // neither is an empty one from a reader who may not see every allocation.
    if (!readable || (rows.length === 0 && !emptyIsConclusive)) {
      result.set(payment.id, unknownSummary(payment.id))
      continue
    }

    const amount = parseExact(payment.amount)
    let allocated: ExactDecimal = ZERO
    const targets: AllocationTarget[] = []

    for (const row of rows) {
      const share = parseExact(row.allocated_amount)
      if (share) allocated = addExact(allocated, share)

      const kind: 'order' | 'submission' = row.order_id ? 'order' : 'submission'
      const targetId = row.order_id ?? row.order_submission_id
      // An allocation names exactly one target — the database's
      // finance_payment_allocations_one_target CHECK guarantees it. A row with
      // neither could only be a corrupt one, and is skipped rather than shown
      // pointing nowhere.
      if (!targetId) continue

      targets.push({
        allocationId: row.id,
        kind,
        targetId,
        label: labels.get(targetId) ?? null,
        amount: share ? exactToString(share) : String(row.allocated_amount ?? ''),
      })
    }

    if (!amount) {
      // The payment's own amount could not be read, so no comparison is
      // possible. The allocations themselves are still reportable.
      result.set(payment.id, {
        paymentId: payment.id,
        state: 'unknown',
        allocated: rows.length > 0 ? exactToString(allocated) : null,
        unallocated: null,
        targets,
      })
      continue
    }

    const remaining = subtractExact(amount, allocated)
    const comparison = compareExact(allocated, amount)

    // THE DIRECT-LINK FALLBACK, so this panel and the Orders describe the same
    // money. A payment with no active allocation but a direct link is attributed
    // in full to the Order that link names — worked example A — so nothing about
    // it is free. Reporting it as unallocated would have the same rupees
    // counted by an Order AND sitting in Finance's suspense queue.
    if (isZero(allocated) && payment.hasDirectLink) {
      result.set(payment.id, {
        paymentId: payment.id,
        state: 'full',
        allocated: exactToString(ZERO),
        unallocated: exactToString(ZERO),
        targets,
      })
      continue
    }

    result.set(payment.id, {
      paymentId: payment.id,
      state: isZero(allocated) ? 'unallocated'
        : comparison > 0 ? 'over'
        : comparison === 0 ? 'full'
        : 'partial',
      allocated: exactToString(allocated),
      unallocated: comparison >= 0 ? exactToString(ZERO) : exactToString(remaining),
      targets,
    })
  }

  return result
}

function unknownSummary(paymentId: string): PaymentAllocationSummary {
  return { paymentId, state: 'unknown', allocated: null, unallocated: null, targets: [] }
}

/**
 * The summary to show while the allocation read is still in flight, or when the
 * caller has not asked for one.
 *
 * `unknown` and never `unallocated`, for the reason above: a list that painted
 * "Unallocated" on every row for a moment and then corrected itself would be
 * telling Finance something untrue, briefly, about every payment on the screen.
 */
export const PENDING_ALLOCATION_SUMMARY = (paymentId: string): PaymentAllocationSummary =>
  unknownSummary(paymentId)
