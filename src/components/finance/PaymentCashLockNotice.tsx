'use client'

import { useEffect, useState } from 'react'
import { Lock } from 'lucide-react'
import {
  isPaymentCashLockMissing,
  paymentCashLockMessage,
  readPaymentCashLocks,
  type PaymentCashLock,
} from '@/lib/finance/paymentCashLock'

type RpcClient = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>
}

/**
 * Whether ONE payment is locked by its cash journey (20270415000000), asked
 * once when an Edit or Delete dialog opens, through the dialog's own client.
 * null while asking, when it is not locked, when the caller may not look at it,
 * and when the function does not exist yet — the database refuses the save
 * regardless, with the same sentence.
 */
export function usePaymentCashLock(supabase: RpcClient | null | undefined, paymentId: string | null | undefined) {
  // Keyed by the payment it answers, so a dialog reopened on another payment
  // never shows the previous one's lock while the new answer is on its way.
  const [answer, setAnswer] = useState<{ paymentId: string; lock: PaymentCashLock | null } | null>(null)
  useEffect(() => {
    if (!supabase || !paymentId) return
    let live = true
    void Promise.resolve(supabase.rpc('finance_payment_cash_locks', { p_payment_ids: [paymentId] })).then(
      ({ data, error }) => {
        if (!live || error) {
          if (error && !isPaymentCashLockMissing(error)) console.warn('finance_payment_cash_locks:', error.message)
          return
        }
        setAnswer({ paymentId, lock: readPaymentCashLocks(data).get(paymentId) ?? null })
      },
      () => {},
    )
    return () => { live = false }
  }, [supabase, paymentId])
  return answer && answer.paymentId === paymentId ? answer.lock : null
}

/** Why Edit / Delete is unavailable, said once at the top of the dialog. */
export function PaymentCashLockNotice({ lock }: { lock: PaymentCashLock }) {
  return (
    <div role="note" data-testid="payment-cash-lock" style={{
      display: 'flex', gap: '10px', alignItems: 'flex-start',
      padding: '12px 14px', borderRadius: '8px',
      background: '#FFF8E8', border: '1px solid rgba(196,138,26,0.6)', color: '#5E4106',
      fontSize: '13px', lineHeight: 1.5,
    }}>
      <Lock size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
      <span>{paymentCashLockMessage(lock)}</span>
    </div>
  )
}
