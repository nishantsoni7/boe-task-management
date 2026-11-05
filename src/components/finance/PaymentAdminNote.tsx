'use client'

// The admin's private note on a payment (20270603000000). Two places draw it, one
// form behind both: a small popup opened from the Payment Requests list, and a
// section inside the payment popup. Neither draws for anybody but an admin (the
// page decides), and the database refuses everybody else regardless.
//
// SAVING NEVER OPENS THE PAYMENT AND NEVER RELOADS THE LIST: the form saves
// through one function, tells the page the new note, and the page repaints the
// row's icon from it. A failed save keeps what was typed and says why.

import { useEffect, useRef, useState } from 'react'
import { Lock } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { customerDisplayName } from '@/lib/finance/paymentEntry'
import { formatMoney } from '@/lib/finance/piPaymentView'
import type { createClient } from '@/lib/supabase/client'
import { ADMIN_NOTE_MAX, savePaymentAdminNote, type PaymentAdminNote } from '@/lib/finance/paymentAdminNotes'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'

type Client = ReturnType<typeof createClient>

export const ADMIN_NOTE_PRIVACY_LINE = 'Only administrators can see this note. The person who sent the request cannot.'

export function PaymentAdminNoteForm({
  supabase,
  paymentId,
  initial,
  onSaved,
  onCancel,
  focusOnOpen = false,
}: {
  supabase: Client
  paymentId: string
  /** The note as it is now ('' when there is none). */
  initial: string
  /** Called once the note is saved (a note) or removed (null). */
  onSaved: (note: PaymentAdminNote | null) => void
  /** Draws a Cancel button when given (the popup). */
  onCancel?: () => void
  focusOnOpen?: boolean
}) {
  const [text, setText] = useState(initial)
  // What the database holds, as far as this form knows: moves when a save lands, so a
  // form that stays open (the payment popup) is not "unsaved" straight after saving.
  const [saved, setSaved] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)
  // A save is not idempotent from the caller's side: the guard is a ref set BEFORE the await.
  const savingRef = useRef(false)
  const boxRef = useRef<HTMLTextAreaElement>(null)

  // After the dialog's own focus step (it focuses the dialog when it opens), and with the cursor at the end.
  useEffect(() => {
    if (!focusOnOpen) return
    const t = setTimeout(() => {
      const el = boxRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }, 0)
    return () => clearTimeout(t)
  }, [focusOnOpen])

  const trimmed = text.trim()
  const tooLong = trimmed.length > ADMIN_NOTE_MAX
  const removing = trimmed === '' && saved.trim() !== ''
  const dirty = trimmed !== saved.trim()
  const canSave = dirty && !tooLong && !busy

  const save = async () => {
    if (!canSave || savingRef.current) return
    savingRef.current = true
    setBusy(true)
    setError(null)
    const result = await savePaymentAdminNote(supabase, paymentId, text)
    savingRef.current = false
    setBusy(false)
    if (!result.ok) { setError(result.message); return }
    setSaved(result.note?.note ?? '')
    if (result.note === null) setText('')
    setJustSaved(true)
    onSaved(result.note)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <textarea
        ref={boxRef}
        className="boe-input"
        aria-label="Admin note"
        aria-invalid={tooLong || undefined}
        value={text}
        onChange={e => { setText(e.target.value); setError(null); setJustSaved(false) }}
        onKeyDown={e => {
          // Ctrl+Enter / Cmd+Enter saves; a plain Enter is a new line.
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save() }
        }}
        placeholder="Write a private note…"
        rows={4}
        style={{ width: '100%', resize: 'vertical', fontSize: '13px', lineHeight: 1.5 }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span
          aria-live="polite"
          style={{ fontSize: '12px', color: tooLong ? colors.red : justSaved && !dirty ? colors.green : colors.muted, marginRight: 'auto' }}
        >
          {tooLong
            ? `${trimmed.length.toLocaleString('en-IN')} of ${ADMIN_NOTE_MAX.toLocaleString('en-IN')} characters: too long`
            : justSaved && !dirty
              ? (saved.trim() === '' ? 'Note removed' : 'Saved')
              : `${trimmed.length.toLocaleString('en-IN')} / ${ADMIN_NOTE_MAX.toLocaleString('en-IN')}`}
        </span>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={busy} className="boe-btn boe-btn-ghost" style={{ padding: '7px 16px', fontSize: '13px' }}>
            {justSaved && !dirty ? 'Close' : 'Cancel'}
          </button>
        )}
        <button
          type="button"
          onClick={() => void save()}
          disabled={!canSave}
          className="boe-btn boe-btn-primary"
          style={{
            padding: '7px 16px', fontSize: '13px',
            ...(removing ? { background: colors.red, borderColor: colors.red } : null),
          }}
        >
          {busy ? 'Saving…' : removing ? 'Remove note' : 'Save note'}
        </button>
      </div>
      {error && (
        <div role="alert" style={{ fontSize: '12px', color: colors.red, background: colors.redTint, borderRadius: '8px', padding: '8px 10px', lineHeight: 1.5 }}>
          {error}
        </div>
      )}
    </div>
  )
}

