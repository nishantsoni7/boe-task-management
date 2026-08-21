'use client'

// The decisions taken on a saved PI, as dialogs.
//
//   PiSubmitConfirmModal   the employee hands their PI to management, with its
//                          live verified-payment position on screen
//   PiNoteModal            management sends it back, ends it, or refuses a
//                          proposed advance
//   PiFinanceVerifyModal   a finance authority signs off the commercial figures
//                          and the advance terms — and confirms, in as many
//                          words, that no payment is being recorded
//   PiApproveOrderModal    management approves the PI and the Order is created,
//                          with an official number, finally
//   PiDeleteConfirmModal   the owner or an administrator erases a PI that should
//                          not exist, permanently
//
// ONE SHELL, TWO DIALOGS. Needs Changes and Reject differ in exactly three
// things — the heading, the tone of the warning, and which RPC the caller runs —
// and everything else about them is identical: a mandatory note, a trimmed
// value, a disabled confirm while it is blank, an in-flight state that cannot be
// double-submitted, and an error that keeps the typed words on screen. Two
// components would be two places for those five rules to drift.
//
// THE BOE FORM-MODAL DISMISSAL RULE APPLIES. A backdrop click does nothing at
// all — somebody may have spent minutes writing a rejection reason — and the
// only ways out are Cancel, the × control, Escape, or a successful write. The
// rule is not re-decided here: shouldCloseFormModal owns it.
//
// NOTHING HERE DECIDES AUTHORITY. These are dialogs; the RPCs behind them
// re-derive the actor, the permission and the record's state in the database.

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Send, ShieldCheck, Trash2, X } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { MultilineText } from '@/components/ui/MultilineText'
import { useScrollLock } from '@/hooks/useScrollLock'
import {
  FOCUSABLE_SELECTOR,
  resolveTrapTarget,
  shouldCloseFormModal,
  type ModalDismissReason,
} from '@/lib/ui/modalDismissal'
import {
  NOT_PROVIDED,
  type ClientDetails,
} from '@/app/orders/drafts/[submissionId]/piDetailView'
import {
  SUBMIT_BUTTON_LABEL,
  SUBMIT_CONFIRM_NOTE,
  REJECT_BUTTON_LABEL,
  REQUEST_CHANGES_BUTTON_LABEL,
  RESUBMIT_NOTE_LABEL,
  RESUBMIT_NOTE_PLACEHOLDER,
  RESUBMIT_NOTE_MAX_LENGTH,
  validateResubmitReply,
} from '@/lib/orders/submissionWorkflow'
import {
  APPROVE_ORDER_BUSY_LABEL,
  APPROVE_ORDER_CONFIRM_LABEL,
  APPROVE_ORDER_DIALOG_TITLE,
  APPROVE_ORDER_FINAL_NOTE,
  APPROVE_ORDER_NOT_A_PAYMENT,
  VERIFY_FINANCE_BUSY_LABEL,
  VERIFY_FINANCE_BUTTON_LABEL,
  VERIFY_FINANCE_CONFIRM,
  VERIFY_FINANCE_DIALOG_TITLE,
  VERIFY_FINANCE_NOT_A_PAYMENT,
} from '@/lib/orders/finalApproval'
import type { ApprovalSummaryRow } from '@/app/orders/drafts/[submissionId]/piDetailView'
import {
  DELETE_PI_BUSY_LABEL,
  DELETE_PI_CANCEL_LABEL,
  DELETE_PI_CONFIRM_LABEL,
  DELETE_PI_DIALOG_TITLE,
  DELETE_PI_WARNING,
  deletionStatusLabel,
} from '@/lib/orders/submissionDeletion'
import {
  REJECT_EXCEPTION_BUTTON_LABEL,
  REJECT_EXCEPTION_REASON_LABEL,
} from '@/lib/orders/advanceRequirement'
import {
  BILLING_TERMS_LABEL,
  BILLING_TERMS_PLACEHOLDER,
  EMPTY_SUBMISSION_TERMS,
  PAYMENT_POSITION_HINT,
  PAYMENT_POSITION_LABEL,
  PAYMENT_REASON_LABEL,
  PAYMENT_REASON_MAX_LENGTH,
  PAYMENT_REASON_PLACEHOLDER,
  PAYMENT_STANDARD_PERCENT,
  PAYMENT_TERMS_LABEL,
  PAYMENT_TERMS_MAX_LENGTH,
  PAYMENT_TERMS_OPTIONAL_LABEL,
  PAYMENT_TERMS_PLACEHOLDER,
  PAYMENT_NOT_A_DECLARATION,
  PAYMENT_POSITION_UNKNOWN,
  PAYMENT_UNVERIFIED_DOES_NOT_COUNT,
  asPaymentPosition,
  paymentPositionLines,
  submissionTermsUntouched,
  validateSubmissionTerms,
  type PiSubmissionTerms,
} from '@/lib/orders/paymentGate'
import {
  formatMoney,
  formatPercent,
  type PiPaymentSummary,
} from '@/lib/finance/piPaymentView'

// ── Shared furniture ──────────────────────────────────────────────────────────

const OVERLAY: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1000,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: '16px',
}

const PANEL: React.CSSProperties = {
  background: colors.base,
  border: `1px solid ${colors.border}`,
  borderRadius: '12px',
  width: '100%', maxWidth: '460px',
  maxHeight: 'calc(100vh - 32px)',
  overflowY: 'auto',
  boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
}

const KEY_STYLE: React.CSSProperties = {
  color: colors.muted, fontSize: '11px', fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
}

