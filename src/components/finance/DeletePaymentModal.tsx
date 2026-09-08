'use client'

// The Delete Payment confirmation — one modal, every Finance surface.
//
// Admin-only (20261011000000): whether this modal is even offered is decided
// upstream by canDeletePayment (lib/finance/paymentDeletion.ts), which now
// checks only that the caller is an active admin — self-delete by a payment's
// own submitter is withdrawn. This component renders the question and reports
// the answer; it decides no authority of its own.
//
// EXCEPTIONAL FOR A CONFIRMED PAYMENT. Deleting money that has already been
// verified is an exceptional financial action, so every deletion here — not
// only a Confirmed Payment's — requires a typed reason and the exact Payment
// ID retyped, a summary of what is about to go, and (for a Confirmed Payment)
// an explicit warning that PI Draft and Order totals will change. The server
// (begin_finance_payment_deletion) re-validates both the reason and the typed
// ID; nothing here is trusted on its own.
//
// THE ROUTE, NOT A FLAG. Every deletion goes through the durable claim
// protocol at /api/finance/payments/delete: a claim is taken that freezes
// verification, proof mutation and allocation change before anything is
// touched, its manifest is swept, and only then is the row deleted.

import { useState } from 'react'
import { colors } from '@/lib/tokens'
import { customerDisplayName } from '@/lib/finance/paymentEntry'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import {
  PAYMENT_DELETE_ALLOCATION_WARNING,
  PAYMENT_DELETE_BUSY_LABEL,
  PAYMENT_DELETE_CONFIRM_LABEL,
  PAYMENT_DELETE_TITLE,
  PAYMENT_DELETE_REASON_LABEL,
  PAYMENT_DELETE_REASON_PLACEHOLDER,
  paymentDeleteConfirmIdLabel,
  paymentDeleteIdMismatchMessage,
  canSubmitPaymentDeletion,
  isConfirmedPaymentStatus,
  deletePaymentEntry,
  type DeletablePayment,
} from '@/lib/finance/paymentDeletion'
import { PAYMENT_DELETE_RETRY_LABEL } from '@/lib/finance/paymentDeletionProtocol'

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

const CONFIRM_ID_INPUT_ID = 'payment-delete-confirm-id'
const CONFIRM_ID_ERROR_ID = 'payment-delete-confirm-id-error'

/**
 * The typed-Payment-ID box, and what it says when what is typed is not it.
 *
 * A DISABLED BUTTON EXPLAINS NOTHING. The previous version signalled a mismatch
 * with a pale border and nothing else, so somebody who typed P-AA-0003 for
 * P-AA-0001 saw a dead Delete button and no statement of what was wrong — the
 * ID differs by one character and the two read alike at a glance. So the
 * mismatch is now said in words, under the box, WHILE TYPING rather than on
 * submit, and it names the ID that would be right.
 *
 * IT LOOSENS NOTHING. The comparison is still paymentDeleteIdMatches — exact,
 * case-sensitive, trimmed exactly as begin_finance_payment_deletion trims — and
 * this component neither pre-fills the box nor accepts a prefix of the ID.
 *
 * Separated from the dialog body so it can be rendered at each of its three
 * states (untouched, mismatched, matched) by a test that has no DOM to type
 * into; the dialog still owns the value.
 */
