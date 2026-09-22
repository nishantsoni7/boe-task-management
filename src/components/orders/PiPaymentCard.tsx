'use client'

// ── PI payments: the entry form, the progress bar and the details dialog ──────
//
// It deliberately does NOT redesign anything outside itself: it reuses the
// existing colour tokens and the existing Finance modal shell.
//
// Every figure it prints is computed in the database (pi_submission_payment_summary)
// in numeric. This file formats; it never calculates money. The only quantities
// derived here are bar WIDTHS, clamped to the track and never shown as figures.
//
// AND IT DECIDES NOTHING. Approve and Reject are drawn on a row only when the
// page hands this dialog a decision handler AND the shared Finance rule allows
// the row; the handler runs the same server doors Finance uses
// (src/lib/finance/paymentDecision.ts), which re-derive every permission.

import { useCallback, useRef, useState } from 'react'
import { colors } from '@/lib/tokens'
import { amountInputProblem } from '@/lib/currency'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { PaymentModeHint } from '@/app/finance/components/PaymentModeHint'
import type { PaymentDecision } from '@/lib/finance/paymentDecision'
import {
  EMPTY_PI_PAYMENT_FORM,
  PI_PAYMENT_MODES,
  PI_PAYMENT_PROOF_FAILED,
  PI_PAYMENT_RECORDED_BODY,
  canSubmitPiPayment,
  countPiPaymentRows,
  describePaymentCount,
  describePiPaymentRow,
  filterPiPaymentRows,
  OWN_PAYMENT_DECISION_NOTE,
  piPaymentErrorMessage,
  piPaymentTermLines,
  validatePiPaymentForm,
  type PiPaymentFilter,
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

/**
 * The three shares of the PI total the bar draws, left to right. Green is money
 * Finance verified; amber is money recorded as received and still awaiting
 * verification; red is the part of the PI total not yet received. Meeting the
 * advance requirement changes none of them: an advance confirmed is not a PI
 * paid.
 */
export const PAYMENT_BAR_COLORS = {
  confirmed: colors.green,
  awaiting: colors.amber,
  unpaid: colors.red,
} as const

/**
 * THE SAME THREE SHARES, ONE STEP QUIETER — for a screen where the payment
 * section is one of several and must not be the loudest thing on it. The
 * MEANING of each colour is unchanged and no caller may remap a share to a
 * different one; only the saturation differs.
 */
export const PAYMENT_BAR_COLORS_SUBDUED = {
  confirmed: 'rgba(69,168,112,0.72)',
  awaiting: 'rgba(232,160,48,0.68)',
  unpaid: 'rgba(0,0,0,0.09)',
} as const

export type PaymentBarPalette = {
  readonly confirmed: string
  readonly awaiting: string
  readonly unpaid: string
}

/** A share of the track: a pixel quantity, clamped to 0–100, never a figure. */
const trackWidth = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0

/**
 * Received money against the FULL PI total, as one track: green for the
 * confirmed share, amber for the rest of what was received, then red for
 * everything not yet received. At 0% the track is entirely red; at 100%
 * confirmed it is entirely green. A thin tick marks the advance requirement on
 * the same scale and changes no colour.
 *
 * Both shares arrive as the database's own percentages of the PI total and are
 * clamped here, so an overpaid PI fills the track and never overflows it. The
 * received share never draws short of the confirmed one — confirmed money IS
 * received money — and the amber width is the gap between the two, rounded to
 * hundredths only so the style attribute stays readable.
 */
export function PiPaymentProgress({ confirmedPercent, receivedPercent, thresholdPercent, label, height = 8, palette = PAYMENT_BAR_COLORS }: {
  /** verified_percent: confirmed money as a share of the PI total. */
  confirmedPercent: number
  /** attached_percent: confirmed plus awaiting verification, as a share of the PI total. */
  receivedPercent: number
  thresholdPercent: number | null
  /** The accessible name: what the bar measures, with the figures. */
  label: string
  /** Track height in pixels. */
  height?: number
  /**
   * The three fills, for a caller that needs this same bar to sit quieter.
   * DEFAULTS TO THE PI PALETTE, so every existing caller draws exactly as before.
   */
  palette?: PaymentBarPalette
}) {
  const confirmed = trackWidth(confirmedPercent)
  const received = Math.max(confirmed, trackWidth(receivedPercent))
  const awaiting = Math.round((received - confirmed) * 100) / 100
  const showTick = thresholdPercent !== null && thresholdPercent > 0 && thresholdPercent < 100
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(received)}
      style={{
        position: 'relative', display: 'flex', width: '100%', height: `${height}px`, borderRadius: '999px',
        overflow: 'hidden',
      }}
    >
      {confirmed > 0 && (
        <div
          data-segment="confirmed"
          style={{ width: `${confirmed}%`, flexShrink: 0, height: '100%', background: palette.confirmed }}
        />
      )}
      {awaiting > 0 && (
        <div
          data-segment="awaiting"
          style={{ width: `${awaiting}%`, flexShrink: 0, height: '100%', background: palette.awaiting }}
        />
      )}
      {received < 100 && (
        <div
          data-segment="unpaid"
          style={{ flexGrow: 1, height: '100%', background: palette.unpaid }}
        />
      )}
      {showTick && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute', top: 0, bottom: 0, left: `${thresholdPercent}%`,
            width: '2px', marginLeft: '-1px', background: '#FFFFFF',
          }}
        />
      )}
    </div>
  )
}

