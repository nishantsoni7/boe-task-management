// ── Money already received from this client ──────────────────────────────────
//
// Payments counted once, Step 1 (owner, 2026-10-29). Before anyone records a
// payment, Add payment shows money the company has ALREADY received from the
// same client that is free to use: money on a PI that was closed (deal lost),
// or a payment of theirs that is on nothing yet. "Use this money" moves it onto
// the PI or Order. The payment keeps its ID and its status, so a verified one
// stays verified and the transfer is never typed in a second time.
//
// Both calls are database doors (20270505000000): client_available_payments
// (at most three rows, needs the amount and the date, same client only) and
// use_available_payment. This file decides nothing; it formats, and it turns
// every refusal into a fixed sentence so no database text reaches the screen.

import { formatMoney, paymentModeLabel } from '@/lib/finance/piPaymentView'
import { paymentStatusWord } from '@/lib/finance/paymentWords'
import { notifyFinance } from '@/lib/notify'

/** Exactly one target: the PI being paid, or the Order. */
export type AvailableMoneyTarget =
  | { submissionId: string; orderId?: undefined }
  | { orderId: string; submissionId?: undefined }

/** One row of client_available_payments. */
export type AvailablePayment = {
  payment_id: string
  payment_number: string | null
  amount: string | number
  available: string | number
  payment_date: string | null
  payment_mode: string | null
  status: string
  verified: boolean
  closed_pi_reference: string | null
}

type RpcClient = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string } | null }>
}

/** What the search needs before it is worth asking: a valid amount and a date. */
export function canSearchAvailableMoney(amount: string, paymentDate: string): boolean {
  const raw = amount.trim()
  return /^\d+(\.\d{1,2})?$/.test(raw) && Number(raw) > 0
    && /^\d{4}-\d{2}-\d{2}$/.test(paymentDate.trim())
}

/**
 * Asks the database for matches. A refusal or a network failure answers with an
 * empty list: the form then behaves exactly as it did before this existed, and
 * the duplicate is still caught by Finance.
 */
export async function searchAvailableMoney(
  client: RpcClient,
  target: AvailableMoneyTarget,
  amount: string,
  paymentDate: string,
): Promise<AvailablePayment[]> {
  if (!canSearchAvailableMoney(amount, paymentDate)) return []
  const { data, error } = await client.rpc('client_available_payments', {
    p_submission_id: target.submissionId ?? null,
    p_order_id:      target.orderId ?? null,
    p_amount:        Number(amount.trim()),
    p_payment_date:  paymentDate.trim(),
  })
  if (error || !Array.isArray(data)) return []
  return data as AvailablePayment[]
}

export type UseAvailableMoneyResult =
  | { ok: true; paymentNumber: string; amount: string; verified: boolean; requestNumber: string | null }
  | { ok: false; message: string }

const USE_REFUSALS: [string, string][] = [
  ['ALLOCATION_DUPLICATE',              'This payment is already on this record.'],
  ['PAYMENT_NOTHING_AVAILABLE',         'This payment has no money left to use. Someone may have just used it. Close this window and look again.'],
  ['PAYMENT_CLIENT_MISMATCH',           'This payment belongs to another client, so it cannot be used here.'],
  ['PAYMENT_REJECTED',                  'This payment was rejected by Finance, so it cannot be used.'],
  ['PAYMENT_NOT_FOUND',                 'This payment no longer exists.'],
  ['ORDER_SUBMISSION_REJECTED',         'This PI is closed, so it cannot receive a payment.'],
  ['ORDER_SUBMISSION_CONVERTED',        'This PI is now an Order. Use the money on the Order instead.'],
  ['ORDER_SUBMISSION_DELETION_CLAIMED', 'This PI is reserved for deletion and cannot receive a payment.'],
  ['ORDER_SUBMISSION_NO_CLIENT',        'This record has no client name, so money cannot be matched to it.'],
  ['ALLOCATION_TARGET_NOT_ACTIVE',      'This Order is cancelled and cannot receive a payment.'],
  ['PI_PAYMENT_NOT_PERMITTED',          'You do not have permission to add a payment to this PI.'],
  ['PAYMENT_ENTRY_ALLOCATION_NOT_PERMITTED', 'You do not have permission to add a payment to this Order.'],
  ['PAYMENT_ENTRY_NOT_PERMITTED',       'You do not have access to Finance.'],
  ['PAYMENT_LOCKED_BY_CASH_HANDOVER',   'This payment is in a cash handover and cannot be moved right now.'],
]