/** Escape closes, and only while nothing is in flight. Every other dismissal
 *  reason is answered by shouldCloseFormModal at the call site. */
function useEscapeDismiss(onDismiss: (reason: ModalDismissReason) => void, enabled: boolean) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && enabled) onDismiss('escape') }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss, enabled])
}

function ModalHeader({ title, subtitle, onClose, disabled }: {
  title: string
  subtitle: string
  onClose: () => void
  disabled: boolean
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
      padding: '16px 20px', borderBottom: `1px solid ${colors.border}`,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>{title}</div>
        <div style={{
          fontSize: '12px', color: colors.muted, marginTop: '2px',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {subtitle}
        </div>
      </div>
      <button
        onClick={onClose}
        disabled={disabled}
        aria-label="Close"
        style={{
          background: 'none', border: 'none', display: 'flex', flexShrink: 0,
          cursor: disabled ? 'not-allowed' : 'pointer', color: colors.muted,
        }}
      >
        <X size={16} />
      </button>
    </div>
  )
}

function FailureNote({ message }: { message: string }) {
  return (
    <div style={{
      fontSize: '12px', color: colors.primary, lineHeight: 1.5,
      background: colors.redTint, border: '1px solid rgba(217,79,79,0.25)',
      borderRadius: '6px', padding: '9px 12px',
    }}>
      {message}
    </div>
  )
}

function Footer({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px', flexWrap: 'wrap' }}>
      {children}
    </div>
  )
}

const cancelStyle = (busy: boolean): React.CSSProperties => ({
  padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
  background: 'transparent', border: `1px solid ${colors.border}`, color: colors.secondary,
  cursor: busy ? 'not-allowed' : 'pointer',
})

const confirmStyle = (background: string, disabled: boolean): React.CSSProperties => ({
  padding: '8px 18px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
  background, border: 'none', color: '#fff',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
})

// ── The live payment position ─────────────────────────────────────────────────

/**
 * What has actually been received against this PI, and what that means for
 * approval.
 *
 * WHY THIS REPLACED THE ADVANCE SELECTOR. The dialog used to ask the employee to
 * DECLARE an advance — "40% or above", "Reduced", "No advance" — and that
 * declaration then decided whether an Order could be numbered. It was a promise
 * standing in for a fact, because until Payment Phases 1 and 2 there was no way
 * to hold the fact. There is now, so the question stops being asked: the screen
 * STATES the position instead, and the employee is only asked for the two things
 * the business genuinely does not know — why an Order should be confirmed below
 * the requirement, and how the rest will be collected.
 *
 * EVERY FIGURE IS THE DATABASE'S. pi_submission_payment_summary() computes them
 * in numeric, including the percentage and the shortfall; this formats them and
 * formats nothing else. There is no arithmetic in this file.
 *
 * UNVERIFIED MONEY IS SHOWN AND SAID NOT TO COUNT, in as many words. Somebody
 * who entered a payment this morning and sees "₹4,00,000 still needed" beside
 * their own ₹4,00,000 would reasonably conclude the system lost it. It did not;
 * Finance has not decided it yet, and that is a different sentence.
 */
function PaymentPositionPanel({
  summary,
  terms,
  meetsStandard,
  disabled,
  invalid,
  onTerms,
}: {
  summary: PiPaymentSummary | null
  terms: PiSubmissionTerms
  /** Null when the position could not be read at all — the dialog fails closed. */
  meetsStandard: boolean | null
  disabled: boolean
  /** The validation message, or null while the fields are still usable. */
  invalid: string | null
  onTerms: (key: keyof PiSubmissionTerms, value: string) => void
}) {
  const position = asPaymentPosition(summary?.approval_position)
  const lines = summary === null ? [] : paymentPositionLines({
    grandTotal:        summary.grand_total,
    verifiedAmount:    summary.verified_amount,
    verifiedPercent:   summary.verified_percent,
    unverifiedAmount:  summary.unverified_amount,
    neededForStandard: summary.needed_for_standard,
    formatFigure:      formatMoney,
    formatPercentage:  formatPercent,
  })

  const field = (
    key: keyof PiSubmissionTerms,
    label: string,
    placeholder: string,
    maxLength: number,
    rows: number,
  ) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', ...KEY_STYLE }}>
      {label}
      <textarea
        value={terms[key]}
        onChange={e => onTerms(key, e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows}
        maxLength={maxLength}
        aria-label={label}
        style={{
          padding: '7px 10px', borderRadius: '6px',
          border: `1px solid ${colors.border}`,
          background: colors.base, color: colors.primary,
          fontSize: '13px', width: '100%', boxSizing: 'border-box',
          outline: 'none', minHeight: rows > 1 ? '58px' : '36px', resize: 'vertical',
          fontFamily: 'inherit', textTransform: 'none', letterSpacing: 0, fontWeight: 400,
        }}
      />
    </label>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={KEY_STYLE}>Payment position</div>

      {summary === null ? (
        <div style={{
          fontSize: '12px', color: '#991B1B', lineHeight: 1.45,
          background: colors.redTint, border: '1px solid rgba(217,79,79,0.25)',
          borderRadius: '7px', padding: '9px 11px',
        }} role="alert">
          {PAYMENT_POSITION_UNKNOWN}
        </div>
      ) : (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: '5px',
          padding: '10px 11px', borderRadius: '7px',
          border: `1px solid ${colors.border}`, background: colors.raised,
        }}>
          {lines.map(line => (
            <span
              key={line.key}
              style={{ ...KEY_STYLE, display: 'flex', justifyContent: 'space-between', gap: '10px' }}
            >
              {line.label}
              <span style={{
                color: colors.primary, fontWeight: 700, fontSize: '12.5px',
                textTransform: 'none', letterSpacing: 0, fontVariantNumeric: 'tabular-nums',
              }}>
                {line.value}
              </span>
            </span>
          ))}
        </div>
      )}

      {/* THE POSITION, NAMED. Green when the requirement is met and no approval
          to proceed below is needed; amber when it is, because that is a request
          somebody must answer before an Order number exists. */}
      {meetsStandard !== null && (
        <div style={{
          fontSize: '12px', lineHeight: 1.45,
          background: meetsStandard ? colors.greenTint : colors.amberTint,
          border: `1px solid ${meetsStandard ? 'rgba(69,168,112,0.3)' : 'rgba(232,160,48,0.3)'}`,
          color: meetsStandard ? '#166534' : '#9A6212',
          borderRadius: '7px', padding: '9px 11px',
        }}>
          <strong>
            {meetsStandard
              ? PAYMENT_POSITION_LABEL.standard_met
              : `Admin approval required to proceed below ${PAYMENT_STANDARD_PERCENT}%`}
          </strong>
          <span style={{ display: 'block', marginTop: '2px' }}>
            {position !== null && !meetsStandard
              ? PAYMENT_POSITION_HINT[position]
              : meetsStandard
                ? PAYMENT_POSITION_HINT.standard_met
                : PAYMENT_UNVERIFIED_DOES_NOT_COUNT}
          </span>
        </div>
      )}

      {/* Below the requirement the two fields are MANDATORY and marked so. The
          reason is what management is being asked to accept; the terms are how
          the rest of the money is expected to arrive, and a request to start
          early without them is a request nobody can weigh. */}
      {meetsStandard === false && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: '9px',
          padding: '10px 11px', borderRadius: '7px',
          border: `1px solid ${colors.border}`, background: colors.raised,
        }}>
          {field('reason', PAYMENT_REASON_LABEL, PAYMENT_REASON_PLACEHOLDER, PAYMENT_REASON_MAX_LENGTH, 3)}
          {field('paymentTerms', PAYMENT_TERMS_LABEL, PAYMENT_TERMS_PLACEHOLDER, PAYMENT_TERMS_MAX_LENGTH, 2)}
          {field('billingTerms', BILLING_TERMS_LABEL, BILLING_TERMS_PLACEHOLDER, PAYMENT_TERMS_MAX_LENGTH, 2)}
        </div>
      )}

      {/* At or above the requirement the terms are still OFFERED — a salesperson
          who has agreed them has recorded a real commercial fact — but nothing is
          required and no reason is asked for. */}
      {meetsStandard === true && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: '9px',
          padding: '10px 11px', borderRadius: '7px',
          border: `1px solid ${colors.border}`, background: colors.raised,
        }}>
          {field('paymentTerms', PAYMENT_TERMS_OPTIONAL_LABEL, PAYMENT_TERMS_PLACEHOLDER, PAYMENT_TERMS_MAX_LENGTH, 2)}
          {field('billingTerms', BILLING_TERMS_LABEL, BILLING_TERMS_PLACEHOLDER, PAYMENT_TERMS_MAX_LENGTH, 2)}
        </div>
      )}

      {invalid && (
        <div style={{ fontSize: '11.5px', color: colors.red, lineHeight: 1.45 }} role="alert">
          {invalid}
        </div>
      )}

      <div style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.45 }}>
        {PAYMENT_NOT_A_DECLARATION}
      </div>
    </div>
  )
}