/** The payment status figures a page has already built from the summary. */
export type PiPaymentStatusFigures = {
  /** attached_amount, formatted: confirmed plus awaiting verification. */
  received: string
  /** attached_percent, formatted. */
  receivedPercent: string
  /** verified_amount, formatted. */
  confirmed: string
  /** Active allocations Finance verified. A count of rows. */
  confirmedCount: number
  /** verified_percent, formatted. */
  percent: string
  total: string
  /** 0–100: the confirmed share of the bar. */
  barPercent: number
  /** 0–100: the received share of the bar, never less than barPercent. */
  receivedBarPercent: number
  thresholdPercent: number | null
  /** Active allocations still with Finance. A count of rows. */
  pendingCount: number
  /** unverified_amount, formatted. */
  pendingAmount: string
  /** unverified_percent, formatted. */
  pendingPercent: string
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
  // An amount that cannot be accepted says why AT ONCE, like every other payment
  // form: the button is disabled while it is wrong, so waiting for a press to
  // reveal the reason would never reveal it (PR #172 review).
  const amountMessage = amountInputProblem(form.amount) ?? (touched ? errors.amount ?? null : null)

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
          {amountMessage && <div role="alert" style={ERR}>{amountMessage}</div>}
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
          <PaymentModeHint mode={form.paymentMode} />
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

/**
 * The dialog's three views, each titled for what it holds. Payment details is
 * every row recorded against the PI; the other two are exactly the rows behind
 * the status card's Confirmed and Awaiting verification figures.
 */
export const PAYMENT_FILTER_TITLE: Record<PiPaymentFilter, string> = {
  all: PAYMENT_DETAILS_TITLE,
  confirmed: 'Confirmed payments',
  awaiting: 'Payments awaiting verification',
}

export const PAYMENT_FILTER_TAB: Record<PiPaymentFilter, string> = {
  all: 'All',
  confirmed: 'Confirmed',
  awaiting: 'Awaiting verification',
}

const PAYMENT_FILTER_EMPTY: Record<PiPaymentFilter, string> = {
  all: 'No payment has been recorded against this PI yet.',
  confirmed: 'No payment against this PI has been confirmed yet.',
  awaiting: 'No payment against this PI is awaiting verification.',
}

const PAYMENT_FILTERS: readonly PiPaymentFilter[] = ['all', 'confirmed', 'awaiting']

/** The decision a verifier has started on one row, before confirming it. */
type ArmedDecision = { paymentId: string; requestNumber: string; decision: PaymentDecision }

const SMALL_BUTTON: React.CSSProperties = {
  padding: '5px 11px', fontSize: '12px', fontWeight: 600, borderRadius: '6px', cursor: 'pointer',
  whiteSpace: 'nowrap',
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: 'amber' | 'green' }) {
  return (
    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <span style={{ fontSize: '11px', color: colors.muted }}>{label}</span>
      <span style={{
        fontSize: '16px', fontWeight: 700, fontVariantNumeric: 'tabular-nums',
        color: tone === 'amber' ? '#9A6212' : tone === 'green' ? '#2F7A52' : colors.primary,
        overflowWrap: 'anywhere',
      }}>
        {value}
      </span>
    </div>
  )
}

/**
 * The total a filtered view is made of: the database's own sum for exactly the
 * rows listed under it, how many rows that is, and its share of the PI total.
 */
