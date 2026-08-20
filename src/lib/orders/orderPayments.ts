// The payments an Order can see, after a PI's money moves onto it.
//
// THE PROBLEM THIS SOLVES
// -----------------------
// Before Phase 3 an Order's payments were exactly the rows of
// finance_payment_requests carrying `order_id = <this order>`. A payment
// recorded against a PI SUBMISSION carries no order_id — it is attached by an
// ALLOCATION (20260918000000) — and when the PI becomes an Order,
// approve_order_submission() MOVES that allocation onto the Order rather than
// creating a second payment row. The ledger row is deliberately untouched: its
// proof, its verification and its Finance history stay exactly where they are.
//
// So an Order detail screen that reads only `order_id` would show nothing for
// money the client genuinely paid, and the business would conclude it was lost.
// This module is the join: the legacy linked payments, plus the payments the
// Order's own ACTIVE allocations point at, as ONE list with no duplicates.
//
// WHAT IT DOES NOT DO
// -------------------
// It creates nothing, copies nothing and re-links nothing. Both inputs come from
// ordinary RLS-checked reads anchored to one Order id, and RLS decides what the
// caller may see — finance_payment_allocations has an order-participant SELECT
// policy, and finance_payment_requests admits a participant through
// can_read_payment_as_participant() (20260919000000). No new query surface, and
// nothing unbounded.

/** One payment as the Order screen lists it. */
export type OrderPaymentRow = {
  id: string
  client_name: string
  amount: number
  payment_date: string
  payment_mode: string
  order_number: string | null
  status: string
  /**
   * How much of this payment belongs to THIS Order.
   *
   * Equal to `amount` for a payment linked the legacy way, and to the
   * allocation's own figure for one that arrived through an allocation — a
   * payment may legitimately be split across targets, and summing the whole
   * ledger amount would credit this Order with money that is not its own.
   */
  allocatedAmount: number
  /** True when this row is here because an allocation points at the Order. */
  viaAllocation: boolean
}

/** The shape the allocation read returns, with its parent payment embedded. */
export type OrderAllocationRow = {
  id: string
  allocated_amount: number | string | null
  status: string
  payment: {
    id: string
    client_name: string | null
    amount: number | string | null
    payment_date: string | null
    payment_mode: string | null
    order_number: string | null
    status: string
  } | null
}

const toNumber = (value: number | string | null | undefined): number => {
  if (value === null || value === undefined || value === '') return 0
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * The two verified payment statuses, mirroring
 * finance_payment_status_is_verified() (20260918000000 §5) exactly.
 *
 * `approved_unlinked` counts here and did not before, and that is the point: a
 * payment recorded against a PI and verified by Finance is verified money, and
 * whether it also carries a legacy order_id is a Finance bookkeeping detail that
 * says nothing about whether the client paid.
 */
export function isVerifiedPaymentStatus(status: string | null | undefined): boolean {
  return status === 'approved_unlinked' || status === 'approved_linked'
}

/**
 * The Order's payments: the legacy linked rows first, then anything its active
 * allocations point at that is not already among them.
 *
 * DEDUPLICATED BY PAYMENT ID, and the legacy row wins. A payment that was linked
 * the old way AND carries a backfilled allocation to the same Order is one
 * payment, and listing it twice would double every total a reader computes by
 * eye.
 *
 * REVERSED ALLOCATIONS ARE NOT INCLUDED. A reversed allocation is a claim that
 * was withdrawn; it stays in the Finance trail, where its reason is, and it is
 * not money this Order has.
 */
export function mergeOrderPayments(
  linked: readonly {
    id: string
    client_name: string | null
    amount: number | string | null
    payment_date: string | null
    payment_mode: string | null
    order_number: string | null
    status: string
  }[],
  allocations: readonly OrderAllocationRow[],
): OrderPaymentRow[] {
  const rows: OrderPaymentRow[] = linked.map(p => ({
    id: p.id,
    client_name: p.client_name ?? '',
    amount: toNumber(p.amount),
    payment_date: p.payment_date ?? '',
    payment_mode: p.payment_mode ?? '',
    order_number: p.order_number,
    status: p.status,
    allocatedAmount: toNumber(p.amount),
    viaAllocation: false,
  }))

  const seen = new Set(rows.map(r => r.id))

  for (const allocation of allocations) {
    if (allocation.status !== 'active') continue
    const payment = allocation.payment
    if (!payment || seen.has(payment.id)) continue
    seen.add(payment.id)
    rows.push({
      id: payment.id,
      client_name: payment.client_name ?? '',
      amount: toNumber(payment.amount),
      payment_date: payment.payment_date ?? '',
      payment_mode: payment.payment_mode ?? '',
      order_number: payment.order_number,
      status: payment.status,
      allocatedAmount: toNumber(allocation.allocated_amount),
      viaAllocation: true,
    })
  }

  // Newest first, which is how the screen has always listed them. A row with no
  // date sorts last rather than being dropped: it is still money.
  return rows.sort((a, b) => {
    if (a.payment_date === b.payment_date) return 0
    if (a.payment_date === '') return 1
    if (b.payment_date === '') return -1
    return a.payment_date < b.payment_date ? 1 : -1
  })
}

/**
 * What this Order has actually received: the ALLOCATED figure of every VERIFIED
 * payment in the merged list.
 *
 * Allocated and not the full ledger amount, for the reason on OrderPaymentRow:
 * a payment may be split, and only this Order's share is this Order's money.
 */
export function receivedFromPayments(rows: readonly OrderPaymentRow[]): number {
  return rows
    .filter(row => isVerifiedPaymentStatus(row.status))
    .reduce((sum, row) => sum + row.allocatedAmount, 0)
}