// ── Submit for Approval ───────────────────────────────────────────────────────

/**
 * The confirmation before a PI leaves the employee's hands.
 *
 * IT SHOWS WHAT IS BEING HANDED OVER AND UNDER WHAT CONDITION: who the order is
 * for, what it is worth, which advance requirement it carries, and that
 * submitting makes the record read-only. The full document is on the page behind
 * this dialog — restating the product table inside a confirmation would be
 * asking somebody to re-read what they have just read, in a smaller box.
 *
 * The formatted figure is passed in, so the money on this dialog is the money on
 * the page: one formatter, one rendering. The NUMBER is passed alongside it,
 * because the advance is derived from it and re-parsing a formatted string to
 * get it back would be inventing a second source.
 */
export function PiSubmitConfirmModal({
  client,
  grandTotal,
  payment,
  initialTerms,
  submitting,
  failure,
  offerReply,
  onCancel,
  onConfirm,
}: {
  client: string
  grandTotal: string
  /**
   * The PI's live payment position, exactly as pi_submission_payment_summary()
   * returned it — or null when it could not be read.
   *
   * A NULL FAILS THE DIALOG CLOSED. Which fields are mandatory depends on
   * whether the requirement is met, and that is precisely what is unknown; a
   * dialog that guessed would either demand a reason nobody owes or omit one the
   * database will refuse. So Submit stays disabled with the reason on screen.
   */
  payment: PiPaymentSummary | null
  /**
   * The commercial terms the record already carries, so a resubmission does not
   * silently drop what was agreed the first time.
   */
  initialTerms: PiSubmissionTerms
  submitting: boolean
  failure: string | null
  /**
   * Whether to offer the optional reply — true only on a RESUBMISSION.
   *
   * A first submission from draft has no reviewer question to answer, so the
   * field would be clutter on the commonest path through this screen.
   */
  offerReply: boolean
  onCancel: () => void
  /** The trimmed reply (null when there is none) and the validated terms. */
  onConfirm: (
    note: string | null,
    terms: { reason: string | null; paymentTerms: string | null; billingTerms: string | null },
  ) => void
}) {
  /**
   * THE TYPED REPLY AND THE TYPED TERMS SURVIVE A FAILED SUBMISSION.
   *
   * They live here, in the dialog, and the dialog stays mounted when a
   * submission fails — so somebody who wrote three sentences and hit a network
   * error still has their three sentences. They are cleared only by the dialog
   * closing, which happens on success, Cancel, Escape or the × control.
   */
  const [reply, setReply] = useState('')
  const [terms, setTerms] = useState<PiSubmissionTerms>(initialTerms ?? EMPTY_SUBMISSION_TERMS)

  const validation = validateResubmitReply(reply)
  const tooLong = !validation.ok
  const remaining = RESUBMIT_NOTE_MAX_LENGTH - reply.trim().length

  /**
   * WHETHER THE STANDARD REQUIREMENT IS MET IS THE DATABASE'S ANSWER, not a
   * comparison made here. `meets_standard` arrives on the summary already
   * decided in numeric; the browser never divides money.
   */
  const meetsStandard: boolean | null =
    payment == null || payment.meets_standard == null ? null : payment.meets_standard === true

  const checked = validateSubmissionTerms({ meetsStandard, terms })
  /**
   * The message is withheld while the revealed fields are still untouched.
   *
   * Somebody who has just opened the dialog has not made a mistake yet — they
   * have not typed anything — and greeting them with a red sentence about a
   * reason they were about to write is scolding, not help. Submit is still
   * disabled throughout, so nothing invalid can be sent.
   *
   * AN UNREADABLE PAYMENT POSITION IS SAID IMMEDIATELY, untouched or not: that
   * one is about the record rather than about anything the employee has yet to
   * do, and no amount of typing will fix it here.
   */
  const termsMessage =
    checked.ok || (submissionTermsUntouched(terms) && meetsStandard !== null)
      ? null
      : (checked as { ok: false; message: string }).message

  const blocked = submitting || tooLong || !checked.ok

  useScrollLock(true)

  const dismiss = (reason_: ModalDismissReason) => {
    if (submitting) return
    if (shouldCloseFormModal(reason_)) onCancel()
  }
  useEscapeDismiss(dismiss, !submitting)

  const confirm = () => {
    if (blocked || !checked.ok) return
    // The dialog hands up the TRIMMED reply and the VALIDATED terms, so what
    // reaches the database is what it stores — no leading spaces, and nothing at
    // all where the field was only whitespace.
    onConfirm(offerReply && validation.ok ? validation.note : null, checked.value)
  }

  return (
    // No onClick on the overlay: a click outside is inert, by rule.
    <div style={OVERLAY} role="dialog" aria-modal="true" aria-label={SUBMIT_BUTTON_LABEL}>
      <div style={PANEL}>
        <ModalHeader
          title={SUBMIT_BUTTON_LABEL}
          subtitle="Management reviews it next"
          onClose={() => dismiss('close-icon')}
          disabled={submitting}
        />

        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '13px' }}>
              <span style={KEY_STYLE}>Client</span>
              <span style={{ color: colors.primary, fontWeight: 600, textAlign: 'right' }}>{client}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '13px' }}>
              <span style={KEY_STYLE}>Grand total</span>
              <span style={{ color: colors.primary, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                {grandTotal}
              </span>
            </div>
          </div>

          <PaymentPositionPanel
            summary={payment}
            terms={terms}
            meetsStandard={meetsStandard}
            disabled={submitting}
            invalid={termsMessage}
            onTerms={(key, value) => setTerms(current => ({ ...current, [key]: value }))}
          />

          <div style={{
            fontSize: '12px', color: colors.primary, lineHeight: 1.5,
            background: colors.blueTint, border: '1px solid rgba(85,133,232,0.25)',
            borderRadius: '6px', padding: '9px 12px',
          }}>
            {SUBMIT_CONFIRM_NOTE}
          </div>

          {/* The optional reply, on a resubmission only.

              It is not a required field and does not gate the button: somebody
              with nothing to add submits exactly as they did before. The counter
              appears only as the cap approaches, so the ordinary case is a plain
              box rather than a form with a meter on it. */}
          {offerReply && (
            <label style={{
              display: 'flex', flexDirection: 'column', gap: '4px',
              fontSize: '11px', fontWeight: 600, color: colors.muted,
              textTransform: 'uppercase', letterSpacing: '0.05em',
            }}>
              {RESUBMIT_NOTE_LABEL}
              <textarea
                value={reply}
                onChange={e => setReply(e.target.value)}
                placeholder={RESUBMIT_NOTE_PLACEHOLDER}
                disabled={submitting}
                rows={3}
                style={{
                  padding: '7px 10px', borderRadius: '6px',
                  border: `1px solid ${tooLong ? 'rgba(217,79,79,0.5)' : colors.border}`,
                  background: colors.raised, color: colors.primary,
                  fontSize: '13px', width: '100%', boxSizing: 'border-box',
                  outline: 'none', minHeight: '70px', resize: 'vertical',
                  fontFamily: 'inherit',
                }}
              />
              {(tooLong || remaining <= 100) && (
                <span style={{
                  fontSize: '11px', fontWeight: 500, textTransform: 'none', letterSpacing: 0,
                  color: tooLong ? colors.red : colors.muted,
                }}>
                  {tooLong
                    ? (validation.ok ? '' : validation.message)
                    : `${remaining} character${remaining === 1 ? '' : 's'} left`}
                </span>
              )}
            </label>
          )}

          {failure && <FailureNote message={failure} />}

          <Footer>
            <button type="button" onClick={() => dismiss('cancel')} disabled={submitting} style={cancelStyle(submitting)}>
              Cancel
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={blocked}
              style={{ ...confirmStyle('#DC1F2E', blocked), display: 'inline-flex', alignItems: 'center', gap: '7px' }}
            >
              <Send size={13} strokeWidth={2} />
              {submitting ? 'Submitting…' : SUBMIT_BUTTON_LABEL}
            </button>
          </Footer>
        </div>
      </div>
    </div>
  )
}