function FilteredTotal({ tone, label, amount, count, share, total }: {
  tone: 'green' | 'amber'
  label: string
  amount: string
  count: number
  share: string
  total: string
}) {
  const t = TONE_COLOR[tone]
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between',
      gap: '6px 16px', padding: '10px 12px', borderRadius: '8px',
      background: t.bg, border: `1px solid ${t.border}`,
    }}>
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <span style={{ fontSize: '11.5px', fontWeight: 600, color: t.fg }}>{label}</span>
        <span style={{
          fontSize: '20px', fontWeight: 700, color: colors.primary,
          fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere',
        }}>
          {amount}
        </span>
      </div>
      <span style={{ fontSize: '12px', color: colors.tertiary, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>
        {describePaymentCount(count)}
        {share !== '—' && ` · ${share} of ${total} PI Total`}
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

      {row.remarks && (
        <div style={{ fontSize: '12px', lineHeight: 1.45, color: colors.secondary, overflowWrap: 'anywhere' }}>
          Remarks: {row.remarks}
        </div>
      )}

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
 * already uses — or only the rows behind one of the status card's figures.
 *
 * ONE DIALOG, THREE VIEWS. All shows the same figures and bar as the page's
 * status card, then every row. Confirmed and Awaiting verification show the
 * database's total for that figure, then exactly the rows it was summed from —
 * picked by the same predicates the database sums with (filterPiPaymentRows).
 * The toggle switches between them without closing, and is held still while a
 * decision is open so a typed reason cannot scroll out of view.
 *
 * `onDecide` is null for anybody the page did not resolve as a payment verifier,
 * and then no row draws a decision control at all. A confirmed row never draws
 * one either: only a payment awaiting verification can be decided.
 */
export function PiPaymentDetailsModal({
  summary, status, loading, onOpenProof, onClose, canVerify, onDecide, ownPaymentIds, initialFilter = 'all',
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
  /** Which rows the dialog opens on. */
  initialFilter?: PiPaymentFilter
}) {
  const [filter, setFilter] = useState<PiPaymentFilter>(initialFilter)
  const [armed, setArmed] = useState<ArmedDecision | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // State updates are async; this is not. Two clicks in the same tick cannot
  // both send a decision.
  const busyRef = useRef(false)

  const decisionsAllowed = canVerify && onDecide !== null
  const allRows = summary?.payments ?? []
  const counts = countPiPaymentRows(allRows)
  const rows = filterPiPaymentRows(allRows, filter).map(row => describePiPaymentRow(row, {
    canVerify: decisionsAllowed,
    ownPayment: ownPaymentIds?.has(row.payment_id) ?? false,
  }))
  const terms = filter === 'all' ? piPaymentTermLines(summary) : []
  const filterLocked = armed !== null || busy
  const filterCount: Record<PiPaymentFilter, number> = {
    all: allRows.length,
    confirmed: counts.confirmed,
    awaiting: counts.awaiting,
  }

  const close = useCallback(() => {
    if (busyRef.current) return
    onClose()
  }, [onClose])

  const showFilter = (next: PiPaymentFilter) => {
    if (busyRef.current || armed !== null) return
    setFilter(next)
  }

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
      title={PAYMENT_FILTER_TITLE[filter]}
      onClose={close}
      width="640px"
      // A typed reason is unsaved input: a backdrop click must not discard it.
      closeOnBackdropClick={armed === null}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {summary && (
          <div role="group" aria-label="Show payments" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {PAYMENT_FILTERS.map(key => {
              const selected = filter === key
              return (
                <button
                  key={key}
                  type="button"
                  className="boe-btn boe-btn-ghost pi-detail-payfilter"
                  aria-pressed={selected}
                  disabled={filterLocked && !selected}
                  onClick={() => showFilter(key)}
                  style={selected
                    ? { background: colors.primary, borderColor: colors.primary, color: '#FFFFFF' }
                    : undefined}
                >
                  {PAYMENT_FILTER_TAB[key]}
                  <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.75 }}>{filterCount[key]}</span>
                </button>
              )
            })}
          </div>
        )}

        {status && filter === 'all' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '12px' }}>
              <Figure label="Received" value={status.received} />
              <Figure label="Confirmed" value={status.confirmed} tone="green" />
              <Figure
                label="Awaiting verification"
                value={status.pendingCount > 0 ? status.pendingAmount : '—'}
                tone={status.pendingCount > 0 ? 'amber' : undefined}
              />
              <Figure label="PI Total" value={status.total} />
            </div>
            <PiPaymentProgress
              confirmedPercent={status.barPercent}
              receivedPercent={status.receivedBarPercent}
              thresholdPercent={status.thresholdPercent}
              label={`Received: ${status.receivedPercent} of the PI total, ${status.percent} confirmed`}
            />
            <div style={{ fontSize: '11.5px', color: colors.tertiary, fontVariantNumeric: 'tabular-nums' }}>
              {status.receivedPercent} received of {status.total} · {status.percent} confirmed
            </div>
          </div>
        )}

        {status && filter === 'confirmed' && (
          <FilteredTotal
            tone="green" label="Confirmed total"
            amount={status.confirmed} count={status.confirmedCount}
            share={status.percent} total={status.total}
          />
        )}

        {status && filter === 'awaiting' && (
          <FilteredTotal
            tone="amber" label="Awaiting verification total"
            amount={status.pendingAmount} count={status.pendingCount}
            share={status.pendingPercent} total={status.total}
          />
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
            {loading ? 'Loading payments…' : PAYMENT_FILTER_EMPTY[filter]}
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
