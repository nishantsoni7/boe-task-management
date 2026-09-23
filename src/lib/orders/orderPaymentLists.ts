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
const CAPTION_BASE =
  "Amounts are this Order's allocated share. Where a payment is split across " +
  'records, the rest of it belongs elsewhere and is counted here in neither figure.'

/**
 * THE CAPTION, AND WHETHER IT INVITES ANYTHING.
 *
 * A reader who cannot open a payment must not be told to. The allocation rule
 * is the same sentence for everybody; only the invitation is conditional.
 */
export function paymentListCaption(canViewDetails: boolean): string {
  return canViewDetails
    ? CAPTION_BASE + ' Open a payment to see the whole of it.'
    : CAPTION_BASE
}

/** The rule alone, for callers that only need the words. */
export const PAYMENT_LIST_CAPTION = CAPTION_BASE

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

/**
 * THE FIELDS A FINANCE READER — AND ONLY A FINANCE READER — MAY SEE.
 *
 * WHY THESE ARE NOT ON THE ROW ABOVE. Row-level access to a payment is not the
 * same permission as seeing what Finance wrote about it. Everybody who may read
 * this Order may read its payment AMOUNTS, because the Order's own totals are
 * built from them; the proof note, the clarification Finance asked for and the
 * moment somebody signed it off are Finance's record of its own work, and the
 * screen that used to show them did so behind a Finance-module door.
 *
 * THAT DOOR IS BACK. These travel separately from the list, are fetched
 * separately, and are fetched only for a reader who holds Finance module entry
 * — the same capability that used to decide whether the Finance record link was
 * drawn at all. See orderPaymentDetailQuery.
 */
export type OrderPaymentDetailFields = {
  /** The human payment id, which is what Finance and the client both quote. */
  humanId: string | null
  /** Where the money landed: company account, cash in hand, and so on. */
  receivedIn: string | null
  /** What the payer said about the proof when the payment was recorded. */
  proofNote: string | null
  /** What the salesperson noted alongside it. */
  salesNote: string | null
  /** Finance's own note — the clarification asked for, or the refusal. */
  adminNote: string | null
  /** When Finance approved it, when it refused, when it asked. */
  approvedAtIso: string | null
  rejectedAtIso: string | null
  clarificationAtIso: string | null
  /** Who approved it, unresolved: a user id the caller may name if it can. */
  approvedById: string | null
}

/** Empty string and undefined are both "the record has none". */
const orNull = (value: string | null | undefined): string | null => {
  const text = (value ?? '').trim()
  return text === '' ? null : text
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
 * One stored payment row, narrowed to what a detail view states.
 *
 * THE INPUT IS THE SELECT'S OWN SHAPE. Every key is a column of
 * finance_payment_requests, and a caller that did not ask for one passes
 * nothing — the field is then absent rather than invented.
 */
export function paymentDetailFields(row: {
  human_payment_id?: string | null
  request_number?: string | null
  received_in?: string | null
  proof_note?: string | null
  sales_note?: string | null
  admin_note?: string | null
  approved_at?: string | null
  rejected_at?: string | null
  clarification_requested_at?: string | null
  approved_by?: string | null
}): OrderPaymentDetailFields {
  return {
    humanId: orNull(row.human_payment_id) ?? orNull(row.request_number),
    receivedIn: orNull(row.received_in),
    proofNote: orNull(row.proof_note),
    salesNote: orNull(row.sales_note),
    adminNote: orNull(row.admin_note),
    approvedAtIso: orNull(row.approved_at),
    rejectedAtIso: orNull(row.rejected_at),
    clarificationAtIso: orNull(row.clarification_requested_at),
    approvedById: orNull(row.approved_by),
  }
}

/**
 * THE COLUMNS THE DETAIL READ ASKS FOR, and no others.
 *
 * Named here so the query and the type cannot drift, and so a reviewer can see
 * in one place exactly what a Finance reader is shown beyond the brief list.
 */
export const PAYMENT_DETAIL_COLUMNS =
  'id, human_payment_id, request_number, received_in, proof_note, sales_note, ' +
  'admin_note, approved_at, approved_by, rejected_at, clarification_requested_at'

/**
 * How the page's lazy detail read is going, for the dialog to draw.
 *
 * A REFUSED READ IS NOT AN EMPTY RECORD. RLS may legitimately refuse this row
 * to this reader even though the brief list showed it, and the dialog says so
 * rather than printing a payment with every field blank.
 */
export type OrderPaymentDetailState =
  | { state: 'loading' }
  | { state: 'ready'; fields: OrderPaymentDetailFields }
  | { state: 'error'; message: string }

export const PAYMENT_DETAIL_UNAVAILABLE =
  'The rest of this payment is not available to you right now.'

/** Finds one row of a list by payment id. The list is short; this is a scan. */
export function orderPaymentById(
  rows: readonly OrderPaymentListRow[],
  paymentId: string | null,
): OrderPaymentListRow | null {
  if (paymentId === null) return null
  return rows.find(row => row.id === paymentId) ?? null
}

/** Where a payment landed, in words. The stored keys are finance's own. */
export const RECEIVED_IN_LABEL: Record<string, string> = {
  company_account: 'Company account',
  cash_in_hand: 'Cash in hand',
  savings_account: 'Savings account',
  other: 'Other',
}

export const PAYMENT_DETAIL_TITLE = 'Payment details'
export const PAYMENT_DETAIL_BACK = 'Back to payments'
export const PAYMENT_DETAIL_VIEW = 'View details'
/** Said once, where a reader might otherwise wonder what they are looking at. */
export const PAYMENT_DETAIL_SPLIT_NOTE =
  "This payment is split. Only the share allocated to this Order is counted in " +
  "this Order's totals; the rest belongs to other records."

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

/**
 * WHETHER THE PAGE MAY FETCH ONE PAYMENT'S DETAIL, AND FOR WHICH ID.
 *
 * TWO CONDITIONS, BOTH REQUIRED:
 *
 *   1. THE READER HOLDS FINANCE MODULE ENTRY — the same capability that used to
 *      decide whether the Finance record link was drawn at all. Nothing finer
 *      and nothing new; that door moved from a link to a dialog, and this is it.
 *
 *   2. THE ID IS ONE THIS ORDER'S OWN LIST ALREADY CONTAINS. The rows came from
 *      two reads anchored to this Order and filtered by status, so an id that is
 *      not among them is an id this screen never showed — and a screen must not
 *      turn a typed or tampered id into a read, even one RLS would refuse. The
 *      refusal happens before the request, not after it.
 *
 * IT AUTHORIZES NOTHING. RLS still decides whether the row comes back; this only
 * stops the page asking about something it has no business asking about.
 */
export function orderPaymentDetailQuery(input: {
  canViewPaymentDetails: boolean
  rows: readonly OrderPaymentListRow[]
  paymentId: string | null
}): { allowed: boolean; paymentId: string | null } {
  if (!input.canViewPaymentDetails) return { allowed: false, paymentId: null }
  const known = orderPaymentById(input.rows, input.paymentId)
  return known ? { allowed: true, paymentId: known.id } : { allowed: false, paymentId: null }
}
