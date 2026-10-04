'use client'

// "Delete payment request?" — the confirmation for a salesperson removing their
// own unapproved request. The admin dialog (DeletePaymentModal) is a different
// action; see lib/finance/ownPaymentRequestDeletion.ts.
//
// A FAILURE KEEPS THE ROW AND THE DIALOG: the message is shown here, nothing is
// removed from the list, and Delete request stays available to retry. Cancel
// closes with nothing sent. A second press while one is in flight is ignored by a
// ref, not only by the disabled button, so a fast double click cannot send twice.

import { useRef, useState } from 'react'
import { colors } from '@/lib/tokens'
import { customerDisplayName } from '@/lib/finance/paymentEntry'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import {
  OWN_DELETE_BUSY_LABEL,
  OWN_DELETE_CANCEL_LABEL,
  OWN_DELETE_CONFIRM_LABEL,
  OWN_DELETE_MESSAGE,
  OWN_DELETE_TITLE,
  type OwnDeleteResult,
} from '@/lib/finance/ownPaymentRequestDeletion'

export type DeleteOwnPaymentRequestModalPayment = {
  id: string
  human_payment_id: string
  client_name?: string | null
  amount: number
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
      <span style={{ fontSize: '10px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </span>
      <span style={{ fontSize: '13px', color: colors.primary, fontWeight: 600, overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  )
}

export function DeleteOwnPaymentRequestModal({
  payment,
  formatAmount,
  onDelete,
  onClose,
  onDeleted,
}: {
  payment: DeleteOwnPaymentRequestModalPayment
  formatAmount: (amount: number) => string
  /** Performs the deletion; the page wires the database call. */
  onDelete: (paymentId: string) => Promise<OwnDeleteResult>
  onClose: () => void
  /** Called once, after a successful deletion — refresh the list and counts. */
  onDeleted: (paymentId: string) => void
}) {
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const confirm = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setMessage(null)
    const result = await onDelete(payment.id)
    if (result.outcome === 'success') {
      onDeleted(payment.id)
      return
    }
    setMessage(result.message)
    setBusy(false)
    inFlight.current = false
  }

  return (
    <FinanceModal title={OWN_DELETE_TITLE} onClose={onClose} closeOnBackdropClick={!busy}>
      <div style={{ fontSize: '13px', color: colors.secondary, lineHeight: 1.6 }}>{OWN_DELETE_MESSAGE}</div>

      <div style={{
        background: colors.raised, borderRadius: '8px', padding: '12px 14px',
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px',
        border: `1px solid ${colors.border}`,
      }}>
        <Row label="Payment ID" value={payment.human_payment_id} />
        <Row label="Client" value={customerDisplayName(payment.client_name)} />
        <Row label="Requested payment amount" value={formatAmount(payment.amount)} />
      </div>

      {message && (
        <div role="alert" style={{
          padding: '10px 12px', borderRadius: '8px', fontSize: '12px', lineHeight: 1.55,
          background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C',
        }}>
          {message}
        </div>
      )}

      <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
        <button onClick={onClose} disabled={busy} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>
          {OWN_DELETE_CANCEL_LABEL}
        </button>
        <button
          onClick={confirm}
          disabled={busy}
          style={{
            padding: '8px 18px', fontSize: '13px', fontWeight: 600, borderRadius: '8px',
            border: 'none', color: '#fff', background: '#DC1F2E',
            cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? OWN_DELETE_BUSY_LABEL : OWN_DELETE_CONFIRM_LABEL}
        </button>
      </div>
    </FinanceModal>
  )
}
