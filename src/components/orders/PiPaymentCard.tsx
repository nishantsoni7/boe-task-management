'use client'

// ── PI payments: the entry form, the progress bar and the details dialog ──────
//
// It deliberately does NOT redesign anything outside itself: it reuses the
// existing colour tokens and the existing Finance modal shell.
//
// Every figure it prints is computed in the database (pi_submission_payment_summary)
// in numeric. This file formats; it never calculates money.
//
// AND IT DECIDES NOTHING. Approve and Reject are drawn on a row only when the
// page hands this dialog a decision handler AND the shared Finance rule allows
// the row; the handler runs the same server doors Finance uses
// (src/lib/finance/paymentDecision.ts), which re-derive every permission.

import { useCallback, useRef, useState } from 'react'
import { colors } from '@/lib/tokens'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import type { PaymentDecision } from '@/lib/finance/paymentDecision'
import {
  EMPTY_PI_PAYMENT_FORM,
  PI_PAYMENT_MODES,
  PI_PAYMENT_PROOF_FAILED,
  PI_PAYMENT_RECORDED_BODY,
  canSubmitPiPayment,
  describePiPaymentRow,
  OWN_PAYMENT_DECISION_NOTE,
  piPaymentErrorMessage,
  piPaymentTermLines,
  validatePiPaymentForm,
  type PiPaymentFormState,
  type PiPaymentRowView,
  type PiPaymentSummary,
  type PiPaymentTone,
} from '@/lib/finance/piPaymentView'

const TONE_COLOR: Record<PiPaymentTone, { fg: string; bg: string; border: string }> = {
  amber:   { fg: '#9A6212',    bg: colors.amberTint, border: 'rgba(232,160,48,0.28)' },
  blue:    { fg: '#2F5BB7',    bg: colors.blueTint,  border: 'rgba(85,133,232,0.28)' },
  red:     { fg: '#B23B3B',    bg: colors.redTint,   border: 'rgba(217,79,79,0.28)' },
  green:   { fg: '#2F7A52',    bg: colors.greenTint, border: 'rgba(69,168,112,0.28)' },
  neutral: { fg: colors.tertiary, bg: colors.raised, border: colors.border },
}

function StatusChip({ label, tone }: { label: string; tone: PiPaymentTone }) {
  const t = TONE_COLOR[tone]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 8px', borderRadius: '5px', whiteSpace: 'nowrap',
      fontSize: '11px', fontWeight: 600,
      color: t.fg, background: t.bg, border: `1px solid ${t.border}`,
    }}>
      {label}
    </span>
  )
}

// ── The progress bar ──────────────────────────────────────────────────────────

/** The remainder while the requirement is not met: a soft red, never a solid one. */
const REMAINDER_SHORT = '#F4D9D9'
const REMAINDER_MET = '#E8EBF0'

/**
 * Confirmed money against the PI total, as ONE track.
 *
 * Green is the database's verified percentage; the rest of the track is the part
 * not yet confirmed — soft red while the requirement is unmet, neutral once it is
 * met. A thin tick marks the requirement on the same scale. Both widths arrive
 * clamped to 0–100, so an overpaid PI fills the track and never overflows it.
 */
export function PiPaymentProgress({ barPercent, thresholdPercent, requirementMet, label }: {
  barPercent: number
  thresholdPercent: number | null
  requirementMet: boolean
  /** The accessible name: what the bar measures, with the figure. */
  label: string
}) {
  const showTick = thresholdPercent !== null && thresholdPercent > 0 && thresholdPercent < 100
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(barPercent)}
      style={{
        position: 'relative', width: '100%', height: '8px', borderRadius: '999px',
        overflow: 'hidden', background: requirementMet ? REMAINDER_MET : REMAINDER_SHORT,
      }}
    >
      <div style={{ width: `${barPercent}%`, height: '100%', borderRadius: '999px', background: colors.green }} />
      {showTick && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute', top: 0, bottom: 0, left: `${thresholdPercent}%`,
            width: '2px', marginLeft: '-1px', background: 'rgba(17,19,24,0.32)',
          }}
        />
      )}
    </div>
  )
}