/** The popup the list's note icon opens: one box, saved without opening the payment. */
export function PaymentAdminNoteDialog({
  supabase,
  payment,
  initial,
  onSaved,
  onClose,
}: {
  supabase: Client
  payment: { id: string; human_payment_id: string; client_name: string | null; amount: number }
  initial: string
  onSaved: (paymentId: string, note: PaymentAdminNote | null) => void
  onClose: () => void
}) {
  return (
    // A backdrop click never discards typing (the BOE form-modal dismissal rule); Escape and the × still close.
    <FinanceModal title={`Admin note · ${payment.human_payment_id}`} onClose={onClose} width="460px" closeOnBackdropClick={false}>
      <div style={{ fontSize: '13px', color: colors.secondary, lineHeight: 1.4, overflowWrap: 'anywhere' }}>
        <strong style={{ color: colors.primary }}>{customerDisplayName(payment.client_name)}</strong>
        {' · '}
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatMoney(payment.amount)}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: colors.amber, background: colors.amberTint, borderRadius: '8px', padding: '7px 10px' }}>
        <Lock size={13} aria-hidden="true" style={{ flexShrink: 0 }} />
        <span>{ADMIN_NOTE_PRIVACY_LINE}</span>
      </div>
      <PaymentAdminNoteForm
        supabase={supabase}
        paymentId={payment.id}
        initial={initial}
        focusOnOpen
        onCancel={onClose}
        onSaved={note => { onSaved(payment.id, note); onClose() }}
      />
    </FinanceModal>
  )
}

/**
 * What the payment popup draws for an admin, whatever the read said: nothing while
 * the notes are being read, a sentence if they could not be, the note box once they
 * are. (Never an empty box over a failed read: saving it could replace a note the
 * admin cannot see.)
 */
export function PaymentAdminNoteSlot({
  supabase,
  paymentId,
  notes,
  onSaved,
}: {
  supabase: Client
  paymentId: string
  notes: ReadonlyMap<string, PaymentAdminNote> | 'loading' | 'failed'
  onSaved: (paymentId: string, note: PaymentAdminNote | null) => void
}) {
  if (notes === 'loading') return null
  if (notes === 'failed') {
    return (
      <div role="status" style={{ border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '12px 16px', fontSize: '12px', color: colors.muted }}>
        Admin note: it could not be read. Press refresh.
      </div>
    )
  }
  return <PaymentAdminNotePanel supabase={supabase} paymentId={paymentId} initial={notes.get(paymentId)?.note ?? ''} onSaved={onSaved} />
}

/** The same note inside the payment popup, under its own heading. */
export function PaymentAdminNotePanel({
  supabase,
  paymentId,
  initial,
  onSaved,
}: {
  supabase: Client
  paymentId: string
  initial: string
  onSaved: (paymentId: string, note: PaymentAdminNote | null) => void
}) {
  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div>
        <div style={{ fontSize: '12px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Admin note</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: colors.amber, marginTop: '4px' }}>
          <Lock size={12} aria-hidden="true" style={{ flexShrink: 0 }} />
          <span>{ADMIN_NOTE_PRIVACY_LINE}</span>
        </div>
      </div>
      <PaymentAdminNoteForm
        key={paymentId}
        supabase={supabase}
        paymentId={paymentId}
        initial={initial}
        onSaved={note => onSaved(paymentId, note)}
      />
    </div>
  )
}
