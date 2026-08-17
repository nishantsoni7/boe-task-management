'use client'

// The three decisions taken on a saved PI, as three dialogs.
//
//   PiSubmitConfirmModal   the employee hands their PI to management
//   PiNoteModal            management sends it back, or ends it
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
} from '@/lib/orders/submissionWorkflow'

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

// ── Submit for Approval ───────────────────────────────────────────────────────

/**
 * The confirmation before a PI leaves the employee's hands.
 *
 * IT SHOWS THREE THINGS AND NO MORE: who the order is for, what it is worth, and
 * that submitting makes the record read-only. The full document is on the page
 * behind this dialog — restating the product table inside a confirmation would
 * be asking somebody to re-read what they have just read, in a smaller box.
 *
 * The figure is passed in already formatted, so the money on this dialog is the
 * money on the page: one formatter, one rendering.
 */
export function PiSubmitConfirmModal({
  client,
  grandTotal,
  submitting,
  failure,
  onCancel,
  onConfirm,
}: {
  client: string
  grandTotal: string
  submitting: boolean
  failure: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  useScrollLock(true)

  const dismiss = (reason: ModalDismissReason) => {
    if (submitting) return
    if (shouldCloseFormModal(reason)) onCancel()
  }
  useEscapeDismiss(dismiss, !submitting)

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

          <div style={{
            fontSize: '12px', color: colors.primary, lineHeight: 1.5,
            background: colors.blueTint, border: '1px solid rgba(85,133,232,0.25)',
            borderRadius: '6px', padding: '9px 12px',
          }}>
            {SUBMIT_CONFIRM_NOTE}
          </div>

          {failure && <FailureNote message={failure} />}

          <Footer>
            <button type="button" onClick={() => dismiss('cancel')} disabled={submitting} style={cancelStyle(submitting)}>
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={submitting}
              style={{ ...confirmStyle('#DC1F2E', submitting), display: 'inline-flex', alignItems: 'center', gap: '7px' }}
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

export type PiNoteIntent = 'needs_changes' | 'reject'

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
}

/**
 * The one dialog behind both management decisions.
 *
 * The note is MANDATORY in both, and for the same reason: a record sent back
 * without saying why produces the same record again, and a rejection without a
 * reason tells the employee — and everybody reading the history in six months —
 * nothing about what the business refused. The confirm control stays disabled
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