// ── Needs Changes / Reject ────────────────────────────────────────────────────

export type PiNoteIntent = 'needs_changes' | 'reject' | 'reject_exception'

const INTENT_COPY: Record<PiNoteIntent, {
  title: string
  confirm: string
  busy: string
  label: string
  placeholder: string
  warning: string
  tone: { background: string; border: string; color: string }
  button: string
}> = {
  needs_changes: {
    title: REQUEST_CHANGES_BUTTON_LABEL,
    confirm: 'Send Back for Changes',
    busy: 'Sending back…',
    label: 'What needs to change *',
    placeholder: 'Say exactly what must be corrected in the PI…',
    warning:
      'The employee gets this note and can upload a corrected PI. Nothing is rejected and nothing is lost.',
    tone: { background: colors.amberTint, border: '1px solid rgba(232,160,48,0.3)', color: '#9A6212' },
    button: '#B45309',
  },
  reject: {
    title: REJECT_BUTTON_LABEL,
    confirm: 'Reject This PI',
    busy: 'Rejecting…',
    label: 'Reason for rejection *',
    placeholder: 'Say why this PI is being rejected…',
    // Stated plainly because it is true and irreversible: the database has no
    // transition out of 'rejected' in this phase.
    warning:
      'This cannot be undone. The PI is permanently marked Rejected, stays read-only, and cannot be resubmitted. Use Needs Changes if the employee should correct and resend it.',
    tone: { background: colors.redTint, border: '1px solid rgba(217,79,79,0.3)', color: '#991B1B' },
    button: '#991B1B',
  },
  // REFUSING THE PROPOSED ADVANCE IS NOT REJECTING THE PI, and the warning says
  // so first: this dialog sits beside "Reject This PI" in the same card, and the
  // one thing a reader must not do is confuse them. The PI comes back to the
  // employee, who may return with the standard requirement or a new proposal.
  reject_exception: {
    title: REJECT_EXCEPTION_BUTTON_LABEL,
    confirm: 'Reject Advance Exception',
    busy: 'Rejecting…',
    label: REJECT_EXCEPTION_REASON_LABEL,
    placeholder: 'Say why the proposed advance cannot be accepted…',
    warning:
      'The PI is NOT rejected. It goes back to the employee for correction with this reason, and they can resubmit under the standard advance or propose a different exception.',
    tone: { background: colors.amberTint, border: '1px solid rgba(232,160,48,0.3)', color: '#9A6212' },
    button: '#B45309',
  },
}

