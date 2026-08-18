'use client'

// The decisions taken on a saved PI, as dialogs.
//
//   PiSubmitConfirmModal   the employee hands their PI to management, under a
//                          declared advance requirement
//   PiNoteModal            management sends it back, ends it, or refuses a
//                          proposed advance
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

import { useEffect, useState } from 'react'
import { AlertTriangle, Send, Trash2, X } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { useScrollLock } from '@/hooks/useScrollLock'
import { shouldCloseFormModal, type ModalDismissReason } from '@/lib/ui/modalDismissal'
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
  DELETE_PI_BUSY_LABEL,
  DELETE_PI_CANCEL_LABEL,
  DELETE_PI_CONFIRM_LABEL,
  DELETE_PI_DIALOG_TITLE,
  DELETE_PI_WARNING,
  deletionStatusLabel,
} from '@/lib/orders/submissionDeletion'
import {
  ADVANCE_AMOUNT_LABEL,
  ADVANCE_CHOICES,
  ADVANCE_CHOICE_HINT,
  ADVANCE_CHOICE_LABEL,
  ADVANCE_NONE_AMOUNT_LABEL,
  ADVANCE_NONE_PERCENT_LABEL,
  ADVANCE_NOT_A_PAYMENT,
  ADVANCE_PERCENT_LABEL,
  ADVANCE_REASON_LABEL,
  ADVANCE_REASON_MAX_LENGTH,
  ADVANCE_REASON_PLACEHOLDER,
  ADVANCE_SECTION_TITLE,
  ADVANCE_STANDARD_PERCENT,
  ADVANCE_ZERO_EXPLANATION,
  REJECT_EXCEPTION_BUTTON_LABEL,
  REJECT_EXCEPTION_REASON_LABEL,
  advanceDeclarationUntouched,
  previewAdvanceAmount,
  validateAdvanceDeclaration,
  type AdvanceChoice,
  type AdvanceDeclaration,
  type AdvanceSelection,
} from '@/lib/orders/advanceRequirement'

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

// ── The advance selector ──────────────────────────────────────────────────────

/**
 * The THREE choices, and the fields each one reveals.
 *
 * WHY THIS WAS REBUILT. It offered two radio cards — "Standard advance (40%)"
 * and "Request advance exception" — and proceeding with NO advance was reachable
 * only by choosing the second and knowing that 0 was an accepted percentage.
 * Nothing on screen said so. A choice that has to be guessed at is not a choice,
 * and "we need to start this order without an advance" is exactly the case
 * management most needs asked explicitly.
 *
 * So the three business decisions are three controls:
 *
 *   Standard advance (40%)  one click, nothing revealed, and the default for a
 *                           PI that has never declared anything
 *   Reduced advance         a percentage above 0 and below 40, its rupee value
 *                           live beside it, and a mandatory reason
 *   No advance (0%)         a FIXED 0% and ₹0 — no box to type a figure into,
 *                           because the figure is the choice — and the same
 *                           mandatory reason
 *
 * ALL THREE ARE ALWAYS VISIBLE. The two exceptions are not hidden behind an
 * "exception" disclosure, because somebody who does not know the disclosure
 * exists cannot find what is inside it. That is the whole defect.
 *
 * THE RUPEE FIGURE IS SHOWN IMMEDIATELY, for every choice, because "12%" means
 * nothing to somebody deciding whether the business can live with it and
 * "₹1,47,500" means everything. Every figure comes from computeAdvanceAmount,
 * which is also what the commercial summary on the page behind this dialog
 * uses — one formula, so the two cannot disagree.
 *
 * IT SAYS NOTHING ABOUT PAYMENT, and says so out loud. "No advance" is a request
 * to start work on nothing received. It is not a payment, not a waiver and not a
 * receipt, and this phase records none of those.
 */
