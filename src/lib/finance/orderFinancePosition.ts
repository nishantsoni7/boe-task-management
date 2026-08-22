// ── The Confirmed Order's finance position ────────────────────────────────────
//
// ONE definition of what an Order has received, what Finance has verified, what
// is still waiting on Finance, what was refused, and how much of each payment
// actually belongs to THIS Order. The Order detail screen reads this and nothing
// else; it computes no money of its own.
//
// WHY THIS MODULE EXISTS
// ----------------------
// A PI's position is computed in the database by pi_submission_payment_summary()
// in `numeric`. A Confirmed Order has no such function — approve_order_submission()
// MOVES a PI's allocations onto the Order and deliberately leaves the payment
// rows alone, so the Order screen has always had to add the rows up itself. It
// did so with `Number()` and `+`, and three things followed from that:
//
//   1. THE TWO MODULES COULD DISAGREE. The same money, summed in `numeric` on
//      the PI and in binary floating point on the Order, is not guaranteed to
//      produce the same string. Every figure here is exact — see exactMoney.ts.
//
//   2. "RECEIVED" MEANT VERIFIED. The Order's summary counted only verified
//      money but called it Received, so a payment the client had genuinely made
//      and Finance had not yet looked at was, on that screen, money that did not
//      exist. The three states are now three separate figures with their own
//      names, which is the distinction the business actually makes.
//
//   3. THE TABLE DID NOT RECONCILE WITH THE SUMMARY. The total counted each
//      payment's ALLOCATED share; the list beside it printed the payment's FULL
//      ledger amount. For a payment split across two Orders those are different
//      numbers, and a reader adding the column by eye got a total that did not
//      match the tile above it. Both now come from the same field.
//
// WHAT IT DOES NOT DO
// -------------------
// It reads. It creates nothing, re-links nothing and decides nothing. Which
// rows reach it is RLS's answer — the caller passes exactly what the two
// anchored, Order-scoped reads returned — and every approval gate stays where it
// is, in the database. No figure here is an input to approve_order_submission(),
// which re-derives all of its own under row locks.
//
// THE STATUS VOCABULARY IS NOT RESTATED. Verified is
// isVerifiedPaymentStatus() from orderPayments.ts, which mirrors
// finance_payment_status_is_verified() (20260918000000 §5); awaiting is
// isAwaitingVerification() from piPaymentView.ts, which mirrors the database's
// unverified branch. Naming a third list here is how the two would drift.

import {
  ZERO,
  addExact,
  clampAtZero,
  compareExact,
  exactToString,
  parseExact,
  percentTrunc,
  subtractExact,
  type ExactDecimal,
} from './exactMoney'
import { isAwaitingVerification } from './piPaymentView'
import { isVerifiedPaymentStatus, type OrderPaymentRow } from '@/lib/orders/orderPayments'

/**
 * A payment as the Order's finance position reads it.
 *
 * Structurally what mergeOrderPayments() returns, plus the two EXACT strings the
 * float-typed fields lose. mergeOrderPayments keeps `amount` and
 * `allocatedAmount` as JS numbers because the list has always sorted and
 * rendered with them; the exact strings are what the totals are built from, so a
 * total can never inherit a rounding the display introduced.
 */
export type OrderFinancePaymentRow = OrderPaymentRow & {
  /** The payment's full ledger amount, exactly as `numeric` sent it. */
  exactAmount: string
  /** This Order's share of it, exactly as `numeric` sent it. */
  exactAllocatedAmount: string
  /**
   * True when this Order's share is LESS than the payment's ledger amount —
   * the money is split, and some of it belongs somewhere else.
   *
   * Never true for a legacy linked payment, whose share is the whole amount by
   * definition. Used only to decide whether the row explains itself; it is not a
   * total and gates nothing.
   */
  isPartialShare: boolean
}

/** Every figure the Order's payment summary states, all exact decimal strings. */
export type OrderFinancePosition = {
  /** orders.total_value, or null when the Order carries none. */
  orderValue: string | null
  /**
   * Money Finance has CONFIRMED arrived, at this Order's allocated share.
   * The figure the business treats as paid.
   */
  verified: string
  /**
   * Money that has been recorded against this Order and is still waiting on a
   * Finance decision — pending_approval and needs_clarification.
   *
   * NOT part of `verified` and never added to it. It is money the client says
   * they sent; whether it arrived is Finance's answer, not this screen's.
   */
  awaitingVerification: string
  /** Money recorded against this Order that Finance REFUSED. Counted in nothing. */
  rejected: string
  /**
   * verified + awaitingVerification — everything recorded against this Order
   * that has not been refused.
   *
   * THE HONEST MEANING OF "RECEIVED": what has come in, whatever Finance has
   * done about it yet. Stated separately from `verified` so the screen can show
   * both without either standing in for the other.
   */
  received: string
  /** orderValue - verified, floored at zero. Null when the Order has no value. */
  pendingBalance: string | null
  /** verified as a percentage of orderValue, truncated to 2dp. Null if not computable. */
  verifiedPercent: string | null
  /** received as a percentage of orderValue, truncated to 2dp. Null if not computable. */
  receivedPercent: string | null
  /** True when verified alone already covers the Order's value. */
  fullyPaid: boolean
  /**
   * Payments whose ledger amount is only PARTLY this Order's, and the part that
   * is not. Empty for the ordinary case.
   *
   * WHY THIS IS NOT CALLED "UNALLOCATED". The money outside this Order's share
   * may be allocated to another Order, to a PI, or to nothing at all — and this
   * screen cannot tell which, because it reads only THIS Order's allocations.
   * Claiming it is unallocated would be a statement about records the reader has
   * not been shown. The Finance module answers that question, from the payment's
   * own allocations; the Order says only "part of this payment is elsewhere".
   */
  splitPayments: { paymentId: string; elsewhere: string }[]
  /** Row counts, so the screen can label its groups without re-filtering. */
  counts: { total: number; verified: number; awaiting: number; rejected: number }
}

