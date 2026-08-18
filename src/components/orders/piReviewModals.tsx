'use client'

// The decisions taken on a saved PI, as dialogs.
//
//   PiSubmitConfirmModal   the employee hands their PI to management, under a
//                          declared advance requirement
//   PiNoteModal            management sends it back, ends it, or refuses a
//                          proposed advance
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
import { AlertTriangle, Send, X } from 'lucide-react'
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
  ADVANCE_EXCEPTION_HINT,
  ADVANCE_EXCEPTION_LABEL,
  ADVANCE_NOT_A_PAYMENT,
  ADVANCE_PERCENT_LABEL,
  ADVANCE_REASON_LABEL,
  ADVANCE_REASON_MAX_LENGTH,
  ADVANCE_REASON_PLACEHOLDER,
  ADVANCE_SECTION_TITLE,
  ADVANCE_STANDARD_HINT,
  ADVANCE_STANDARD_LABEL,
  ADVANCE_STANDARD_PERCENT,
  ADVANCE_ZERO_EXPLANATION,
  REJECT_EXCEPTION_BUTTON_LABEL,
  REJECT_EXCEPTION_REASON_LABEL,
  previewAdvanceAmount,
  validateAdvanceSelection,
  type AdvanceCondition,
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
 * The two-option choice, and the two fields the second one reveals.
 *
 * A SELECTOR, NOT A FORM. Standard is the default and the obvious path: choosing
 * it is one click and reveals nothing, so the commonest submission is exactly as
 * short as it was before this existed. The percentage and reason appear only
 * when somebody actually asks for an exception, which is the rare case and the
 * one worth spending screen on.
 *
 * THE RUPEE FIGURE IS SHOWN IMMEDIATELY, for both options, because "12%" means
 * nothing to somebody deciding whether the business can live with it and
 * "₹1,47,500" means everything. Both come from computeAdvanceAmount, which is
 * also what the commercial summary on the page behind this uses — one formula,
 * so the two cannot disagree.
 *
 * IT SAYS NOTHING ABOUT PAYMENT, and says so out loud.
 */
