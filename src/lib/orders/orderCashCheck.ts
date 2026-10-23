// ── Approving an Order before its cash reached the company (20270414000000) ──
//
// When a PI is approved into an Order, every verified PNB, Paytm or Canara
// payment on it should already be with the company (its cash journey closed).
// When it is not — the person holding it is away — the approver may go ahead
// WITH A WRITTEN REASON, recorded by record_order_submission_cash_exception.
// A trigger on orders refuses the Order otherwise, so this file only explains
// and asks; it decides nothing.

import { readCashPayments, type CashPayment } from '@/lib/finance/cashJourney'

export type OrderCashException = { reason: string; byName: string | null; at: string; paymentCount: number }

export type OrderCashCheck = {
  /** Verified cash on this PI that has not reached the company and has no exception yet. */
  uncovered: CashPayment[]
  /** Exceptions already recorded on this PI. */
  covered: OrderCashException[]
}

type Raw = Record<string, unknown>

export function readOrderCashCheck(raw: unknown): OrderCashCheck | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Raw
  const covered = Array.isArray(o.covered) ? o.covered : []
  return {
    uncovered: readCashPayments(o.uncovered),
    covered: covered.flatMap((c): OrderCashException[] => {
      const x = (c ?? {}) as Raw
      const reason = typeof x.reason === 'string' ? x.reason : null
      if (!reason) return []
      return [{
        reason,
        byName: typeof x.by_name === 'string' ? x.by_name : null,
        at: typeof x.at === 'string' ? x.at : '',
        paymentCount: Number(x.payment_count) || 0,
      }]
    }),
  }
}

export const ORDER_CASH_REASON_MIN = 10
export const ORDER_CASH_REASON_MAX = 500

export type OrderCashAck = { ticked: boolean; reason: string }
export const EMPTY_ORDER_CASH_ACK: OrderCashAck = { ticked: false, reason: '' }

/** What is still missing before an Order may be approved without its cash, or null. */
export function orderCashAckError(check: OrderCashCheck | null | undefined, ack: OrderCashAck): string | null {
  if (!check || check.uncovered.length === 0) return null
  if (!ack.ticked) return 'Some cash on this PI has not reached the company. Tick "Approve without this cash" and give a reason, or wait until it is received.'
  const r = ack.reason.trim()
  if (r.length < ORDER_CASH_REASON_MIN) return 'Say why the order is approved before the cash reached the company (at least 10 characters).'
  if (r.length > ORDER_CASH_REASON_MAX) return `Keep the reason under ${ORDER_CASH_REASON_MAX} characters.`
  return null
}

/**
 * The database's refusals about cash, in words. Recognises only its own codes
 * (ORDER_SUBMISSION_CASH_*) and returns null for everything else, so every
 * other refusal keeps its existing sentence.
 */
export function orderCashFailureMessage(error: unknown): string | null {
  const message = typeof error === 'string' ? error
    : (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string')
      ? (error as { message: string }).message : ''
  const m = /ORDER_SUBMISSION_CASH_[A-Z_]+:\s*([\s\S]+)$/.exec(message.trim())
  return m ? m[1].trim() : null
}

type RpcClient = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string } | null }>
}

/** Records the exception. Returns the error to hand to runAction, or null. */
export async function recordOrderCashException(client: RpcClient, submissionId: string, reason: string) {
  const { error } = await client.rpc('record_order_submission_cash_exception', {
    p_submission_id: submissionId,
    p_reason: reason.trim(),
  })
  return error ?? null
}