function AdvanceSelector({
  declaration,
  grandTotalValue,
  standardAmount,
  disabled,
  invalid,
  onChoice,
  onPercent,
  onReason,
}: {
  declaration: AdvanceDeclaration
  grandTotalValue: number | null
  standardAmount: string
  disabled: boolean
  /** The validation message, or null while the choice is usable. */
  invalid: string | null
  onChoice: (next: AdvanceChoice) => void
  onPercent: (next: string) => void
  onReason: (next: string) => void
}) {
  const { choice, percentText, reason } = declaration
  const proposed = previewAdvanceAmount(percentText, grandTotalValue)

  /** The figure printed on the right of each card. */
  const trailing = (value: AdvanceChoice): string | null => {
    if (value === 'standard') return standardAmount
    if (value === 'none') return ADVANCE_NONE_AMOUNT_LABEL
    return choice === 'reduced' ? proposed : null
  }

  const card = (value: AdvanceChoice) => {
    const selected = choice === value
    const amount = trailing(value)
    return (
      <label
        key={value}
        style={{
          display: 'flex', gap: '9px', alignItems: 'flex-start',
          padding: '9px 11px', borderRadius: '7px',
          border: `1px solid ${selected ? 'rgba(85,133,232,0.55)' : colors.border}`,
          background: selected ? colors.blueTint : 'transparent',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        <input
          type="radio"
          name="advance-choice"
          value={value}
          checked={selected}
          disabled={disabled}
          onChange={() => onChoice(value)}
          style={{ marginTop: '2px', accentColor: '#2F5BB7', cursor: disabled ? 'not-allowed' : 'pointer' }}
        />
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{
            display: 'flex', gap: '10px', justifyContent: 'space-between',
            alignItems: 'baseline', flexWrap: 'wrap',
          }}>
            <span style={{ fontSize: '12.5px', fontWeight: 600, color: colors.primary }}>
              {ADVANCE_CHOICE_LABEL[value]}
            </span>
            {amount !== null && (
              <span style={{
                fontSize: '12.5px', fontWeight: 700, color: colors.primary,
                fontVariantNumeric: 'tabular-nums',
              }}>
                {amount}
              </span>
            )}
          </span>
          <span style={{ display: 'block', fontSize: '11.5px', color: colors.secondary, lineHeight: 1.45, marginTop: '2px' }}>
            {ADVANCE_CHOICE_HINT[value]}
          </span>
        </span>
      </label>
    )
  }

  /** The mandatory reason, identical under both exception choices. */
  const reasonField = (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', ...KEY_STYLE }}>
      {ADVANCE_REASON_LABEL}
      <textarea
        value={reason}
        onChange={e => onReason(e.target.value)}
        placeholder={ADVANCE_REASON_PLACEHOLDER}
        disabled={disabled}
        rows={3}
        maxLength={ADVANCE_REASON_MAX_LENGTH}
        aria-label={ADVANCE_REASON_LABEL}
        style={{
          padding: '7px 10px', borderRadius: '6px',
          border: `1px solid ${colors.border}`,
          background: colors.base, color: colors.primary,
          fontSize: '13px', width: '100%', boxSizing: 'border-box',
          outline: 'none', minHeight: '68px', resize: 'vertical',
          fontFamily: 'inherit', textTransform: 'none', letterSpacing: 0,
          fontWeight: 400,
        }}
      />
    </label>
  )

  const revealed: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: '9px',
    padding: '10px 11px', borderRadius: '7px',
    border: `1px solid ${colors.border}`, background: colors.raised,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={KEY_STYLE}>{ADVANCE_SECTION_TITLE}</div>

      {ADVANCE_CHOICES.map(card)}

      {/* Reduced advance: a typed percentage, its rupee value, and the reason.
          Every field is re-validated by the database on arrival. */}
      {choice === 'reduced' && (
        <div style={revealed}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', ...KEY_STYLE }}>
            {ADVANCE_PERCENT_LABEL}
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <input
                type="text"
                inputMode="decimal"
                value={percentText}
                onChange={e => onPercent(e.target.value)}
                placeholder={`above 0 – below ${ADVANCE_STANDARD_PERCENT}`}
                disabled={disabled}
                aria-label={ADVANCE_PERCENT_LABEL}
                style={{
                  padding: '7px 10px', borderRadius: '6px',
                  border: `1px solid ${colors.border}`,
                  background: colors.base, color: colors.primary,
                  fontSize: '13px', width: '130px', boxSizing: 'border-box',
                  outline: 'none', fontVariantNumeric: 'tabular-nums',
                }}
              />
              <span style={{
                fontSize: '12.5px', fontWeight: 600, color: colors.secondary,
                textTransform: 'none', letterSpacing: 0, fontVariantNumeric: 'tabular-nums',
              }}>
                {ADVANCE_AMOUNT_LABEL}: {proposed}
              </span>
            </span>
          </label>

          {reasonField}
        </div>
      )}

      {/* No advance: the figures are FIXED and stated rather than typed, so
          there is nothing here to get wrong and nothing to reinterpret. */}
      {choice === 'none' && (
        <div style={revealed}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <span style={{ ...KEY_STYLE, display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
              {ADVANCE_PERCENT_LABEL}
              <span style={{
                color: colors.primary, fontWeight: 700, fontSize: '12.5px',
                textTransform: 'none', letterSpacing: 0, fontVariantNumeric: 'tabular-nums',
              }}>
                {ADVANCE_NONE_PERCENT_LABEL}
              </span>
            </span>
            <span style={{ ...KEY_STYLE, display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
              {ADVANCE_AMOUNT_LABEL}
              <span style={{
                color: colors.primary, fontWeight: 700, fontSize: '12.5px',
                textTransform: 'none', letterSpacing: 0, fontVariantNumeric: 'tabular-nums',
              }}>
                {ADVANCE_NONE_AMOUNT_LABEL}
              </span>
            </span>
          </div>

          {/* 0% is legitimate and is the one value whose meaning is not obvious
              from the figure beside it, so it is spelled out rather than left
              as a ₹0 the reader has to interpret. */}
          <div style={{ fontSize: '11.5px', color: '#9A6212', lineHeight: 1.45 }}>
            {ADVANCE_ZERO_EXPLANATION}
          </div>

          {reasonField}
        </div>
      )}

      {invalid && (
        <div style={{ fontSize: '11.5px', color: colors.red, lineHeight: 1.45 }} role="alert">
          {invalid}
        </div>
      )}

      <div style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.45 }}>
        {ADVANCE_NOT_A_PAYMENT}
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
  grandTotalValue,
  standardAdvance,
  initialAdvance,
  submitting,
  failure,
  offerReply,
  onCancel,
  onConfirm,
}: {
  client: string
  grandTotal: string
  /**
   * The PERSISTED grand total, as a number, or null when the workbook printed
   * words rather than a figure.
   *
   * A NULL FAILS THE DIALOG CLOSED. Nobody may declare a percentage of an amount
   * nobody knows, so the choice is unusable and Submit stays disabled with the
   * reason on screen — the same refusal the database gives, arrived at before
   * the round trip rather than after it.
   */
  grandTotalValue: number | null
  /** The standard requirement in rupees, already formatted. */
  standardAdvance: string
  /**
   * The choice this dialog opens on, as initialAdvanceSelection derived it from
   * the record.
   *
   * Standard for a new submission — and ONLY for one that has never declared
   * anything. On a RESUBMISSION it is whatever the record already carries, so a
   * PI returned for an unrelated correction does not silently switch the
   * employee's advance condition while they fix a fabric name, an approved
   * exception resubmitted unchanged stays approved, and a stored 0% opens on
   * "No advance" rather than on a Reduced advance with a zero in the box.
   */
  initialAdvance: AdvanceDeclaration
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
  /** The trimmed reply (null when there is none) and the validated declaration. */
  onConfirm: (note: string | null, advance: AdvanceSelection) => void
}) {
  /**
   * THE TYPED REPLY AND THE TYPED DECLARATION SURVIVE A FAILED SUBMISSION.
   *
   * They live here, in the dialog, and the dialog stays mounted when a
   * submission fails — so somebody who wrote three sentences and hit a network
   * error still has their three sentences. They are cleared only by the dialog
   * closing, which happens on success, Cancel, Escape or the × control.
   */
  const [reply, setReply] = useState('')
  const [declaration, setDeclaration] = useState<AdvanceDeclaration>(initialAdvance)

  const validation = validateResubmitReply(reply)
  const tooLong = !validation.ok
  const remaining = RESUBMIT_NOTE_MAX_LENGTH - reply.trim().length

  const advance = validateAdvanceDeclaration({ ...declaration, grandTotal: grandTotalValue })
  /**
   * The message is withheld while the revealed fields are still untouched.
   *
   * Somebody who has just pressed "Reduced advance" has not made a mistake yet —
   * they have not typed anything — and greeting them with a red sentence about a
   * percentage they were about to enter is scolding, not help. Submit is still
   * disabled throughout, so nothing invalid can be sent.
   *
   * A MISSING GRAND TOTAL IS SAID IMMEDIATELY, untouched or not: that one is
   * about the record rather than about anything the employee has yet to do, and
   * no amount of typing will fix it here.
   */
  const advanceMessage =
    advance.ok || (advanceDeclarationUntouched(declaration) && grandTotalValue !== null)
      ? null
      : (advance as { ok: false; message: string }).message

  const blocked = submitting || tooLong || !advance.ok

  useScrollLock(true)

  const dismiss = (reason_: ModalDismissReason) => {
    if (submitting) return
    if (shouldCloseFormModal(reason_)) onCancel()
  }
  useEscapeDismiss(dismiss, !submitting)

  const confirm = () => {
    if (blocked || !advance.ok) return
    // The dialog hands up the TRIMMED reply and the VALIDATED declaration, so
    // what reaches the trail is what the database stored — no leading spaces,
    // and nothing at all when the field was only whitespace.
    onConfirm(offerReply && validation.ok ? validation.note : null, advance.value)
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

          <AdvanceSelector
            declaration={declaration}
            grandTotalValue={grandTotalValue}
            standardAmount={standardAdvance}
            disabled={submitting}
            invalid={advanceMessage}
            // The typed percentage and reason SURVIVE a change of choice, so
            // somebody comparing "reduced" against "no advance" does not lose
            // the sentence they wrote. What is SENT is decided by the choice
            // alone: validateAdvanceDeclaration never reads the percentage box
            // under "No advance", so nothing left behind can contradict it.
            onChoice={next => setDeclaration(current => ({ ...current, choice: next }))}
            onPercent={next => setDeclaration(current => ({ ...current, percentText: next }))}
            onReason={next => setDeclaration(current => ({ ...current, reason: next }))}
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