/** The payment status figures a page has already built from the summary. */
export type PiPaymentStatusFigures = {
  confirmed: string
  required: string
  requiredNote: string | null
  percent: string
  total: string
  barPercent: number
  thresholdPercent: number | null
  requirementMet: boolean
  pendingCount: number
  pendingAmount: string
}

// ── Add Payment ───────────────────────────────────────────────────────────────

const LABEL: React.CSSProperties = {
  fontSize: '11px', fontWeight: 600, color: colors.secondary, marginBottom: '4px',
}
const INPUT: React.CSSProperties = {
  width: '100%', padding: '8px 10px', fontSize: '13px',
  border: `1px solid ${colors.borderSoft}`, borderRadius: '6px',
  background: colors.base, color: colors.primary, boxSizing: 'border-box',
}
const ERR: React.CSSProperties = { fontSize: '11px', color: colors.red, marginTop: '3px' }

export function AddPiPaymentModal({ todayIso, saving, onClose, onSubmit }: {
  todayIso: string
  saving: boolean
  onClose: () => void
  onSubmit: (form: PiPaymentFormState, proof: File | null) => Promise<string | null>
}) {
  const [form, setForm] = useState<PiPaymentFormState>({ ...EMPTY_PI_PAYMENT_FORM, paymentDate: todayIso })
  const [proof, setProof] = useState<File | null>(null)
  const [touched, setTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Belt and braces alongside `saving`: a second click that lands in the same
  // tick, before the parent's saving state has propagated, is still refused.
  const submittedRef = useRef(false)
  const [submitted, setSubmitted] = useState(false)

  const errors = validatePiPaymentForm(form, todayIso)
  const allowed = canSubmitPiPayment({ form, todayIso, saving, submitted })

  const set = (k: keyof PiPaymentFormState) => (v: string) => setForm(f => ({ ...f, [k]: v }))

  const submit = async () => {
    if (submittedRef.current || !allowed) { setTouched(true); return }
    submittedRef.current = true
    setSubmitted(true)
    setError(null)
    const err = await onSubmit(form, proof)
    if (err) {
      // A failure returns the form to the user with what they typed intact.
      submittedRef.current = false
      setSubmitted(false)
      setError(err)
    }
  }

  return (
    <FinanceModal title="Add payment" onClose={onClose} width="440px" closeOnBackdropClick={false}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div>
          <div style={LABEL}>Amount received <span style={{ color: colors.red }}>*</span></div>
          <input
            style={INPUT} inputMode="decimal" autoFocus placeholder="0.00"
            value={form.amount} onChange={e => set('amount')(e.target.value)}
          />
          {touched && errors.amount && <div style={ERR}>{errors.amount}</div>}
        </div>

        <div>
          <div style={LABEL}>Payment date <span style={{ color: colors.red }}>*</span></div>
          <input
            style={INPUT} type="date" max={todayIso}
            value={form.paymentDate} onChange={e => set('paymentDate')(e.target.value)}
          />
          {touched && errors.paymentDate && <div style={ERR}>{errors.paymentDate}</div>}
        </div>

        <div>
          <div style={LABEL}>Payment mode <span style={{ color: colors.red }}>*</span></div>
          <select style={INPUT} value={form.paymentMode} onChange={e => set('paymentMode')(e.target.value)}>
            <option value="">Select…</option>
            {PI_PAYMENT_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          {touched && errors.paymentMode && <div style={ERR}>{errors.paymentMode}</div>}
        </div>

        <div>
          <div style={LABEL}>Reference / UTR <span style={{ color: colors.muted }}>(optional)</span></div>
          <input style={INPUT} value={form.reference} onChange={e => set('reference')(e.target.value)} />
        </div>

        <div>
          <div style={LABEL}>Remarks <span style={{ color: colors.muted }}>(optional)</span></div>
          <input style={INPUT} value={form.remarks} onChange={e => set('remarks')(e.target.value)} />
        </div>

        <div>
          <div style={LABEL}>Payment proof <span style={{ color: colors.muted }}>(optional)</span></div>
          <input
            style={{ ...INPUT, padding: '6px 8px' }} type="file"
            accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
            onChange={e => setProof(e.target.files?.[0] ?? null)}
          />
        </div>

        {error && (
          <div style={{
            fontSize: '12px', color: colors.red, background: colors.redTint,
            border: '1px solid rgba(217,79,79,0.2)', borderRadius: '6px', padding: '8px 10px',
          }}>
            {error}
          </div>
        )}

        <div style={{
          fontSize: '11px', color: colors.muted, background: colors.raised,
          border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '8px 10px',
        }}>
          This records that a payment was received. Finance verifies it separately —
          nothing counts as confirmed until they do.
        </div>

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '2px' }}>
          <button
            type="button" onClick={onClose} disabled={saving || submitted}
            style={{
              padding: '8px 14px', fontSize: '12px', fontWeight: 600, borderRadius: '6px',
              border: `1px solid ${colors.borderSoft}`, background: colors.base,
              color: colors.secondary, cursor: saving || submitted ? 'not-allowed' : 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button" onClick={submit} disabled={!allowed}
            style={{
              padding: '8px 14px', fontSize: '12px', fontWeight: 600, borderRadius: '6px',
              border: 'none', background: allowed ? colors.primary : colors.hover,
              color: allowed ? '#fff' : colors.muted,
              cursor: allowed ? 'pointer' : 'not-allowed',
            }}
          >
            {saving || submitted ? 'Recording…' : 'Record payment'}
          </button>
        </div>
      </div>
    </FinanceModal>
  )
}

// ── Payment details ───────────────────────────────────────────────────────────

export const PAYMENT_DETAILS_TITLE = 'Payment details'
export const APPROVE_PAYMENT_LABEL = 'Approve'
export const REJECT_PAYMENT_LABEL = 'Reject'

/** The decision a verifier has started on one row, before confirming it. */
type ArmedDecision = { paymentId: string; requestNumber: string; decision: PaymentDecision }

const SMALL_BUTTON: React.CSSProperties = {
  padding: '5px 11px', fontSize: '12px', fontWeight: 600, borderRadius: '6px', cursor: 'pointer',
  whiteSpace: 'nowrap',
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: 'amber' }) {
  return (
    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <span style={{ fontSize: '11px', color: colors.muted }}>{label}</span>
      <span style={{
        fontSize: '16px', fontWeight: 700, fontVariantNumeric: 'tabular-nums',
        color: tone === 'amber' ? '#9A6212' : colors.primary,
        overflowWrap: 'anywhere',
      }}>
        {value}
      </span>
    </div>
  )
}

/**
 * One payment against this PI: when, how, how much, and where it stands —
 * with Approve and Reject only where this viewer may decide it.
 */
export function PiPaymentRow({
  row, armed, note, busy, error, onOpenProof, onArm, onNote, onCancel, onConfirm,
}: {
  row: PiPaymentRowView
  /** The decision started on THIS row, or null. */
  armed: PaymentDecision | null
  note: string
  busy: boolean
  error: string | null
  onOpenProof: (paymentId: string) => void
  onArm: (decision: PaymentDecision) => void
  onNote: (value: string) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const noteId = `pi-payment-note-${row.key}`
  const reasonMissing = armed === 'reject' && note.trim() === ''
  return (
    <li style={{
      listStyle: 'none', padding: '12px 0', borderTop: `1px solid ${colors.border}`,
      display: 'flex', flexDirection: 'column', gap: '5px',
      opacity: row.reversed ? 0.55 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, fontSize: '12.5px', color: colors.primary, fontWeight: 600 }}>
          {row.date}
          <span style={{ color: colors.tertiary, fontWeight: 400 }}> · {row.mode}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '14px', fontWeight: 700, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
            {row.amount}
          </span>
          <StatusChip label={row.statusLabel} tone={row.statusTone} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: '4px 12px', flexWrap: 'wrap', fontSize: '11.5px', color: colors.tertiary }}>
        {row.reference && <span>Ref {row.reference}</span>}
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{row.requestNumber}</span>
        {row.recordedBy && <span>Recorded by {row.recordedBy}</span>}
        {row.paymentAmount && <span>Part of a {row.paymentAmount} payment</span>}
        {row.reversed && <span>Allocation reversed</span>}
        {row.canOpenProof && (
          <button
            type="button"
            onClick={() => onOpenProof(row.paymentId)}
            style={{
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              fontSize: '11.5px', color: colors.blue, textDecoration: 'underline',
            }}
          >
            Proof
          </button>
        )}
      </div>

      {row.note && (
        <div style={{
          fontSize: '12px', lineHeight: 1.45, borderRadius: '6px', padding: '6px 10px',
          color: row.note.rejected ? '#B23B3B' : colors.secondary,
          background: row.note.rejected ? colors.redTint : colors.raised,
          border: `1px solid ${row.note.rejected ? 'rgba(217,79,79,0.2)' : colors.border}`,
        }}>
          {row.note.heading}: {row.note.text}
        </div>
      )}

      {row.ownPending && (
        <div style={{ fontSize: '12px', color: colors.tertiary, lineHeight: 1.5 }}>
          {OWN_PAYMENT_DECISION_NOTE}
        </div>
      )}

      {row.canDecide && armed === null && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', paddingTop: '2px' }}>
          <button
            type="button"
            onClick={() => onArm('approve')}
            disabled={busy}
            style={{ ...SMALL_BUTTON, border: 'none', background: '#2F7A52', color: '#fff' }}
          >
            {APPROVE_PAYMENT_LABEL}
          </button>
          <button
            type="button"
            onClick={() => onArm('reject')}
            disabled={busy}
            style={{ ...SMALL_BUTTON, border: '1px solid rgba(217,79,79,0.35)', background: colors.base, color: colors.red }}
          >
            {REJECT_PAYMENT_LABEL}
          </button>
        </div>
      )}

      {row.canDecide && armed !== null && (
        <div style={{
          marginTop: '4px', padding: '10px 12px', borderRadius: '8px',
          background: colors.raised, border: `1px solid ${colors.border}`,
          display: 'flex', flexDirection: 'column', gap: '8px',
        }}>
          <label htmlFor={noteId} style={{ fontSize: '11.5px', fontWeight: 600, color: colors.secondary }}>
            {armed === 'reject' ? 'Reason for rejecting (required)' : 'Note (optional)'}
          </label>
          <textarea
            id={noteId}
            value={note}
            onChange={e => onNote(e.target.value)}
            rows={2}
            disabled={busy}
            style={{
              width: '100%', boxSizing: 'border-box', resize: 'vertical',
              padding: '7px 9px', fontSize: '12.5px', fontFamily: 'inherit',
              border: `1px solid ${colors.borderSoft}`, borderRadius: '6px', background: colors.base,
            }}
          />
          {error && (
            <div role="alert" style={{ fontSize: '12px', color: '#B23B3B' }}>{error}</div>
          )}
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              style={{ ...SMALL_BUTTON, border: `1px solid ${colors.borderSoft}`, background: colors.base, color: colors.secondary }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy || reasonMissing}
              style={{
                ...SMALL_BUTTON, border: 'none', color: '#fff',
                background: armed === 'reject' ? colors.red : '#2F7A52',
                opacity: busy || reasonMissing ? 0.6 : 1,
              }}
            >
              {busy
                ? (armed === 'reject' ? 'Rejecting…' : 'Approving…')
                : (armed === 'reject' ? 'Confirm rejection' : 'Confirm approval')}
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

/**
 * Every payment against this PI, in the dialog the rest of the application
 * already uses: the same figures and bar as the page's status card, then one
 * row per payment.
 *
 * `onDecide` is null for anybody the page did not resolve as a payment verifier,
 * and then no row draws a decision control at all.
 */
export function PiPaymentDetailsModal({
  summary, status, loading, onOpenProof, onClose, canVerify, onDecide, ownPaymentIds,
}: {
  summary: PiPaymentSummary | null
  /** The page's own status figures, so the dialog and the card cannot disagree. */
  status: PiPaymentStatusFigures | null
  loading: boolean
  onOpenProof: (paymentId: string) => void
  onClose: () => void
  /** finance.approve with Finance module entry, as the page resolved it. */
  canVerify: boolean
  /** Runs the decision and refreshes the summary. Resolves to an error sentence, or null. */
  onDecide: ((paymentId: string, decision: PaymentDecision, note: string) => Promise<string | null>) | null
  /** Payments this viewer recorded: they draw no decision, whatever the capability. */
  ownPaymentIds?: ReadonlySet<string>
}) {
  const [armed, setArmed] = useState<ArmedDecision | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // State updates are async; this is not. Two clicks in the same tick cannot
  // both send a decision.
  const busyRef = useRef(false)

  const decisionsAllowed = canVerify && onDecide !== null
  const rows = (summary?.payments ?? []).map(row => describePiPaymentRow(row, {
    canVerify: decisionsAllowed,
    ownPayment: ownPaymentIds?.has(row.payment_id) ?? false,
  }))
  const terms = piPaymentTermLines(summary)

  const close = useCallback(() => {
    if (busyRef.current) return
    onClose()
  }, [onClose])

  const arm = (row: PiPaymentRowView, decision: PaymentDecision) => {
    if (busyRef.current) return
    setArmed({ paymentId: row.paymentId, requestNumber: row.requestNumber, decision })
    setNote('')
    setError(null)
    setNotice(null)
  }

  const confirm = async () => {
    if (!armed || !onDecide || busyRef.current) return
    if (armed.decision === 'reject' && note.trim() === '') return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const failure = await onDecide(armed.paymentId, armed.decision, note)
      if (failure) { setError(failure); return }
      setNotice(`${armed.requestNumber} ${armed.decision === 'approve' ? 'approved' : 'rejected'}. Payment status updated.`)
      setArmed(null)
      setNote('')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <FinanceModal
      title={PAYMENT_DETAILS_TITLE}
      onClose={close}
      width="640px"
      // A typed reason is unsaved input: a backdrop click must not discard it.
      closeOnBackdropClick={armed === null}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {status && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px' }}>
              <Figure label="Confirmed" value={status.confirmed} />
              <Figure
                label="Pending verification"
                value={status.pendingCount > 0 ? status.pendingAmount : '—'}
                tone={status.pendingCount > 0 ? 'amber' : undefined}
              />
              <Figure label="Required" value={status.required} />
            </div>
            <PiPaymentProgress
              barPercent={status.barPercent}
              thresholdPercent={status.thresholdPercent}
              requirementMet={status.requirementMet}
              label={`Confirmed payment: ${status.percent} of the PI total`}
            />
            <div style={{ fontSize: '11.5px', color: colors.tertiary, fontVariantNumeric: 'tabular-nums' }}>
              {status.percent} confirmed of {status.total}
            </div>
          </div>
        )}

        {notice && (
          <div role="status" style={{
            fontSize: '12px', color: '#2F7A52', background: colors.greenTint,
            border: '1px solid rgba(69,168,112,0.25)', borderRadius: '6px', padding: '8px 10px',
          }}>
            {notice}
          </div>
        )}

        {rows.length === 0 ? (
          <div style={{ padding: '14px 0 4px', fontSize: '12px', color: colors.secondary, borderTop: `1px solid ${colors.border}` }}>
            {loading ? 'Loading payments…' : 'No payment has been recorded against this PI yet.'}
          </div>
        ) : (
          <ul style={{ margin: 0, padding: 0 }}>
            {rows.map(row => {
              const mine = armed !== null && armed.paymentId === row.paymentId
              return (
                <PiPaymentRow
                  key={row.key}
                  row={row}
                  armed={mine ? armed.decision : null}
                  note={mine ? note : ''}
                  busy={busy}
                  error={mine ? error : null}
                  onOpenProof={onOpenProof}
                  onArm={decision => arm(row, decision)}
                  onNote={setNote}
                  onCancel={() => { if (!busyRef.current) { setArmed(null); setError(null) } }}
                  onConfirm={() => { void confirm() }}
                />
              )
            })}
          </ul>
        )}

        {/* The agreed commercial terms, when there are any. Plain text, printed
            as typed: this is not a schedule and nothing here parses it. */}
        {terms.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', paddingTop: '10px', borderTop: `1px solid ${colors.border}` }}>
            {terms.map(t => (
              <div key={t.key} style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
                <div style={{ fontSize: '11px', color: colors.muted }}>{t.label}</div>
                <div style={{ fontSize: '12.5px', color: colors.secondary, lineHeight: 1.45 }}>{t.value}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </FinanceModal>
  )
}

export { PI_PAYMENT_RECORDED_BODY, PI_PAYMENT_PROOF_FAILED, piPaymentErrorMessage }