function AdvanceSelector({
  condition,
  percentText,
  reason,
  grandTotalValue,
  standardAmount,
  disabled,
  invalid,
  onCondition,
  onPercent,
  onReason,
}: {
  condition: AdvanceCondition
  percentText: string
  reason: string
  grandTotalValue: number | null
  standardAmount: string
  disabled: boolean
  /** The validation message, or null while the choice is usable. */
  invalid: string | null
  onCondition: (next: AdvanceCondition) => void
  onPercent: (next: string) => void
  onReason: (next: string) => void
}) {
  const isException = condition === 'exception'
  const proposed = previewAdvanceAmount(percentText, grandTotalValue)
  const zero = percentText.trim() !== '' && Number(percentText.trim()) === 0

  const option = (
    value: AdvanceCondition,
    label: string,
    hint: string,
    trailing: React.ReactNode,
  ) => {
    const selected = condition === value
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
          name="advance-condition"
          checked={selected}
          disabled={disabled}
          onChange={() => onCondition(value)}
          style={{ marginTop: '2px', accentColor: '#2F5BB7', cursor: disabled ? 'not-allowed' : 'pointer' }}
        />
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{
            display: 'flex', gap: '10px', justifyContent: 'space-between',
            alignItems: 'baseline', flexWrap: 'wrap',
          }}>
            <span style={{ fontSize: '12.5px', fontWeight: 600, color: colors.primary }}>{label}</span>
            {trailing}
          </span>
          <span style={{ display: 'block', fontSize: '11.5px', color: colors.secondary, lineHeight: 1.45, marginTop: '2px' }}>
            {hint}
          </span>
        </span>
      </label>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={KEY_STYLE}>{ADVANCE_SECTION_TITLE}</div>

      {option(
        'standard',
        ADVANCE_STANDARD_LABEL,
        ADVANCE_STANDARD_HINT,
        <span style={{ fontSize: '12.5px', fontWeight: 700, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
          {standardAmount}
        </span>,
      )}

      {option(
        'exception',
        ADVANCE_EXCEPTION_LABEL,
        ADVANCE_EXCEPTION_HINT,
        isException ? (
          <span style={{ fontSize: '12.5px', fontWeight: 700, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
            {proposed}
          </span>
        ) : null,
      )}

      {/* Revealed only for an exception. Two fields, both required, and both
          re-validated by the database on arrival. */}
      {isException && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: '9px',
          padding: '10px 11px', borderRadius: '7px',
          border: `1px solid ${colors.border}`, background: colors.raised,
        }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', ...KEY_STYLE }}>
            {ADVANCE_PERCENT_LABEL}
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="text"
                inputMode="decimal"
                value={percentText}
                onChange={e => onPercent(e.target.value)}
                placeholder={`0 – ${ADVANCE_STANDARD_PERCENT - 1}`}
                disabled={disabled}
                aria-label={ADVANCE_PERCENT_LABEL}
                style={{
                  padding: '7px 10px', borderRadius: '6px',
                  border: `1px solid ${colors.border}`,
                  background: colors.base, color: colors.primary,
                  fontSize: '13px', width: '110px', boxSizing: 'border-box',
                  outline: 'none', fontVariantNumeric: 'tabular-nums',
                }}
              />
              <span style={{
                fontSize: '12.5px', fontWeight: 600, color: colors.secondary,
                textTransform: 'none', letterSpacing: 0, fontVariantNumeric: 'tabular-nums',
              }}>
                = {proposed}
              </span>
            </span>
          </label>

          {/* 0% is legitimate and is the one value whose meaning is not obvious
              from the figure beside it, so it is spelled out rather than left
              as a ₹0 the reader has to interpret. */}
          {zero && (
            <div style={{ fontSize: '11.5px', color: '#9A6212', lineHeight: 1.45 }}>
              {ADVANCE_ZERO_EXPLANATION}
            </div>
          )}

          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', ...KEY_STYLE }}>
            {ADVANCE_REASON_LABEL}
            <textarea
              value={reason}
              onChange={e => onReason(e.target.value)}
              placeholder={ADVANCE_REASON_PLACEHOLDER}
              disabled={disabled}
              rows={3}
              maxLength={ADVANCE_REASON_MAX_LENGTH}
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
        </div>
      )}

      {invalid && (
        <div style={{ fontSize: '11.5px', color: colors.red, lineHeight: 1.45 }}>{invalid}</div>
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
   * The choice this dialog opens on.
   *
   * Standard for a new submission. On a RESUBMISSION it is whatever the record
   * already carries, so a PI returned for an unrelated correction does not
   * silently switch the employee's advance condition while they fix a fabric
   * name — and an approved exception resubmitted unchanged stays approved.
   */
  initialAdvance: { condition: AdvanceCondition; percentText: string; reason: string }
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
  const [condition, setCondition] = useState<AdvanceCondition>(initialAdvance.condition)
  const [percentText, setPercentText] = useState(initialAdvance.percentText)
  const [reason, setReason] = useState(initialAdvance.reason)

  const validation = validateResubmitReply(reply)
  const tooLong = !validation.ok
  const remaining = RESUBMIT_NOTE_MAX_LENGTH - reply.trim().length

  const advance = validateAdvanceSelection({ condition, percentText, reason, grandTotal: grandTotalValue })
  /**
   * The message is withheld while the exception fields are still untouched.
   *
   * Somebody who has just chosen "Request advance exception" has not made a
   * mistake yet — they have not typed anything — and greeting them with a red
   * sentence about a percentage they were about to enter is scolding, not help.
   * Submit is still disabled throughout, so nothing invalid can be sent.
   */
  const untouched = condition === 'exception' && percentText.trim() === '' && reason.trim() === ''
  const advanceMessage = advance.ok || (untouched && grandTotalValue !== null)
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
            condition={condition}
            percentText={percentText}
            reason={reason}
            grandTotalValue={grandTotalValue}
            standardAmount={standardAdvance}
            disabled={submitting}
            invalid={advanceMessage}
            onCondition={setCondition}
            onPercent={setPercentText}
            onReason={setReason}
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
