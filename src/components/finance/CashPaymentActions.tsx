'use client'

import { useState } from 'react'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { formatINR } from '@/lib/currency'
import { useHandoverActions } from '@/hooks/queries/useHandovers'
import { useCashJourneyActions } from '@/hooks/queries/useCashJourneys'
import { PaymentJourneyButton } from '@/components/finance/PaymentJourneyDialog'
import type { CashPayment } from '@/lib/finance/cashJourney'

/**
 * The one action a person can take on a tracked payment, wherever it is shown
 * (Finance, the order page, the PI page), plus its journey:
 *   * Accept    — they are the receiver of its open handover;
 *   * Receive   — they receive cash for the company and it is not with them;
 *   * Hand over — they hold it (opens Hand over cash).
 * Each is offered only when the server said so (can_* flags) and re-checked
 * there when pressed.
 */
export function CashPaymentActions({ payment, onHandOver, quietJourney = false }: { payment: CashPayment; onHandOver?: () => void; quietJourney?: boolean }) {
  const [dialog, setDialog] = useState<'accept' | 'receive' | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { accept } = useHandoverActions()
  const { receive } = useCashJourneyActions()
  const busy = accept.isPending || receive.isPending
  const giver = payment.openHandover?.giverName ?? payment.holderName ?? 'the giver'

  const run = async (fn: () => Promise<unknown>) => {
    setError(null)
    try { await fn(); setDialog(null) }
    catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.') }
  }

  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      {payment.canAccept && payment.openHandover && (
        <button type="button" className="boe-btn boe-btn-primary" style={{ minHeight: 32, padding: '4px 12px' }} disabled={busy}
          onClick={() => { setError(null); setDialog('accept') }}>
          Accept
        </button>
      )}
      {payment.canReceive && !payment.canAccept && (
        <button type="button" className="boe-btn boe-btn-primary" style={{ minHeight: 32, padding: '4px 12px' }} disabled={busy}
          onClick={() => { setError(null); setNote(''); setDialog('receive') }}>
          Receive
        </button>
      )}
      {payment.canHandOver && onHandOver && (
        <button type="button" className="boe-btn boe-btn-primary" style={{ minHeight: 32, padding: '4px 12px' }} onClick={onHandOver}>
          Hand over
        </button>
      )}
      {quietJourney
        ? <span className="boe-cj-quiet"><PaymentJourneyButton paymentId={payment.paymentId} label="Journey" /></span>
        : <PaymentJourneyButton paymentId={payment.paymentId} label="Journey" />}

      {dialog === 'accept' && payment.openHandover && (
        <FinanceModal title="Accept this cash" onClose={() => setDialog(null)} width="460px">
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
            Accept only after the cash is in your hands. You are confirming that you received the money of{' '}
            <strong>{payment.humanPaymentId ?? 'this payment'}</strong> from <strong>{giver}</strong>
            {payment.openHandover ? ` (handover ${payment.openHandover.humanId}, which may carry other payments too)` : ''}.
          </p>
          {error && <div className="boe-handover-error" role="alert">{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="boe-btn boe-btn-secondary" onClick={() => setDialog(null)} disabled={busy}>Not yet</button>
            <button type="button" className="boe-btn boe-btn-primary" disabled={busy} aria-busy={accept.isPending}
              onClick={() => void run(() => accept.mutateAsync(payment.openHandover!.id))}>
              {accept.isPending ? 'Saving…' : 'Yes, I have the cash'}
            </button>
          </div>
        </FinanceModal>
      )}

      {dialog === 'receive' && (
        <FinanceModal title="Receive for the company" onClose={() => setDialog(null)} width="460px" closeOnBackdropClick={false}>
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
            Confirm that you have received <strong>{formatINR(payment.amount)}</strong> ({payment.humanPaymentId ?? 'this payment'})
            {payment.holderName ? <> from <strong>{payment.holderName}</strong></> : null}. Its journey closes, and any handover still waiting for it is closed too.
          </p>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, fontWeight: 600 }}>
            Note (optional)
            <input type="text" value={note} maxLength={500} onChange={e => setNote(e.target.value)}
              placeholder="e.g. handed to me at the office"
              style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #686D6C', font: 'inherit', fontWeight: 400 }} />
          </label>
          {error && <div className="boe-handover-error" role="alert">{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="boe-btn boe-btn-secondary" onClick={() => setDialog(null)} disabled={busy}>Cancel</button>
            <button type="button" className="boe-btn boe-btn-primary" disabled={busy} aria-busy={receive.isPending}
              onClick={() => void run(() => receive.mutateAsync({ paymentIds: [payment.paymentId], note }))}>
              {receive.isPending ? 'Saving…' : 'Yes, I received it'}
            </button>
          </div>
        </FinanceModal>
      )}
    </span>
  )
}
