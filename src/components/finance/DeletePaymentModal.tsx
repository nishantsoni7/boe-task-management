'use client'

// The Delete Payment confirmation — one modal, every Finance surface.
//
// Received Payments (this PR) and Payments to Verify (the Order/Finance branch)
// both mount THIS component. Neither owns a copy of the sequence, the wording or
// the outcome handling, because a destructive action that behaves differently
// depending on which list you reached it from is two actions wearing one name.
//
// WHAT IT SHOWS, AND WHY EACH LINE IS THERE. Amount, date and mode identify the
// payment without making the reader go and look it up; the allocation summary
// and its warning are the part that is not obvious — deleting the payment takes
// its allocations with it, and an operator who is clearing a PI blocker deserves
// to see how much money is about to stop being attributed and to what.
//
// IT DECIDES NOTHING. Whether this modal opens at all is canDeletePayment's
// answer, and whether the delete succeeds is row-level security's and the guard
// trigger's. This renders a question and reports an answer.

import { useState } from 'react'
import { colors } from '@/lib/tokens'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import {
  PAYMENT_DELETE_ALLOCATION_WARNING,
  PAYMENT_DELETE_BUSY_LABEL,
  PAYMENT_DELETE_CONFIRM_LABEL,
  PAYMENT_DELETE_TITLE,
  deletePaymentEntry,
  type DeletablePayment,
  type PaymentDeletionResult,
} from '@/lib/finance/paymentDeletion'
import type { SupabaseClient } from '@supabase/supabase-js'

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
  supabase,
  formatAmount,
  formatDate,
  modeLabel,
  describeError,
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
  supabase: SupabaseClient
  formatAmount: (amount: number) => string
  formatDate: (iso: string) => string
  modeLabel: (mode: string) => string
  describeError: (error: { code?: string; message: string }) => string
  onClose: () => void
  /** Re-read the list and the counts. Called on every settled outcome. */
  onDeleted: () => void
}) {
  const [deleting, setDeleting] = useState(false)
  const [result, setResult] = useState<PaymentDeletionResult | null>(null)

  // Once the outcome is final the confirmation is spent: the payment is either
  // gone or was never deletable, and neither offers a retry that can help. Every
  // dismissal path from here refreshes the list, because leaving a deleted row
  // on screen invites a second Delete that reports the wrong reason.
  // The only outcome deletePaymentEntry ever returns is final: nothing was
  // touched, and pressing again cannot change that in this build.
  const settled = result !== null

  const confirm = async () => {
    if (deleting || settled) return
    setDeleting(true)
    const outcome = await deletePaymentEntry(supabase, payment, describeError)
    setDeleting(false)
    setResult(outcome)
  }

  const message = result?.message ?? null
  // Not an error the operator made and not a partial outcome: nothing was
  // touched, and safe deletion arrives with the durable claim protocol. Drawn
  // as a notice rather than a failure.
  const isWarning = result?.outcome === 'unavailable'

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
          background: isWarning ? '#FFF7ED' : '#FEF2F2',
          border: `1px solid ${isWarning ? '#FED7AA' : '#FECACA'}`,
          color: isWarning ? '#9A3412' : '#B91C1C',
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
            {deleting ? PAYMENT_DELETE_BUSY_LABEL : PAYMENT_DELETE_CONFIRM_LABEL}
          </button>
        </div>
      )}
    </FinanceModal>
  )
}
