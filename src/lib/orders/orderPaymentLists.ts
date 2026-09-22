// ── The two payment lists behind the Order's payment summary ─────────────────
//
// WHAT THIS IS FOR
// ----------------
// The Confirmed Order's payment section states a position: how much Finance has
// verified, how much is still with Finance, and what remains. Each of the first
// two figures is the total of a set of real payments, and a reader who is told
// "₹1,00,000 awaiting verification" reasonably asks WHICH payment. This splits
// the rows the page already holds into those two sets, so a dialog can answer
// that without the page carrying a permanently open table under the figures.
//
// IT FILTERS. IT DOES NOT TOTAL, CONVERT OR DECIDE.
// Every amount below is a string that buildOrderFinancePosition's own input
// already carried — `exactAllocatedAmount` is THIS ORDER'S share, exactly as
// `numeric` sent it, and `exactAmount` is the payment's full ledger amount.
// Nothing here adds, subtracts, rounds or percentages money, and nothing here
// re-derives which share belongs to this Order: withExactAmounts settled that
// under the canonical allocation rule, and this reads its answer.
//
// THE STATUS VOCABULARY IS NOT RESTATED. Verified is isVerifiedPaymentStatus()
// from orderPayments.ts, which mirrors finance_payment_status_is_verified();
// awaiting is isAwaitingVerification() from piPaymentView.ts, which mirrors the
// database's unverified branch. A third list written here is how the three
// would drift. A REJECTED payment is in NEITHER list, exactly as it is counted
// in neither figure.
//
// ORDER IS PRESERVED. The rows arrive in mergeOrderPayments' order — the order
// the page has always shown them in — and this only removes the ones that
// belong to the other list.

import { isVerifiedPaymentStatus } from './orderPayments'
import { isAwaitingVerification } from '@/lib/finance/piPaymentView'
import type { OrderFinancePaymentRow } from '@/lib/finance/orderFinancePosition'

/** Which of the two figures a list stands behind. */
export type OrderPaymentListKind = 'verified' | 'awaiting'

/** The dialog's heading, named with the figure it opens from. */
export const PAYMENT_LIST_TITLE: Record<OrderPaymentListKind, string> = {
  verified: 'Verified payments',
  awaiting: 'Payments awaiting verification',
}

/**
 * WHAT AN EMPTY LIST SAYS.
 *
 * The dialog opens either way. A summary figure of ₹0.00 that cannot be opened
 * leaves a reader wondering whether the control is broken or the set is empty;
 * one that opens onto a plain sentence answers the question it was clicked to
 * ask.
 */
export const PAYMENT_LIST_EMPTY: Record<OrderPaymentListKind, string> = {
  verified: 'No verified payments.',
  awaiting: 'No payments awaiting verification.',
}

/**
 * WHY THE FIGURE IN THE LIST MAY BE SMALLER THAN THE PAYMENT.
 *
 * A payment may legitimately be split across several records. Every amount in
 * these lists is this Order's allocated share, which is what the summary above
 * is built from — said out loud, because a reader checking a row against a bank
 * statement needs to know the difference is a split and not a missing payment.
 */
export const PAYMENT_LIST_CAPTION =
  "Amounts are this Order's allocated share. Where a payment is split across " +
  'records, the rest of it belongs elsewhere and is counted here in neither ' +
  "figure. Each payment's complete allocation history is in its Finance record."

/** One payment, as a list row draws it. Every field is the row's own. */
export type OrderPaymentListRow = {
  id: string
  /** The payer as the payment recorded them; null where the record has none. */
  client: string | null
  /** The payment date, unformatted — the page owns date formatting. */
  dateIso: string | null
  /** THIS ORDER'S share, exact. The figure the summary counts. */
  allocated: string
  /** The payment's full ledger amount, exact. */
  full: string
  /** True only when the two genuinely differ. */
  isPartialShare: boolean
  /** The stored mode key; the shared label map turns it into words. */
  mode: string | null
  /** The payment's own reference, where it carries one. */
  reference: string | null
  /** The stored status key, for the list that needs to tell two apart. */
  status: string
}

const asRow = (row: OrderFinancePaymentRow): OrderPaymentListRow => ({
  id: row.id,
  client: row.client_name ?? null,
  dateIso: row.payment_date ?? null,
  allocated: row.exactAllocatedAmount,
  full: row.exactAmount,
  isPartialShare: row.isPartialShare,
  mode: row.payment_mode ?? null,
  reference: row.order_number ?? null,
  status: row.status,
})

/**
 * The rows behind one of the two figures.
 *
 * `verified` is what Finance has confirmed arrived; `awaiting` is what is still
 * with Finance. Neither includes a refused payment, because neither figure does.
 */
export function orderPaymentList(
  rows: readonly OrderFinancePaymentRow[],
  kind: OrderPaymentListKind,
): OrderPaymentListRow[] {
  const keep = kind === 'verified' ? isVerifiedPaymentStatus : isAwaitingVerification
  return rows.filter(row => keep(row.status)).map(asRow)
}