/**
 * The one dialog behind all three management decisions.
 *
 * The note is MANDATORY in every one, and for the same reason: a record sent
 * back without saying why produces the same record again, a rejection without a
 * reason tells the employee — and everybody reading the history in six months —
 * nothing about what the business refused, and a refused advance with no reason
 * produces the same proposal a second time. The confirm control stays disabled
 * while the field is blank or whitespace, and the database refuses a blank in
 * its own right regardless.
 */
export function PiNoteModal({
  intent,
  client,
  saving,
  failure,
  onCancel,
  onConfirm,
}: {
  intent: PiNoteIntent
  client: string
  saving: boolean
  failure: string | null
  onCancel: () => void
  onConfirm: (note: string) => void
}) {
  const [note, setNote] = useState('')
  const copy = INTENT_COPY[intent]
  const valid = note.trim().length > 0

  useScrollLock(true)

  const dismiss = (reason: ModalDismissReason) => {
    if (saving) return
    if (shouldCloseFormModal(reason)) onCancel()
  }
  useEscapeDismiss(dismiss, !saving)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (saving || !valid) return
    onConfirm(note)
  }

  return (
    <div style={OVERLAY} role="dialog" aria-modal="true" aria-label={copy.title}>
      <div style={PANEL}>
        <ModalHeader
          title={copy.title}
          subtitle={client}
          onClose={() => dismiss('close-icon')}
          disabled={saving}
        />

        <form onSubmit={submit} style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{
            display: 'flex', gap: '9px', alignItems: 'flex-start',
            fontSize: '12px', lineHeight: 1.5,
            background: copy.tone.background, border: copy.tone.border,
            color: copy.tone.color, borderRadius: '6px', padding: '9px 12px',
          }}>
            <AlertTriangle size={14} strokeWidth={2} style={{ flexShrink: 0, marginTop: '1px' }} />
            <span>{copy.warning}</span>
          </div>

          <label style={{
            display: 'flex', flexDirection: 'column', gap: '4px',
            fontSize: '11px', fontWeight: 600, color: colors.muted,
            textTransform: 'uppercase', letterSpacing: '0.05em',
          }}>
            {copy.label}
            <textarea
              autoFocus
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder={copy.placeholder}
              disabled={saving}
              style={{
                padding: '7px 10px', borderRadius: '6px',
                border: `1px solid ${colors.border}`,
                background: colors.raised, color: colors.primary,
                fontSize: '13px', width: '100%', boxSizing: 'border-box',
                outline: 'none', minHeight: '90px', resize: 'vertical',
                fontFamily: 'inherit',
              }}
            />
          </label>

          {failure && <FailureNote message={failure} />}

          <Footer>
            <button type="button" onClick={() => dismiss('cancel')} disabled={saving} style={cancelStyle(saving)}>
              Cancel
            </button>
            <button type="submit" disabled={saving || !valid} style={confirmStyle(copy.button, saving || !valid)}>
              {saving ? copy.busy : copy.confirm}
            </button>
          </Footer>
        </form>
      </div>
    </div>
  )
}