/**
 * The exact allocated share and ledger amount for each merged payment row.
 *
 * mergeOrderPayments() has already done the joining, the de-duplication and the
 * ordering; this only re-reads the two money fields from the ORIGINAL string
 * values so nothing downstream inherits a double. The originals are matched by
 * payment id — the key mergeOrderPayments de-duplicates on.
 */
export function withExactAmounts(
  rows: readonly OrderPaymentRow[],
  sources: {
    /** The legacy linked payments, as read: id → amount, exactly as sent. */
    linked: readonly { id: string; amount: string | number | null }[]
    /** The active allocations, as read: payment id → allocated_amount and the parent's amount. */
    allocations: readonly {
      allocated_amount: string | number | null
      payment: { id: string; amount: string | number | null } | null
    }[]
  },
): OrderFinancePaymentRow[] {
  const linkedAmount = new Map<string, string | number | null>()
  for (const row of sources.linked) linkedAmount.set(row.id, row.amount)

  const allocated = new Map<string, { share: string | number | null; amount: string | number | null }>()
  for (const allocation of sources.allocations) {
    const payment = allocation.payment
    // FIRST WINS, matching mergeOrderPayments: it takes the first allocation it
    // sees for a payment id and ignores the rest, so reading a later one here
    // would describe a row the list is not showing.
    if (!payment || allocated.has(payment.id)) continue
    allocated.set(payment.id, { share: allocation.allocated_amount, amount: payment.amount })
  }

  return rows.map(row => {
    // A legacy linked row's share IS its amount — there is no allocation to
    // read, and the payment is wholly this Order's by the link itself.
    const source = row.viaAllocation
      ? allocated.get(row.id)
      : { share: linkedAmount.get(row.id) ?? null, amount: linkedAmount.get(row.id) ?? null }

    const amount = parseExact(source?.amount)
    const share = parseExact(source?.share)

    return {
      ...row,
      // An unreadable figure falls back to the string form of what the row
      // already carries rather than to '0': the row is still money, and zero
      // would be a claim about it. sumExact skips what it cannot parse, so a
      // genuinely unreadable value is left out of totals rather than counted
      // as nought.
      exactAmount: amount ? exactToString(amount) : String(row.amount),
      exactAllocatedAmount: share ? exactToString(share) : String(row.allocatedAmount),
      isPartialShare: Boolean(amount && share && compareExact(share, amount) < 0),
    }
  })
}

/**
 * The Order's whole finance position, from the rows and the Order's own value.
 *
 * EVERY TOTAL USES THE ALLOCATED SHARE, never the ledger amount: a payment may
 * legitimately be split across targets, and summing the whole amount would
 * credit this Order with money that is not its own. That is the same rule
 * receivedFromPayments() already applied to `verified`; it now applies to every
 * figure, so the tiles and the table cannot disagree.
 */
export function buildOrderFinancePosition(
  rows: readonly OrderFinancePaymentRow[],
  orderValue: string | number | null | undefined,
): OrderFinancePosition {
  const total = parseExact(orderValue)

  let verified: ExactDecimal = ZERO
  let awaiting: ExactDecimal = ZERO
  let rejected: ExactDecimal = ZERO
  let verifiedCount = 0
  let awaitingCount = 0
  let rejectedCount = 0
  const splitPayments: { paymentId: string; elsewhere: string }[] = []

  for (const row of rows) {
    const share = parseExact(row.exactAllocatedAmount)

    if (isVerifiedPaymentStatus(row.status)) {
      verifiedCount++
      if (share) verified = addExact(verified, share)
    } else if (isAwaitingVerification(row.status)) {
      awaitingCount++
      if (share) awaiting = addExact(awaiting, share)
    } else if (row.status === 'rejected') {
      rejectedCount++
      if (share) rejected = addExact(rejected, share)
    }
    // A status in none of the three is counted in none of the three, and still
    // appears in the list. A total that quietly absorbed an unknown status would
    // be the more dangerous failure.

    if (row.isPartialShare) {
      const amount = parseExact(row.exactAmount)
      if (amount && share) {
        splitPayments.push({
          paymentId: row.id,
          elsewhere: exactToString(subtractExact(amount, share)),
        })
      }
    }
  }

  const received = addExact(verified, awaiting)

  return {
    orderValue: total ? exactToString(total) : null,
    verified: exactToString(verified),
    awaitingVerification: exactToString(awaiting),
    rejected: exactToString(rejected),
    received: exactToString(received),
    pendingBalance: total ? exactToString(clampAtZero(subtractExact(total, verified))) : null,
    verifiedPercent: percentOrNull(verified, total),
    receivedPercent: percentOrNull(received, total),
    fullyPaid: Boolean(total && compareExact(verified, total) >= 0),
    splitPayments,
    counts: {
      total: rows.length,
      verified: verifiedCount,
      awaiting: awaitingCount,
      rejected: rejectedCount,
    },
  }
}

function percentOrNull(part: ExactDecimal, whole: ExactDecimal | null): string | null {
  const percent = percentTrunc(part, whole)
  return percent ? exactToString(percent) : null
}

/**
 * The progress bar's WIDTH, clamped to 0–100.
 *
 * A pixel quantity and nothing else — it is never shown as a figure and never
 * feeds a decision, which is the same licence piDetailView.ts takes for the PI's
 * bar. Returns 0 when the percentage is not computable, because a bar has to
 * have some width and an empty one is the truthful shape.
 */
export function progressWidth(percent: string | null): number {
  if (percent === null) return 0
  const n = Number(percent)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, n))
}
