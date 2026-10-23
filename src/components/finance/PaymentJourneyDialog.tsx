'use client'

import { useState } from 'react'
import { Route } from 'lucide-react'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { formatINR } from '@/lib/currency'
import { formatDateTime } from '@/lib/ui'
import { paymentModeLabel } from '@/lib/finance/paymentEntry'
import { usePaymentJourney } from '@/hooks/queries/useCashJourneys'
import { journeyStepLabel } from '@/lib/finance/cashJourney'
import { CashStateChip } from '@/components/finance/CashStateChip'

/**
 * One payment's cash journey: who recorded it, every hand it passed through,
 * and where it is now — oldest first, one sentence per step.
 * Read through finance_payment_journey, which answers only for people allowed
 * to look at this payment.
 */
export function PaymentJourneyDialog({ paymentId, onClose }: { paymentId: string; onClose: () => void }) {
  const q = usePaymentJourney(paymentId)
  const p = q.data?.payment ?? null

  return (
    <FinanceModal title="Cash journey" onClose={onClose} width="520px">
      {q.isPending && <div style={{ fontSize: 14 }}>Loading…</div>}
      {q.isError && <div className="boe-handover-error" role="alert">The journey could not be loaded.</div>}
      {q.data === null && !q.isPending && (
        <div style={{ fontSize: 14 }}>This journey is not available to you.</div>
      )}

      {p && (
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 14 }}>
            <strong>{p.humanPaymentId ?? 'Payment'}</strong> · {p.clientName ?? 'Suspense'} · {paymentModeLabel(p.paymentMode)}
          </div>
          <div style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{formatINR(p.amount)}</div>
          <div style={{ width: '100%' }}><CashStateChip payment={p} /></div>
        </div>
      )}

      {q.data && (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, borderLeft: '2px solid #E4DED7', marginLeft: 6 }}>
          {q.data.steps.map((s, i) => (
            <li key={i} style={{ position: 'relative', padding: '0 0 14px 16px' }}>
              <span aria-hidden="true" style={{
                position: 'absolute', left: -7, top: 3, width: 12, height: 12, borderRadius: '50%',
                background: s.kind === 'handover_accepted' || s.kind === 'received_directly' ? '#276247'
                  : s.kind === 'handover_disputed' || s.kind === 'handover_cancelled' ? '#B42332' : '#C48A1A',
                border: '2px solid #FFFFFF',
              }} />
              <div style={{ fontSize: 14, color: '#303536' }}>{journeyStepLabel(s)}</div>
              <div style={{ fontSize: 12, color: '#686D6C' }}>
                {s.at ? formatDateTime(s.at) : ''}
                {s.handoverHumanId ? ` · ${s.handoverHumanId}` : ''}
              </div>
              {s.note && <div style={{ fontSize: 13, color: '#4C5352', marginTop: 2 }}>“{s.note}”</div>}
            </li>
          ))}
        </ol>
      )}
    </FinanceModal>
  )
}

/** A small button that opens the journey. */
export function PaymentJourneyButton({ paymentId, label = 'View journey' }: { paymentId: string; label?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="boe-btn boe-btn-secondary" style={{ minHeight: 32, padding: '4px 10px', fontSize: 13 }} onClick={() => setOpen(true)}>
        <Route size={14} strokeWidth={1.8} aria-hidden="true" /> {label}
      </button>
      {open && <PaymentJourneyDialog paymentId={paymentId} onClose={() => setOpen(false)} />}
    </>
  )
}
