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
import { amountInputProblem, groupIndianDigits, isValidAmount } from '@/lib/currency'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { ProofDropZone } from '@/app/finance/components/ProofDropZone'
import { PaymentIdChip } from '@/app/finance/components/PaymentIdChip'
import {
  FieldProblem,
  FormDialog,
  FormStep,
  OptionalDisclosure,
  PaymentDetailsFields,
  scrollToFirstProblem,
} from '@/app/finance/components/PaymentFormParts'
import { paymentModeLabel } from '@/lib/finance/paymentEntry'
import { WhereIsMoneyNowField } from '@/components/finance/WhereIsMoneyNowField'
import { PaymentCashLine } from '@/components/finance/PaymentCashLine'
import { isTrackedPaymentMode, moneyNowError, type MoneyNow } from '@/lib/finance/cashJourney'
import type { PaymentDecision } from '@/lib/finance/paymentDecision'
import { AvailableMoneyPanel } from '@/components/finance/AvailableMoneyPanel'
import type { AvailablePayment } from '@/lib/finance/availableMoney'
import {
  EMPTY_PI_PAYMENT_FORM,
  PI_PAYMENT_PROOF_FAILED,
  PI_PAYMENT_RECORDED_BODY,
  canSubmitPiPayment,
  countPiPaymentRows,
  describePaymentCount,
  describePiPaymentRow,
  filterPiPaymentRows,
  isAwaitingVerification,
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
  amber:   { fg: '#805B0D',    bg: colors.amberTint, border: 'rgba(196,138,26,0.28)' },
  blue:    { fg: '#335A86',    bg: colors.blueTint,  border: 'rgba(51,90,134,0.28)' },
  red:     { fg: '#B42332',    bg: colors.redTint,   border: 'rgba(180,35,50,0.28)' },
  green:   { fg: '#276247',    bg: colors.greenTint, border: 'rgba(39,98,71,0.28)' },
  neutral: { fg: colors.tertiary, bg: colors.raised, border: colors.border },
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
  confirmed: 'rgba(39,98,71,0.72)',
  awaiting: 'rgba(196,138,26,0.68)',
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
  fontSize: '12px', fontWeight: 600, color: colors.muted, marginBottom: '4px',
  textTransform: 'uppercase', letterSpacing: '0.05em',
}