// ── Verify finance ────────────────────────────────────────────────────────────

/**
 * The finance sign-off, and the sentence that keeps it honest.
 *
 * WHY THIS IS A DIALOG AND NOT A BARE BUTTON. "Verify" sitting beside a grand
 * total is read as "the money is in" — and it is not, because no payment record
 * exists anywhere in this phase to make it so. The dialog states what is being
 * confirmed (the commercial figures and the advance terms) and then states, in
 * its own emphasised line, that no receipt of payment is being recorded. One
 * click with no confirmation would leave that distinction to be inferred.
 *
 * NO NOTE FIELD. Verification is a yes; there is nothing to explain, and a
 * mandatory box on the only positive path is friction for its own sake. If
 * something is wrong with the figures, the PI goes back through Needs Changes,
 * which already asks for words.
 *
 * IT CANNOT BE SUBMITTED TWICE. `saving` disables both buttons, the × control
 * and Escape — and verify_pi_finance_check() is idempotent regardless, so a
 * request that escapes anyway records no second verification and no second
 * activity entry.
 *
 * THE BOE FORM-MODAL DISMISSAL RULE APPLIES: a backdrop click is inert.
 */
export function PiFinanceVerifyModal({
  client,
  grandTotal,
  advanceLabel,
  saving,
  failure,
  onCancel,
  onConfirm,
}: {
  client: string
  grandTotal: string
  /** The advance condition this PI was submitted under, already worded. */
  advanceLabel: string
  saving: boolean
  failure: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  useScrollLock(true)

  const dismiss = (reason: ModalDismissReason) => {
    if (saving) return
    if (shouldCloseFormModal(reason)) onCancel()
  }
  useEscapeDismiss(dismiss, !saving)

  return (
    <div style={OVERLAY} role="dialog" aria-modal="true" aria-label={VERIFY_FINANCE_DIALOG_TITLE}>
      <div style={PANEL}>
        <ModalHeader
          title={VERIFY_FINANCE_DIALOG_TITLE}
          subtitle={client}
          onClose={() => dismiss('close-icon')}
          disabled={saving}
        />

        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {/* The two figures being signed off, and nothing else. The full
              breakdown is on the page behind this dialog. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '13px' }}>
              <span style={KEY_STYLE}>Grand total</span>
              <span style={{ color: colors.primary, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                {grandTotal}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '13px' }}>
              <span style={KEY_STYLE}>Advance</span>
              <span style={{ color: colors.primary, fontWeight: 600, textAlign: 'right' }}>{advanceLabel}</span>
            </div>
          </div>

          <div style={{
            display: 'flex', gap: '9px', alignItems: 'flex-start',
            fontSize: '12px', lineHeight: 1.5, color: colors.primary,
            background: colors.blueTint, border: '1px solid rgba(85,133,232,0.25)',
            borderRadius: '6px', padding: '9px 12px',
          }}>
            <ShieldCheck size={14} strokeWidth={2} style={{ flexShrink: 0, marginTop: '1px' }} />
            <span>
              {VERIFY_FINANCE_CONFIRM}
              {' '}
              <strong>{VERIFY_FINANCE_NOT_A_PAYMENT}</strong>
            </span>
          </div>

          {failure && <FailureNote message={failure} />}

          <Footer>
            <button type="button" onClick={() => dismiss('cancel')} disabled={saving} style={cancelStyle(saving)}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => { if (!saving) onConfirm() }}
              disabled={saving}
              style={{ ...confirmStyle('#2F5BB7', saving), display: 'inline-flex', alignItems: 'center', gap: '7px' }}
            >
              <ShieldCheck size={13} strokeWidth={2} />
              {saving ? VERIFY_FINANCE_BUSY_LABEL : VERIFY_FINANCE_BUTTON_LABEL}
            </button>
          </Footer>
        </div>
      </div>
    </div>
  )
}

// ── Approve PI & Create Order ─────────────────────────────────────────────────

/**
 * The last decision, and the only one on this screen that cannot be undone.
 *
 * WHAT IT SHOWS: five facts, from buildApprovalSummary — the client, the grand
 * total, the advance condition, the finance state and the number of product
 * lines. Between them they answer "am I approving the thing I think I am
 * approving", which is what a confirmation dialog is for. It does NOT restate
 * the commercial breakdown, the addresses or the products; those are on the page
 * behind it in full, and a truncated copy here helps nobody.
 *
 * WHAT IT SAYS, in three plain clauses: approval is final, an official Order
 * number will be assigned and the confirmed Order created, and NO PAYMENT IS
 * BEING RECORDED. The last is stated for the same reason it is stated on the
 * verification dialog — an approval beside a grand total invites the assumption.
 *
 * IT CANNOT BE SUBMITTED TWICE, in three independent ways: `saving` disables
 * both buttons, the × control and Escape; the page holds a ref that refuses a
 * second call in the same tick; and approve_order_submission() takes a row lock
 * and returns the EXISTING Order if one is already linked, so a request that
 * escapes both allocates no second number.
 *
 * THE BOE FORM-MODAL DISMISSAL RULE APPLIES: a backdrop click is inert, so a
 * misplaced click cannot dismiss a decision somebody is in the middle of taking.
 *
 * NOTHING HERE DECIDES AUTHORITY. The RPC re-derives the actor, the permission,
 * the status, the finance verification, the advance requirement, the diagnostics
 * and the stored files, under a row lock, before it creates anything.
 */
export function PiApproveOrderModal({
  client,
  rows,
  saving,
  failure,
  onCancel,
  onConfirm,
}: {
  client: string
  /** buildApprovalSummary's rows. This component chooses no wording of its own. */
  rows: readonly ApprovalSummaryRow[]
  saving: boolean
  failure: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  useScrollLock(true)

  const dismiss = (reason: ModalDismissReason) => {
    if (saving) return
    if (shouldCloseFormModal(reason)) onCancel()
  }
  useEscapeDismiss(dismiss, !saving)

  return (
    <div style={OVERLAY} role="dialog" aria-modal="true" aria-label={APPROVE_ORDER_DIALOG_TITLE}>
      <div style={PANEL}>
        <ModalHeader
          title={APPROVE_ORDER_DIALOG_TITLE}
          subtitle={client}
          onClose={() => dismiss('close-icon')}
          disabled={saving}
        />

        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {rows.map(row => (
              <div
                key={row.key}
                style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '13px' }}
              >
                <span style={KEY_STYLE}>{row.label}</span>
                <span style={{
                  color: colors.primary,
                  fontWeight: row.strong ? 700 : 600,
                  textAlign: 'right',
                  fontVariantNumeric: row.strong ? 'tabular-nums' : undefined,
                }}>
                  {row.value}
                </span>
              </div>
            ))}
          </div>

          <div style={{
            display: 'flex', gap: '9px', alignItems: 'flex-start',
            fontSize: '12px', lineHeight: 1.5, color: colors.primary,
            background: colors.amberTint, border: '1px solid rgba(232,160,48,0.3)',
            borderRadius: '6px', padding: '9px 12px',
          }}>
            <AlertTriangle size={14} strokeWidth={2} style={{ flexShrink: 0, marginTop: '1px' }} />
            <span>
              {APPROVE_ORDER_FINAL_NOTE}
              {' '}
              <strong>{APPROVE_ORDER_NOT_A_PAYMENT}</strong>
            </span>
          </div>

          {failure && <FailureNote message={failure} />}

          <Footer>
            <button type="button" onClick={() => dismiss('cancel')} disabled={saving} style={cancelStyle(saving)}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => { if (!saving) onConfirm() }}
              disabled={saving}
              style={{ ...confirmStyle('#2F7A52', saving), display: 'inline-flex', alignItems: 'center', gap: '7px' }}
            >
              <CheckCircle2 size={13} strokeWidth={2} />
              {saving ? APPROVE_ORDER_BUSY_LABEL : APPROVE_ORDER_CONFIRM_LABEL}
            </button>
          </Footer>
        </div>
      </div>
    </div>
  )
}

// ── Delete PI ─────────────────────────────────────────────────────────────────

/**
 * The confirmation before a PI is erased.
 *
 * IT SHOWS WHAT IS BEING DESTROYED AND WHAT STATE IT IS IN: the client the order
 * was for, and the status — because "Draft" and "Rejected" are very different
 * things to be deleting, and an employee who opened this on the wrong row should
 * be able to see that from the dialog rather than from the row behind it.
 *
 * NO TYPED CONFIRMATION. The warning names the workbook, the pictures and the
 * history explicitly, and the destructive button is the only red thing on
 * screen. Making somebody retype a client name to delete their own draft trains
 * people to type without reading, which makes the next dialog less safe rather
 * than this one more so.
 *
 * IT CANNOT BE SUBMITTED TWICE. `deleting` disables both buttons, the × control
 * and Escape, and the handler refuses re-entry — so a double click, an impatient
 * second press and a keyboard repeat all send exactly one request.
 *
 * THE BOE FORM-MODAL DISMISSAL RULE APPLIES, as it does to the other two: a
 * backdrop click is inert, and shouldCloseFormModal owns the decision.
 *
 * NOTHING HERE DECIDES AUTHORITY. delete_order_submission() re-derives the
 * actor, the ownership, the administrator check and the status under a row lock.
 */
export function PiDeleteConfirmModal({
  client,
  status,
  deleting,
  failure,
  onCancel,
  onConfirm,
}: {
  client: string
  /** The record's raw status; rendered through the shared label map. */
  status: string
  deleting: boolean
  failure: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  useScrollLock(true)

  const dismiss = (reason: ModalDismissReason) => {
    if (deleting) return
    if (shouldCloseFormModal(reason)) onCancel()
  }
  useEscapeDismiss(dismiss, !deleting)

  const confirm = () => {
    if (deleting) return
    onConfirm()
  }

  return (
    // No onClick on the overlay: a click outside is inert, by rule.
    <div style={OVERLAY} role="dialog" aria-modal="true" aria-label={DELETE_PI_DIALOG_TITLE}>
      <div style={PANEL}>
        <ModalHeader
          title={DELETE_PI_DIALOG_TITLE}
          subtitle="This cannot be undone"
          onClose={() => dismiss('close-icon')}
          disabled={deleting}
        />

        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '13px' }}>
              <span style={KEY_STYLE}>Client</span>
              <span style={{ color: colors.primary, fontWeight: 600, textAlign: 'right' }}>{client}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '13px' }}>
              <span style={KEY_STYLE}>Current status</span>
              <span style={{ color: colors.primary, fontWeight: 600, textAlign: 'right' }}>
                {deletionStatusLabel(status)}
              </span>
            </div>
          </div>

          <div style={{
            display: 'flex', gap: '9px', alignItems: 'flex-start',
            fontSize: '12px', color: colors.primary, lineHeight: 1.5,
            background: colors.redTint, border: '1px solid rgba(217,79,79,0.25)',
            borderRadius: '6px', padding: '9px 12px',
          }}>
            <AlertTriangle size={14} strokeWidth={2} color={colors.red} style={{ flexShrink: 0, marginTop: '1px' }} />
            <span>{DELETE_PI_WARNING}</span>
          </div>

          {failure && <FailureNote message={failure} />}

          <Footer>
            <button type="button" onClick={() => dismiss('cancel')} disabled={deleting} style={cancelStyle(deleting)}>
              {DELETE_PI_CANCEL_LABEL}
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={deleting}
              style={{ ...confirmStyle('#DC1F2E', deleting), display: 'inline-flex', alignItems: 'center', gap: '7px' }}
            >
              <Trash2 size={13} strokeWidth={2} />
              {deleting ? DELETE_PI_BUSY_LABEL : DELETE_PI_CONFIRM_LABEL}
            </button>
          </Footer>
        </div>
      </div>
    </div>
  )
}

