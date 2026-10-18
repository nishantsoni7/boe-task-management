import { addExact, exactToString, parseExact, ZERO, type ExactDecimal } from './exactMoney'
import type { ConfirmedAllocationStatus } from './paymentSurfaces'

/**
 * The Confirmed Payments summary cards: how much confirmed money there is, and
 * how much of it is waiting to be allocated, partially allocated and fully
 * allocated — each as an exact amount and a count.
 *
 * Read from ONE paged read of `amount, complete_allocation_status` over the same
 * confirmed statuses the list uses, under the reader's own RLS, so the cards
 * never describe money the list would not show. The status is the COMPLETE one
 * (20261216000000), the same predicate the tabs filter on, so a card and its tab
 * always agree.
 *
 * Money is added as exact decimals, never floats.
 */
export type ConfirmedSummaryRow = {
  amount: string | number | null
  complete_allocation_status: ConfirmedAllocationStatus | null
}

export type ConfirmedSummaryBucket = { count: number; amount: string }

export type ConfirmedSummary = {
  all: ConfirmedSummaryBucket
  zero: ConfirmedSummaryBucket
  partial: ConfirmedSummaryBucket
  full: ConfirmedSummaryBucket
  over: ConfirmedSummaryBucket
}

export function summarizeConfirmed(rows: readonly ConfirmedSummaryRow[]): ConfirmedSummary {
  const totals: Record<keyof ConfirmedSummary, { count: number; amount: ExactDecimal }> = {
    all:     { count: 0, amount: ZERO },
    zero:    { count: 0, amount: ZERO },
    partial: { count: 0, amount: ZERO },
    full:    { count: 0, amount: ZERO },
    over:    { count: 0, amount: ZERO },
  }
  for (const row of rows) {
    const amount = parseExact(row.amount) ?? ZERO
    totals.all.count += 1
    totals.all.amount = addExact(totals.all.amount, amount)
    const status = row.complete_allocation_status
    // A row with no status (should not happen) still counts toward All, and
    // nowhere else — never guessed into a bucket.
    if (status && status in totals) {
      totals[status].count += 1
      totals[status].amount = addExact(totals[status].amount, amount)
    }
  }
  const out = {} as ConfirmedSummary
  for (const key of Object.keys(totals) as (keyof ConfirmedSummary)[]) {
    out[key] = { count: totals[key].count, amount: exactToString(totals[key].amount) }
  }
  return out
}