export function PaymentDeleteConfirmIdField({
  humanPaymentId, value, onChange, disabled,
}: {
  humanPaymentId: string
  value: string
  onChange: (next: string) => void
  disabled: boolean
}) {
  const mismatch = paymentDeleteIdMismatchMessage(value, humanPaymentId)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <label htmlFor={CONFIRM_ID_INPUT_ID} style={{ fontSize: '11px', fontWeight: 600, color: colors.muted }}>
        {paymentDeleteConfirmIdLabel(humanPaymentId)}
      </label>
      <input
        id={CONFIRM_ID_INPUT_ID}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        placeholder={humanPaymentId}
        aria-invalid={mismatch !== null}
        aria-describedby={mismatch ? CONFIRM_ID_ERROR_ID : undefined}
        style={{
          fontSize: '13px', padding: '8px 10px', borderRadius: '8px',
          border: `1px solid ${mismatch ? '#DC2626' : colors.border}`,
          background: mismatch ? '#FEF2F2' : undefined,
          fontFamily: 'monospace',
        }}
        // The one input on this dialog that is a code rather than prose: a phone
        // keyboard that capitalised the first letter would type "P-aa-0001" and
        // then be told of a mismatch the person did not make.
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {/* The BOE inline field error: 11px, #C13030, directly beneath the box —
          the same shape OrderField draws, and gone the moment it stops being
          true rather than at submit. */}
      {mismatch && (
        <div id={CONFIRM_ID_ERROR_ID} role="alert" style={{ fontSize: '11px', color: '#C13030', lineHeight: 1.5 }}>
          {mismatch}
        </div>
      )}
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
  const [reason, setReason] = useState('')
  const [typedId, setTypedId] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleted, setDeleted]   = useState(false)
  const [failure, setFailure]   = useState<{ message: string; retryable: boolean } | null>(null)

  const isConfirmed = isConfirmedPaymentStatus(payment.status)
  const canSubmit = canSubmitPaymentDeletion({
    reason, typedId, humanPaymentId: payment.human_payment_id,
  })

  // A RETRYABLE FAILURE IS NOT SETTLED. The claim is still standing and the
  // next press resumes from the frozen manifest, so the destructive button
  // stays live and says what it is really doing.
  const settled = deleted || (failure !== null && !failure.retryable)

  const confirm = async () => {
    if (deleting || settled || !canSubmit) return
    setDeleting(true)
    setFailure(null)

    const result = await deletePaymentEntry(payment, reason, typedId)
    setDeleting(false)
    if (result.outcome === 'success') {
      setDeleted(true)
      onDeleted()
      return
    }
    setFailure({ message: result.message, retryable: result.retryable })
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
        {isConfirmed && (
          <div style={{ marginTop: '4px', fontWeight: 600, color: colors.primary }}>
            This is a Confirmed Payment — money already verified as received.
          </div>
        )}
      </div>

      <div style={{
        background: colors.raised, borderRadius: '8px', padding: '12px 14px',
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px',
        border: `1px solid ${colors.border}`,
      }}>
        <Row label="Payment ID"   value={payment.human_payment_id} />
        <Row label="Status"       value={payment.status} />
        <Row label="Amount"       value={formatAmount(payment.amount)} />
        <Row label="Payment Date" value={formatDate(payment.payment_date)} />
        <Row label="Mode"         value={modeLabel(payment.payment_mode)} />
        {/* ALWAYS SHOWN, and never blank. A payment with no customer is a real
            state since 20261013000000 — it names no PI Draft and no Order — and
            somebody about to delete a payment should read that fact rather than
            wonder whether a row is missing. */}
        <Row label="Customer" value={customerDisplayName(payment.client_name)} />
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

      {!settled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: '11px', fontWeight: 600, color: colors.muted }}>
              {PAYMENT_DELETE_REASON_LABEL}
            </span>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder={PAYMENT_DELETE_REASON_PLACEHOLDER}
              disabled={deleting}
              rows={2}
              style={{
                fontSize: '13px', padding: '8px 10px', borderRadius: '8px',
                border: `1px solid ${colors.border}`, resize: 'vertical', fontFamily: 'inherit',
              }}
            />
          </label>

          <PaymentDeleteConfirmIdField
            humanPaymentId={payment.human_payment_id}
            value={typedId}
            onChange={setTypedId}
            disabled={deleting}
          />
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
            disabled={deleting || !canSubmit}
            style={{
              padding: '8px 18px', fontSize: '13px', fontWeight: 600, borderRadius: '8px',
              border: 'none', color: '#fff', background: '#DC1F2E',
              cursor: (deleting || !canSubmit) ? 'not-allowed' : 'pointer', opacity: (deleting || !canSubmit) ? 0.6 : 1,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      )}
    </FinanceModal>
  )
}