// ── The client, in full ───────────────────────────────────────────────────────

/**
 * WHAT THE CARD STOPPED SAYING.
 *
 * The summary card printed the client's name, a phone number and a merged
 * address on a supporting line under it. Three of those four facts are
 * reference material: nobody scans a PI to re-read the billing address, they
 * open it to answer a question about the order. So the card keeps the name and
 * this dialog holds the rest, one click away.
 *
 * BILLING AND SHIPPING ARE ANSWERED SEPARATELY, ALWAYS — including when they
 * carry the same text. The card was right to merge them for one line; a
 * details dialog is where somebody checks where an order is going, and
 * "the same as billing" is an answer they have to be shown rather than left to
 * infer from an absence.
 *
 * NOTHING IS FETCHED. Every value here is already on the page: the same
 * columns buildClientDetails read out of the submission the detail view
 * already loaded. This dialog adds no request and no route.
 */
export function PiClientDetailsModal({ client, onClose }: {
  client: ClientDetails
  onClose: () => void
}) {
  useScrollLock(true)
  const dialogRef = useRef<HTMLDivElement>(null)

  /**
   * FOCUS GOES IN AND COMES BACK.
   *
   * `aria-modal="true"` tells assistive technology that the rest of the page is
   * inert. Without this, that was a lie: Tab walked straight out of the dialog
   * into the payment controls behind it, and closing left focus on <body> with
   * no way back to where the reader had been.
   *
   * Same three moves as OrderModal, which is where this pattern already lives:
   * remember the opener, focus the dialog, restore the opener on unmount.
   */
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => { opener?.focus?.() }
  }, [])

  // Escape closes; Tab and Shift+Tab cannot leave. Capture phase, so the trap
  // runs before anything inside the dialog handles the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key !== 'Tab') return

      const root = dialogRef.current
      if (!root) return

      const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter(el => el.offsetParent !== null || el === document.activeElement)
      const activeIndex = focusables.indexOf(document.activeElement as HTMLElement)

      const target = resolveTrapTarget({ count: focusables.length, activeIndex, shiftKey: e.shiftKey })
      if (target === null) return

      e.preventDefault()
      if (target === 'block') { root.focus(); return }
      focusables[target === 'first' ? 0 : focusables.length - 1]?.focus()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const row = (label: string, body: React.ReactNode) => (
    <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
      <div style={KEY_STYLE}>{label}</div>
      <div style={{ fontSize: '13px', color: colors.primary, lineHeight: 1.45 }}>{body}</div>
    </div>
  )

  /** An absent value is stated, never left as a blank line to be puzzled over. */
  const absent = <span style={{ color: colors.muted }}>{NOT_PROVIDED}</span>

  const party = (label: string, p: { name: string | null; address: string | null }) =>
    row(label, (
      <>
        {p.name && <div style={{ fontWeight: 600 }}>{p.name}</div>}
        {p.address
          ? <MultilineText style={{ margin: 0, fontSize: '13px', lineHeight: 1.45 }}>{p.address}</MultilineText>
          : (p.name ? absent : absent)}
      </>
    ))

  return (
    // A backdrop click closes: this dialog holds no input to lose, so the
    // form-modal rule that makes an outside click inert does not apply.
    <div style={OVERLAY} onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Client details"
        tabIndex={-1}
        style={{ ...PANEL, outline: 'none' }}
        onClick={e => e.stopPropagation()}
      >
        <ModalHeader title="Client details" subtitle={client.name} onClose={onClose} disabled={false} />
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {row('Client', <span style={{ fontWeight: 600 }}>{client.name}</span>)}
          {row('Contact number', client.phone
            ? <a href={`tel:${client.phone.tel}`} style={{ color: '#5585e8', textDecoration: 'none' }}>
                {client.phone.label}
              </a>
            /* Present but not dialable: shown as the text it is, never as a
               link that would dial nothing. */
            : client.phoneText ?? absent)}
          {party('Billing details', client.billTo)}
          {party('Shipping details', client.shipTo)}
        </div>
      </div>
    </div>
  )
}