export function availableMoneyErrorMessage(raw: string | null | undefined): string {
  const message = (raw ?? '').trim()
  for (const [code, friendly] of USE_REFUSALS) {
    if (message.includes(code)) return friendly
  }
  return 'Could not use this payment. Please try again.'
}

/** Moves the payment's free money onto the target. */
export async function applyAvailableMoney(
  client: RpcClient,
  paymentId: string,
  target: AvailableMoneyTarget,
): Promise<UseAvailableMoneyResult> {
  const { data, error } = await client.rpc('use_available_payment', {
    p_payment_id:    paymentId,
    p_submission_id: target.submissionId ?? null,
    p_order_id:      target.orderId ?? null,
  })
  if (error) return { ok: false, message: availableMoneyErrorMessage(error.message ?? null) }
  const row = (data ?? {}) as { payment_number?: string; request_number?: string; allocated_amount?: string | number; status?: string }
  return {
    ok: true,
    paymentNumber: row.payment_number ?? row.request_number ?? 'The payment',
    amount: formatMoney(row.allocated_amount ?? 0),
    verified: row.status === 'approved_linked' || row.status === 'approved_unlinked',
    requestNumber: row.request_number ?? null,
  }
}

/**
 * Tells Finance, for information only, that money already received was moved
 * onto a PI or Order. Never awaited and never fails the move, which has already
 * happened by the time this is called.
 */
export function announcePaymentMoved(paymentId: string, requestNumber: string | null, where: string | null): void {
  void notifyFinance({ event: 'finance_payment_moved', requestNumber: requestNumber ?? '', entityId: paymentId, orderNumber: where })
}

/** The words one match is drawn with. */
export function describeAvailablePayment(row: AvailablePayment): {
  number: string
  amount: string
  status: string
  verified: boolean
  facts: string
  where: string
} {
  const partly = Number(row.available) < Number(row.amount)
  const date = row.payment_date ? formatShortDate(row.payment_date) : null
  return {
    number: row.payment_number ?? 'Payment',
    amount: formatMoney(row.available),
    status: paymentStatusWord(row.status),
    verified: row.verified,
    facts: [
      date,
      row.payment_mode ? paymentModeLabel(row.payment_mode) : null,
      partly ? `${formatMoney(row.available)} free of ${formatMoney(row.amount)}` : null,
    ].filter(Boolean).join(' · '),
    where: row.closed_pi_reference
      ? `Was on ${row.closed_pi_reference}, which was closed`
      : 'Not on any PI or Order yet',
  }
}

/** "Use this money" succeeded: what the page says. */
export function availableMoneyUsedNotice(result: Extract<UseAvailableMoneyResult, { ok: true }>, where: 'PI' | 'Order'): string {
  return result.verified
    ? `${result.paymentNumber} (${result.amount}) is now on this ${where}. It stays Verified, so it counts at once.`
    : `${result.paymentNumber} (${result.amount}) is now on this ${where}. It is still waiting for Finance.`
}

/**
 * The line the approver reads in the Return / Close window: what is recorded on
 * the PI and what happens to it. Null when nothing is recorded.
 */
export function piDecisionMoneyNote(
  intent: 'needs_changes' | 'reject' | 'reject_exception',
  attachedAmount: string | number | null | undefined,
): string | null {
  const amount = Number(attachedAmount ?? 0)
  if (!Number.isFinite(amount) || amount <= 0 || intent === 'reject_exception') return null
  const money = formatMoney(amount)
  return intent === 'reject'
    ? `${money} is recorded on this PI. Closing hands it back to the client’s money, ready for their next PI or Order.`
    : `${money} is recorded on this PI and stays on it.`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 2026-10-12 → "12 Oct 2026". A date string, never a clock reading. */
export function formatShortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return iso
  const month = MONTHS[Number(m[2]) - 1]
  return month ? `${Number(m[3])} ${month} ${m[1]}` : iso
}