export function AddPiPaymentModal({ todayIso, saving, onClose, onSubmit, recorderId = null, availableMoney }: {
  todayIso: string
  saving: boolean
  onClose: () => void
  /** handTo: for PNB, Paytm and Canara, who the recorder handed the money to (null = still with them). */
  onSubmit: (form: PiPaymentFormState, proof: File | null, handTo?: string | null) => Promise<string | null>
  /** Who is recording it (the default holder of the money). */
  recorderId?: string | null
  /**
   * Money already received from this client (20270506000000). `use` resolves to
   * an error sentence, or null once the money is on the PI (the page then closes
   * this form). Absent: the form is exactly as before.
   */
  availableMoney?: {
    search: (amount: string, paymentDate: string) => Promise<AvailablePayment[]>
    use: (paymentId: string) => Promise<string | null>
  }
}) {
  const [form, setForm] = useState<PiPaymentFormState>({ ...EMPTY_PI_PAYMENT_FORM, paymentDate: todayIso })
  const [proof, setProof] = useState<File | null>(null)
  const [proofError, setProofError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [extrasOpen, setExtrasOpen] = useState(false)
  // Where is this money now (20270413000000): for PNB, Paytm and Canara.
  const [moneyNow, setMoneyNow] = useState<MoneyNow>({ choice: 'with_me' })
  const tracked = isTrackedPaymentMode(form.paymentMode)
  const moneyNowProblem = tracked ? moneyNowError(moneyNow, recorderId) : null
  const formRef = useRef<HTMLDivElement>(null)
  // Belt and braces alongside `saving`: a second click that lands in the same
  // tick, before the parent's saving state has propagated, is still refused.
  const submittedRef = useRef(false)
  const [submitted, setSubmitted] = useState(false)

  const errors = validatePiPaymentForm(form, todayIso)
  const allowed = canSubmitPiPayment({ form, todayIso, saving, submitted })
  const busy = saving || submitted
  // An amount that cannot be accepted says why AT ONCE (AmountInput prints it
  // under the field); a missing or out-of-range one is named after Record was
  // pressed, so the same sentence is never printed twice.
  const amountMessage = amountInputProblem(form.amount) ? null : (touched ? errors.amount ?? null : null)

  const set = (k: keyof PiPaymentFormState) => (v: string) => setForm(f => ({ ...f, [k]: v }))

  // RECORD IS NEVER GREYED OUT BY AN UNFINISHED FORM. It names what is missing
  // under each field and takes the person to the first one. Only a payment
  // already on its way waits. canSubmitPiPayment still decides whether anything
  // is sent.
  const submit = async () => {
    if (submittedRef.current || saving) return
    if (!allowed || moneyNowProblem) {
      setTouched(true)
      scrollToFirstProblem(formRef.current)
      return
    }
    submittedRef.current = true
    setSubmitted(true)
    setError(null)
    const err = await onSubmit(form, proof, tracked && moneyNow.choice === 'handed_to' ? moneyNow.recipientId : null)
    if (err) {
      // A failure returns the form to the user with what they typed intact.
      submittedRef.current = false
      setSubmitted(false)
      setError(err)
    }
  }

  const summary = [
    isValidAmount(form.amount) ? `₹${groupIndianDigits(form.amount)}` : null,
    form.paymentMode ? paymentModeLabel(form.paymentMode) : null,
  ].filter(Boolean).join(' · ')

  const extrasAdded = !!(form.reference.trim() || form.remarks.trim() || proof)

  return (
    <FormDialog
      title="Add payment"
      onClose={onClose}
      closeDisabled={busy}
      closeOnEscape
      width="520px"
      summary={summary}
      actions={
        <>
          <button type="button" onClick={onClose} disabled={busy}
            className="boe-btn boe-btn-ghost" style={{ padding: '7px 16px', fontSize: '13px' }}>
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={busy}
            className="boe-btn boe-btn-primary" style={{ padding: '7px 16px', fontSize: '13px' }}>
            {busy ? 'Recording…' : 'Record payment'}
          </button>
        </>
      }
    >
      <div ref={formRef} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <FormStep number={1} title="Payment">
          <PaymentDetailsFields
            amount={form.amount}
            onAmount={set('amount')}
            date={form.paymentDate}
            onDate={set('paymentDate')}
            mode={form.paymentMode}
            onMode={set('paymentMode')}
            disabled={busy}
            amountLabel="Amount received"
            amountProblem={amountMessage}
            dateProblem={touched ? errors.paymentDate ?? null : null}
            modeHintId="pi-payment-mode-hint"
          />
          <FieldProblem message={touched ? errors.paymentMode ?? null : null} />
        </FormStep>

        {availableMoney && (
          <AvailableMoneyPanel
            amount={form.amount}
            paymentDate={form.paymentDate}
            search={availableMoney.search}
            onUse={availableMoney.use}
            disabled={busy}
          />
        )}

        {tracked && (
          <FormStep number={2} title="Where is this money now?">
            <WhereIsMoneyNowField
              paymentMode={form.paymentMode}
              value={moneyNow}
              onChange={setMoneyNow}
              recorderId={recorderId}
              problem={touched ? moneyNowProblem : null}
            />
          </FormStep>
        )}

        <OptionalDisclosure
          title="Add reference, remarks or proof"
          hint={extrasAdded ? 'Added' : 'Optional'}
          open={extrasOpen}
          onToggle={() => setExtrasOpen(o => !o)}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <div style={LABEL}>Reference / UTR</div>
              <input className="boe-input" style={{ width: '100%' }} value={form.reference}
                onChange={e => set('reference')(e.target.value)} />
            </div>
            <div>
              <div style={LABEL}>Remarks</div>
              <input className="boe-input" style={{ width: '100%' }} value={form.remarks}
                onChange={e => set('remarks')(e.target.value)} />
            </div>
            <div>
              <div style={LABEL}>Payment proof</div>
              <ProofDropZone
                file={proof}
                error={proofError}
                onFile={setProof}
                onError={setProofError}
                disabled={busy}
              />
            </div>
          </div>
        </OptionalDisclosure>

        {error && (
          <div role="alert" style={{
            fontSize: '12px', color: colors.red, background: colors.redTint,
            border: '1px solid rgba(180,35,50,0.2)', borderRadius: '6px', padding: '8px 10px',
          }}>
            {error}
          </div>
        )}

        <div style={{
          fontSize: '12px', color: colors.muted, background: colors.raised,
          border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '8px 10px',
        }}>
          This records that a payment was received. Finance verifies it separately —
          nothing counts as confirmed until they do.
        </div>
      </div>
    </FormDialog>
  )
}

// ── Payment details ───────────────────────────────────────────────────────────

export const PAYMENT_DETAILS_TITLE = 'Payment details'
export const APPROVE_PAYMENT_LABEL = 'Approve'
export const REJECT_PAYMENT_LABEL = 'Reject'
export const EDIT_PAYMENT_LABEL = 'Edit'

/**
 * THE TABLE'S COLUMNS, left to right (owner, 2026-10-30): the date and the mode
 * lead because they are what a reader checks first; the amount is right-aligned
 * so the figures line up. A narrow screen draws each row as a card instead, from
 * the same markup (globals.css, .pi-pay-table).
 */
export const PAYMENT_TABLE_COLUMNS = ['Date', 'Mode', 'Amount', 'Payment ID', 'Recorded by', 'Verification', 'Actions'] as const

/** The Details control, named for the payment it opens or closes. */
export const paymentDetailsToggleLabel = (open: boolean, humanPaymentId: string): string =>
  `${open ? 'Hide' : 'Show'} details of ${humanPaymentId}`

/** Said inside Details when the payment came with no reference, remarks or proof. */
export const PAYMENT_DETAILS_NOTHING_ADDED = 'No reference, remarks or proof were added with this payment.'

/**
 * The dialog's three views, each titled for what it holds. Payment details is
 * every row recorded against the PI; the other two are exactly the rows behind
 * the status card's Confirmed and Awaiting verification figures.
 */
export const PAYMENT_FILTER_TITLE: Record<PiPaymentFilter, string> = {
  all: PAYMENT_DETAILS_TITLE,
  confirmed: 'Verified payments',
  awaiting: 'Payments waiting for Finance',
}

export const PAYMENT_FILTER_TAB: Record<PiPaymentFilter, string> = {
  all: 'All',
  confirmed: 'Verified',
  awaiting: 'Waiting for Finance',
}

const PAYMENT_FILTER_EMPTY: Record<PiPaymentFilter, string> = {
  all: 'No payment has been recorded against this PI yet.',
  confirmed: 'No payment against this PI has been verified yet.',
  awaiting: 'No payment against this PI is waiting for Finance.',
}

const PAYMENT_FILTERS: readonly PiPaymentFilter[] = ['all', 'confirmed', 'awaiting']

/** The decision a verifier has started on one row, before confirming it. */
type ArmedDecision = { paymentId: string; humanPaymentId: string; decision: PaymentDecision }

const SMALL_BUTTON: React.CSSProperties = {
  padding: '5px 11px', fontSize: '12px', fontWeight: 600, borderRadius: '6px', cursor: 'pointer',
  whiteSpace: 'nowrap',
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: 'amber' | 'green' }) {
  return (
    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <span style={{ fontSize: '12px', color: colors.muted }}>{label}</span>
      <span style={{
        fontSize: '16px', fontWeight: 700, fontVariantNumeric: 'tabular-nums',
        color: tone === 'amber' ? '#805B0D' : tone === 'green' ? '#276247' : colors.primary,
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
        <span style={{ fontSize: '12px', fontWeight: 600, color: t.fg }}>{label}</span>
        <span style={{
          fontSize: '20px', fontWeight: 700, color: colors.primary,
          fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere',
        }}>
          {amount}
        </span>
      </div>
      <span style={{ fontSize: '12px', color: colors.tertiary, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>
        {describePaymentCount(count)}
        {share !== '—' && ` · ${share} of ${total} Total before GST`}
      </span>
    </div>
  )
}

/** A payment's state as a pill: the shared word (paymentWords.ts), in its colour. */
function PaymentStatusPill({ label, tone }: { label: string; tone: PiPaymentTone }) {
  return (
    <span className={`pi-pay-pill pi-pay-pill--${tone}`}>
      <span className="pi-pay-pill-dot" aria-hidden="true" />
      {label}
    </span>
  )
}

// The date and mode chips carry an icon on a phone card; a wide table hides it
// (globals.css) and prints the plain words.
function CalendarIcon() {
  return (
    <svg className="pi-pay-chip-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  )
}

function BankIcon() {
  return (
    <svg className="pi-pay-chip-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10l9-6 9 6" />
      <path d="M5 10v9M9.5 10v9M14.5 10v9M19 10v9M3 21h18" />
    </svg>
  )
}

function ProofIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  )
}

function ChevronIcon({ up }: { up: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={up ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
    </svg>
  )
}

/**
 * One payment against this PI, as a table row: when, how, how much, who
 * recorded it and who verified it — with Approve and Reject only where this
 * viewer may decide it, and Details under the row once it is opened.
 *
 * A FRAGMENT OF ROWS. The payment's own row, then the decision being confirmed,
 * then Details, each a full-width row of its own so the columns above stay
 * aligned. On a narrow screen the CSS draws the row as a card and the two extra
 * rows as its continuation (globals.css, .pi-pay-table).
 */
export function PiPaymentRow({
  row, armed, note, busy, error, open = false, onToggle, activity = null,
  onOpenProof, onArm, onNote, onCancel, onConfirm, onEdit,
}: {
  row: PiPaymentRowView
  /** The decision started on THIS row, or null. */
  armed: PaymentDecision | null
  note: string
  busy: boolean
  error: string | null
  /** Whether this row's Details are showing. */
  open?: boolean
  /** Opens or closes Details. Absent: the row has nothing more to show and draws no control. */
  onToggle?: () => void
  /**
   * The payment's history, drawn inside Details. The page supplies it, and only
   * to a reader with Finance access; this file reads nothing itself.
   */
  activity?: React.ReactNode
  onOpenProof: (paymentId: string) => void
  onArm: (decision: PaymentDecision) => void
  onNote: (value: string) => void
  onCancel: () => void
  onConfirm: () => void
  /** Opens the correction form for this payment; drawn only where row.canEdit. */
  onEdit?: () => void
}) {
  const noteId = `pi-payment-note-${row.key}`
  const detailsId = `pi-payment-details-${row.key}`
  const reasonMissing = armed === 'reject' && note.trim() === ''
  const showDetails = open && Boolean(onToggle)
  const pill = <PaymentStatusPill label={row.statusLabel} tone={row.statusTone} />
  const rowClass = ['pi-pay-row', showDetails ? 'is-open' : '', row.reversed ? 'is-reversed' : '']
    .filter(Boolean).join(' ')
  const nothingAdded = !row.reference && !row.remarks && !row.canOpenProof
  return (
    <>
      <tr className={rowClass}>
        <td className="pi-pay-cell pi-pay-date">
          <span className="pi-pay-chip"><CalendarIcon />{row.date}</span>
        </td>
        <td className="pi-pay-cell pi-pay-mode">
          <span className="pi-pay-chip"><BankIcon />{row.mode}</span>
          {row.tracksCash && <div className="pi-pay-cash"><PaymentCashLine paymentId={row.paymentId} /></div>}
        </td>
        <td className="pi-pay-cell pi-pay-amount">
          <span className="pi-pay-amount-value">{row.amount}</span>
          {/* The state sits beside the amount on a phone card; on a wide
              screen the Verification column carries it instead. */}
          <span className="pi-pay-status-narrow">{pill}</span>
          {row.paymentAmount && <span className="pi-pay-sub">Part of a {row.paymentAmount} payment</span>}
          {row.reversed && <span className="pi-pay-sub">Allocation reversed</span>}
        </td>
        <td className="pi-pay-cell pi-pay-id">
          <span className="pi-pay-cell-label">Payment ID</span>
          <PaymentIdChip>{row.humanPaymentId}</PaymentIdChip>
        </td>
        <td className="pi-pay-cell pi-pay-recorded">
          <span className="pi-pay-cell-label">Recorded by</span>
          <span className="pi-pay-person">{row.recordedBy ?? '—'}</span>
          {row.recordedAt && <span className="pi-pay-sub">{row.recordedAt}</span>}
        </td>
        <td className="pi-pay-cell pi-pay-verification">
          <span className="pi-pay-cell-label">{row.status === 'rejected' ? 'Rejected' : 'Verified by'}</span>
          <span className="pi-pay-status-wide">{pill}</span>
          {row.verifiedBy && <span className="pi-pay-person pi-pay-person--verified">{row.verifiedBy}</span>}
          {row.verifiedAt && <span className="pi-pay-sub">{row.verifiedAt}</span>}
          {row.rejectedAt && <span className="pi-pay-sub">{row.rejectedAt}</span>}
          {!row.reversed && isAwaitingVerification(row.status) && <span className="pi-pay-sub">Not verified yet</span>}
          {row.note && (
            <span className={row.note.rejected ? 'pi-pay-note is-rejected' : 'pi-pay-note'}>
              {row.note.heading}: {row.note.text}
            </span>
          )}
          {row.ownPending && <span className="pi-pay-sub pi-pay-own">{OWN_PAYMENT_DECISION_NOTE}</span>}
        </td>
        <td className="pi-pay-cell pi-pay-actions-cell">
          <div className="pi-pay-actions">
            {row.canDecide && armed === null && (
              <>
                <button
                  type="button"
                  className="pi-pay-btn"
                  onClick={() => onArm('approve')}
                  disabled={busy}
                  style={{ ...SMALL_BUTTON, border: 'none', background: '#276247', color: '#fff' }}
                >
                  {APPROVE_PAYMENT_LABEL}
                </button>
                <button
                  type="button"
                  className="pi-pay-btn"
                  onClick={() => onArm('reject')}
                  disabled={busy}
                  style={{ ...SMALL_BUTTON, border: '1px solid rgba(180,35,50,0.35)', background: colors.base, color: colors.red }}
                >
                  {REJECT_PAYMENT_LABEL}
                </button>
              </>
            )}
            {row.canEdit && onEdit && armed === null && (
              <button
                type="button"
                className="pi-pay-btn"
                onClick={onEdit}
                disabled={busy}
                style={{ ...SMALL_BUTTON, border: `1px solid ${colors.borderSoft}`, background: colors.base, color: colors.secondary }}
              >
                {EDIT_PAYMENT_LABEL}
              </button>
            )}
            {onToggle && (
              <button
                type="button"
                className="pi-pay-btn pi-pay-toggle"
                onClick={onToggle}
                disabled={busy}
                aria-expanded={showDetails}
                aria-controls={showDetails ? detailsId : undefined}
                aria-label={paymentDetailsToggleLabel(showDetails, row.humanPaymentId)}
                title={showDetails ? 'Hide details' : 'Show details'}
              >
                <ChevronIcon up={showDetails} />
              </button>
            )}
          </div>
        </td>
      </tr>

      {row.canDecide && armed !== null && (
        <tr className="pi-pay-extra">
          <td colSpan={PAYMENT_TABLE_COLUMNS.length}>
            <div style={{
              padding: '10px 12px', borderRadius: '8px',
              background: colors.raised, border: `1px solid ${colors.border}`,
              display: 'flex', flexDirection: 'column', gap: '8px',
            }}>
              <label htmlFor={noteId} style={{ fontSize: '12px', fontWeight: 600, color: colors.secondary }}>
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
                <div role="alert" style={{ fontSize: '12px', color: '#B42332' }}>{error}</div>
              )}
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="pi-pay-btn"
                  onClick={onCancel}
                  disabled={busy}
                  style={{ ...SMALL_BUTTON, border: `1px solid ${colors.borderSoft}`, background: colors.base, color: colors.secondary }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="pi-pay-btn"
                  onClick={onConfirm}
                  disabled={busy || reasonMissing}
                  style={{
                    ...SMALL_BUTTON, border: 'none', color: '#fff',
                    background: armed === 'reject' ? colors.red : '#276247',
                    opacity: busy || reasonMissing ? 0.6 : 1,
                  }}
                >
                  {busy
                    ? (armed === 'reject' ? 'Rejecting…' : 'Approving…')
                    : (armed === 'reject' ? 'Confirm rejection' : 'Confirm approval')}
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}

      {showDetails && (
        <tr className="pi-pay-extra" id={detailsId}>
          <td colSpan={PAYMENT_TABLE_COLUMNS.length}>
            <div className="pi-pay-details">
              <div className="pi-pay-details-col">
                {row.reference && (
                  <div>
                    <div className="pi-pay-details-head">Reference / UTR</div>
                    <div className="pi-pay-details-value">{row.reference}</div>
                  </div>
                )}
                {row.remarks && (
                  <div>
                    <div className="pi-pay-details-head">Remarks</div>
                    <div className="pi-pay-details-text">{row.remarks}</div>
                  </div>
                )}
                {row.canOpenProof && (
                  <div>
                    <div className="pi-pay-details-head">Proof</div>
                    <button
                      type="button"
                      className="pi-pay-proof"
                      onClick={() => onOpenProof(row.paymentId)}
                      disabled={busy}
                    >
                      <ProofIcon />
                      View proof
                    </button>
                  </div>
                )}
                {nothingAdded && <div className="pi-pay-details-text">{PAYMENT_DETAILS_NOTHING_ADDED}</div>}
              </div>
              {activity && <div className="pi-pay-details-col pi-pay-details-activity">{activity}</div>}
            </div>
          </td>
        </tr>
      )}
    </>
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
  summary, status, loading, onOpenProof, onClose, canVerify, onDecide, ownPaymentIds, onEdit, initialFilter = 'all',
  paymentActivity = null,
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
  /**
   * Opens the correction form for one payment still with Finance. Null for
   * anybody the page did not resolve as able to correct it: then no row draws
   * Edit. Teams record the wrong amount or date; this is where it is fixed.
   */
  onEdit?: ((paymentId: string) => void) | null
  /** Which rows the dialog opens on. */
  initialFilter?: PiPaymentFilter
  /**
   * Finance's history of one payment, for its Details. The page passes it only
   * to a reader with Finance access (the Order page's rule for View details);
   * null for everybody else, whose Details show what the summary already holds.
   * Called only for a row whose Details are open, so nothing is read before.
   */
  paymentActivity?: ((paymentId: string) => React.ReactNode) | null
}) {
  const [filter, setFilter] = useState<PiPaymentFilter>(initialFilter)
  // Which rows have Details open, by allocation. Any number at once.
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set())
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
    canEdit: Boolean(onEdit),
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

  const toggleDetails = (key: string) => {
    if (busyRef.current) return
    setOpenKeys(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const arm = (row: PiPaymentRowView, decision: PaymentDecision) => {
    if (busyRef.current) return
    setArmed({ paymentId: row.paymentId, humanPaymentId: row.humanPaymentId, decision })
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
      setNotice(`${armed.humanPaymentId} ${armed.decision === 'approve' ? 'approved' : 'rejected'}. Payment status updated.`)
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
      // Wide enough for the table's seven columns; FinanceModal caps it at the
      // window, and a phone draws the rows as cards.
      width="1160px"
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
                    ? { background: colors.brand, borderColor: colors.primary, color: '#FFFFFF' }
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
              <Figure label="Verified" value={status.confirmed} tone="green" />
              <Figure
                label="Waiting for Finance"
                value={status.pendingCount > 0 ? status.pendingAmount : '—'}
                tone={status.pendingCount > 0 ? 'amber' : undefined}
              />
              <Figure label="Total before GST" value={status.total} />
            </div>
            <PiPaymentProgress
              confirmedPercent={status.barPercent}
              receivedPercent={status.receivedBarPercent}
              thresholdPercent={status.thresholdPercent}
              label={`Received: ${status.receivedPercent} of the Total before GST, ${status.percent} verified`}
            />
            <div style={{ fontSize: '12px', color: colors.tertiary, fontVariantNumeric: 'tabular-nums' }}>
              {status.receivedPercent} received of {status.total} · {status.percent} confirmed
            </div>
          </div>
        )}

        {status && filter === 'confirmed' && (
          <FilteredTotal
            tone="green" label="Verified total"
            amount={status.confirmed} count={status.confirmedCount}
            share={status.percent} total={status.total}
          />
        )}

        {status && filter === 'awaiting' && (
          <FilteredTotal
            tone="amber" label="Waiting for Finance total"
            amount={status.pendingAmount} count={status.pendingCount}
            share={status.pendingPercent} total={status.total}
          />
        )}

        {notice && (
          <div role="status" style={{
            fontSize: '12px', color: '#276247', background: colors.greenTint,
            border: '1px solid rgba(39,98,71,0.25)', borderRadius: '6px', padding: '8px 10px',
          }}>
            {notice}
          </div>
        )}

        {rows.length === 0 ? (
          <div style={{ padding: '14px 0 4px', fontSize: '12px', color: colors.secondary, borderTop: `1px solid ${colors.border}` }}>
            {loading ? 'Loading payments…' : PAYMENT_FILTER_EMPTY[filter]}
          </div>
        ) : (
          <div className="pi-pay-table-wrap">
            <table className="pi-pay-table">
              <thead>
                <tr>
                  {PAYMENT_TABLE_COLUMNS.map(column => (
                    <th
                      key={column}
                      scope="col"
                      className={column === 'Amount' ? 'pi-pay-th-amount' : column === 'Actions' ? 'pi-pay-th-actions' : undefined}
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const mine = armed !== null && armed.paymentId === row.paymentId
                  const open = openKeys.has(row.key)
                  // DETAILS ONLY WHERE THERE IS SOMETHING MORE TO SHOW: the
                  // reference, the remarks, the proof, or — for a reader with
                  // Finance access — the payment's history.
                  const hasDetails = Boolean(row.reference || row.remarks || row.canOpenProof || paymentActivity)
                  return (
                    <PiPaymentRow
                      key={row.key}
                      row={row}
                      armed={mine ? armed.decision : null}
                      note={mine ? note : ''}
                      busy={busy}
                      error={mine ? error : null}
                      open={open}
                      onToggle={hasDetails ? () => toggleDetails(row.key) : undefined}
                      activity={open && paymentActivity ? paymentActivity(row.paymentId) : null}
                      onOpenProof={onOpenProof}
                      onArm={decision => arm(row, decision)}
                      onNote={setNote}
                      onCancel={() => { if (!busyRef.current) { setArmed(null); setError(null) } }}
                      onConfirm={() => { void confirm() }}
                      onEdit={onEdit ? () => onEdit(row.paymentId) : undefined}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* The agreed commercial terms, when there are any. Plain text, printed
            as typed: this is not a schedule and nothing here parses it. */}
        {terms.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', paddingTop: '10px', borderTop: `1px solid ${colors.border}` }}>
            {terms.map(t => (
              <div key={t.key} style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
                <div style={{ fontSize: '12px', color: colors.muted }}>{t.label}</div>
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
