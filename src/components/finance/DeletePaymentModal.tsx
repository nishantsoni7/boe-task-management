'use client'

// The Delete Payment confirmation — one modal, every Finance surface.
//
// Received Payments mounts THIS component, and it is deliberately the ONLY
// implementation of the delete action on this branch. A destructive action
// that behaves differently depending on which list you reached it from is two
// actions wearing one name.
//
// WHAT IT SHOWS, AND WHY EACH LINE IS THERE. Amount, date and mode identify the
// payment without making the reader go and look it up; the allocation summary
// and its warning are the part that is not obvious — deleting the payment takes
// its allocations with it, and an operator who is clearing a PI blocker deserves
// to see how much money is about to stop being attributed and to what.
//
// THE ROUTE, NOT A FLAG. This branch carries migration 20261010000000 §11, so
// every deletion here — a payment with proof files or without — goes through
// the durable claim protocol at /api/finance/payments/delete: a claim is taken
// that freezes verification, proof mutation and allocation change before
// anything is touched, its manifest is swept, and only then is the row deleted.
// There is no unprotected fallback this modal can take instead: the
// application-level count-then-delete sequence lives in lib/finance/
// paymentDeletion.ts, and this branch never calls it, because a branch that has
// the claim protocol has no reason to race one.
//
// IT DECIDES NOTHING. Whether this modal opens at all is canDeletePayment's
// answer, and whether the delete succeeds is what the RPCs behind the route
// decide, under a row lock. This renders a question and reports an answer.

import { useState } from 'react'
import { colors } from '@/lib/tokens'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import {
  PAYMENT_DELETE_ALLOCATION_WARNING,
  PAYMENT_DELETE_BUSY_LABEL,
  PAYMENT_DELETE_CONFIRM_LABEL,
  PAYMENT_DELETE_TITLE,
  type DeletablePayment,
} from '@/lib/finance/paymentDeletion'
import {
  PAYMENT_DELETE_RETRY_LABEL,
  describePaymentDeletionFailure,
  type PaymentDeletionFailure,
} from '@/lib/finance/paymentDeletionProtocol'

export type DeletePaymentModalPayment = DeletablePayment & {
  amount: number
  payment_date: string
  payment_mode: string
  client_name?: string | null
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <span style={{
        fontSize: '10px', fontWeight: 600, color: colors.muted,
        textTransform: 'uppercase', letterSpacing: '0.05em',
      }}>{label}</span>
      <span style={{ fontSize: '13px', color: colors.primary, fontWeight: 600 }}>{value}</span>
    </div>
  )
}

export function DeletePaymentModal({
  payment,
  allocationSummary,
  formatAmount,
  formatDate,
  modeLabel,
  onClose,
  onDeleted,
}: {
  payment: DeletePaymentModalPayment
  /**
   * What this payment currently pays for, in one sentence, or null when it pays
   * for nothing. Withheld rather than guessed where the reader may not see every
   * allocation — the caller decides that, because it is the caller that knows
   * what the reader was allowed to load.
   */
  allocationSummary: string | null
  formatAmount: (amount: number) => string
  formatDate: (iso: string) => string
  modeLabel: (mode: string) => string
  onClose: () => void
  /** Re-read the list and the counts. Called on every settled outcome. */
  onDeleted: () => void
}) {
  const [deleting, setDeleting] = useState(false)
  const [deleted, setDeleted]   = useState(false)
  const [failure, setFailure]   = useState<PaymentDeletionFailure | null>(null)

  // A RETRYABLE FAILURE IS NOT SETTLED. The claim is still standing and the
  // next press resumes from the frozen manifest, so the destructive button
  // stays live and says what it is really doing.
  const settled = deleted || (failure !== null && !failure.retryable)

  const confirm = async () => {
    if (deleting || settled) return
    setDeleting(true)
    setFailure(null)

    let code: unknown = 'DELETE_FAILED'
    try {
      const response = await fetch('/api/finance/payments/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paymentId: payment.id }),
      })
      const body = await response.json().catch(() => null) as { ok?: boolean; code?: string } | null
      if (body?.ok === true) {
        setDeleting(false)
        setDeleted(true)
        onDeleted()
        return
      }
      code = body?.code
    } catch {
      // A network failure is exactly as retryable as a storage one: the claim
      // stands, nothing was reported deleted, and pressing again resumes.
    }
    setDeleting(false)
    setFailure(describePaymentDeletionFailure(code))
  }

  const message = failure?.message ?? null

  const confirmLabel = deleting
    ? PAYMENT_DELETE_BUSY_LABEL
    : failure?.retryable === true ? PAYMENT_DELETE_RETRY_LABEL : PAYMENT_DELETE_CONFIRM_LABEL

  return (
    <FinanceModal
      title={PAYMENT_DELETE_TITLE}
      onClose={settled ? onDeleted : onClose}
      closeOnBackdropClick={!deleting}
    >
      <div style={{ fontSize: '13px', color: colors.secondary, lineHeight: 1.7 }}>
        Delete this payment entry? This cannot be undone.
      </div>

      <div style={{
        background: colors.raised, borderRadius: '8px', padding: '12px 14px',
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px',
        border: `1px solid ${colors.border}`,
      }}>
        <Row label="Amount"       value={formatAmount(payment.amount)} />
        <Row label="Payment Date" value={formatDate(payment.payment_date)} />
        <Row label="Mode"         value={modeLabel(payment.payment_mode)} />
        {payment.client_name ? <Row label="Client" value={payment.client_name} /> : null}
      </div>

      {allocationSummary && (
        <div style={{
          padding: '10px 12px', borderRadius: '8px',
          background: '#FFF7ED', border: '1px solid #FED7AA', color: '#9A3412',
          fontSize: '12px', lineHeight: 1.55,
        }}>
          <div style={{ fontWeight: 600 }}>{allocationSummary}</div>
          <div style={{ marginTop: '3px' }}>{PAYMENT_DELETE_ALLOCATION_WARNING}</div>
        </div>
      )}

      {message && (
        <div role="alert" style={{
          padding: '10px 12px', borderRadius: '8px', fontSize: '12px', lineHeight: 1.55,
          background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C',
        }}>
          {message}
        </div>
      )}

      {settled ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '4px' }}>
          <button onClick={onDeleted} className="boe-btn boe-btn-primary" style={{ padding: '8px 18px', fontSize: '13px' }}>
            Close
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
          <button onClick={onClose} disabled={deleting} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={deleting}
            style={{
              padding: '8px 18px', fontSize: '13px', fontWeight: 600, borderRadius: '8px',
              border: 'none', color: '#fff', background: '#DC1F2E',
              cursor: deleting ? 'not-allowed' : 'pointer', opacity: deleting ? 0.6 : 1,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      )}
    </FinanceModal>
  )
}
