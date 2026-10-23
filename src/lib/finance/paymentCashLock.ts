// ── A payment locked by its cash journey (20270415000000) ────────────────────
//
// A payment that is in an open cash handover, or whose handover was ever
// accepted (or that the company cash custodian received directly), can no
// longer be edited or deleted by anyone. The database decides that
// (finance_payment_requests_lock_cash_custody); this file only READS the answer
// of finance_payment_cash_locks so the Edit and Delete dialogs can say so before
// the person types anything, and turns the database's refusal into words.
//
// NOTHING HERE AUTHORIZES ANYTHING. An admin may still delete a locked payment
// through the audited deletion (reason + typed Payment ID); that dialog is not
// affected.

export type PaymentCashLockReason = 'accepted_transfer' | 'open_handover'

export type PaymentCashLock = {
  paymentId: string
  reason: PaymentCashLockReason
  /** H-0001, or null when the custodian received the cash directly. */
  handover: string | null
}

type Raw = Record<string, unknown>

/** Reads finance_payment_cash_locks' JSON. Anything malformed is left out. */
export function readPaymentCashLocks(raw: unknown): Map<string, PaymentCashLock> {
  const out = new Map<string, PaymentCashLock>()
  if (!Array.isArray(raw)) return out
  for (const r of raw) {
    const o = (r ?? {}) as Raw
    const paymentId = typeof o.payment_id === 'string' ? o.payment_id : null
    const reason = o.reason === 'accepted_transfer' || o.reason === 'open_handover' ? o.reason : null
    if (!paymentId || !reason) continue
    out.set(paymentId, { paymentId, reason, handover: typeof o.handover === 'string' && o.handover ? o.handover : null })
  }
  return out
}

/** The one sentence shown in place of a working Edit or Delete. */
export function paymentCashLockMessage(lock: Pick<PaymentCashLock, 'reason' | 'handover'>): string {
  if (lock.reason === 'accepted_transfer') {
    return `This payment was handed over and accepted${lock.handover ? ` (${lock.handover})` : ''}, so it can no longer be edited or deleted. If it was recorded by mistake, an administrator can delete it with a reason.`
  }
  return `This payment is in cash handover${lock.handover ? ` ${lock.handover}` : ''}, which has not been accepted yet. It cannot be edited or deleted while that handover is open; the giver can cancel the handover first.`
}

/**
 * The database's refusal (PAYMENT_LOCKED_BY_CASH_HANDOVER), in its own words,
 * or null for any other error so every other refusal keeps its sentence.
 */
export function paymentCashLockErrorMessage(message: string | null | undefined): string | null {
  const m = /PAYMENT_LOCKED_BY_CASH_HANDOVER:\s*([\s\S]+)$/.exec((message ?? '').trim())
  if (!m) return null
  const sentence = m[1].trim()
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

/** PostgREST / Postgres "that function does not exist yet" (migration not applied). */
export function isPaymentCashLockMissing(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  return error.code === 'PGRST202' || error.code === '42883'
    || /finance_payment_cash_locks/.test(error.message ?? '') && /does not exist|could not find/i.test(error.message ?? '')
}
