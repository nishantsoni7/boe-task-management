'use client'

// ── Not losing what somebody typed ───────────────────────────────────────────
//
// THE RULE, for every payment-entry modal:
//
//   backdrop click   does nothing, ever
//   Escape, pristine closes
//   Escape, dirty    asks
//   ✕ / Cancel, dirty asks
//   successful save  closes, and the state goes with it
//
// WHY BACKDROP IS ABSOLUTE AND ESCAPE IS NOT. A backdrop click is frequently an
// accident — a missed target, a stray click while reading — and there is no
// version of it that means "throw this away". Escape is deliberate: nobody
// presses it by mistake. So an empty form obeys it immediately, and a form with
// work in it gets one question first.
//
// NOTHING IS PERSISTED. No draft, no proof object, no confirmation field
// reaches localStorage or sessionStorage: a half-entered payment is not
// something to leave lying in a browser, and a proof file is not serialisable
// in any case. Cancelling loses the entry, which is what the question is for.

import { useCallback, useEffect, useRef, useState } from 'react'
import { colors } from '@/lib/tokens'

export const DISCARD_TITLE   = 'Discard payment details?'
export const DISCARD_MESSAGE = 'The information entered in this form will be lost.'
export const DISCARD_KEEP    = 'Continue Editing'
export const DISCARD_CONFIRM = 'Discard'

/**
 * Wires the close rules for one form modal.
 *
 * `isDirty` is a function rather than a value so the handler always asks the
 * CURRENT form, not the state captured when the listener was attached — the
 * bug that makes a stale-closure guard let a full form close silently.
 */
export function useDiscardGuard({
  isDirty, onClose, disabled,
}: {
  isDirty: () => boolean
  onClose: () => void
  /** True while submitting: closing is refused outright, not merely questioned. */
  disabled?: boolean
}) {
  const [asking, setAsking] = useState(false)

  // THE LATEST FORM, NOT THE ONE THE LISTENER WAS BORN WITH. `isDirty` is a new
  // closure on every render; keeping the newest one in a ref is what stops the
  // Escape handler from asking a form that no longer exists — the stale-closure
  // bug that lets a full form close silently. Written in an effect rather than
  // during render because a ref written during render is not a render output.
  const dirtyRef = useRef(isDirty)
  useEffect(() => { dirtyRef.current = isDirty })

  /** What ✕ and Cancel call. */
  const requestClose = useCallback(() => {
    if (disabled) return
    if (dirtyRef.current()) { setAsking(true); return }
    onClose()
  }, [disabled, onClose])

  /** What a successful submit calls: no question, and the modal is done. */
  const closeAfterSuccess = useCallback(() => {
    setAsking(false)
    onClose()
  }, [onClose])

  const keepEditing = useCallback(() => setAsking(false), [])
  const discard     = useCallback(() => { setAsking(false); onClose() }, [onClose])

  // Escape, and nothing else. The listener sits on the window because the
  // dialog owns the whole screen while it is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // While the question is up, Escape answers it the safe way.
      if (asking) { e.stopPropagation(); setAsking(false); return }
      e.stopPropagation()
      requestClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [asking, requestClose])

  return { asking, requestClose, closeAfterSuccess, keepEditing, discard }
}

/**
 * The question itself.
 *
 * Rendered ABOVE the form it guards and focused on open, so the answer is where
 * the eye already is. Continue Editing is the default and the first thing
 * focused: the safe answer should be the easy one.
 */
export function DiscardConfirmation({
  open, onKeepEditing, onDiscard,
}: {
  open: boolean
  onKeepEditing: () => void
  onDiscard: () => void
}) {
  const keepRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { if (open) keepRef.current?.focus() }, [open])
  if (!open) return null

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="boe-discard-title"
      aria-describedby="boe-discard-message"
      style={{
        position: 'fixed', inset: 0, zIndex: 2147483000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
      }}
    >
      {/* Inert: this backdrop closes nothing either. The question has two
          answers and clicking past it is not one of them. */}
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)' }} />
      <div style={{
        position: 'relative', background: '#FFFFFF', borderRadius: '12px',
        padding: '20px', width: '100%', maxWidth: '360px',
        boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
      }}>
        <h2 id="boe-discard-title" style={{
          margin: '0 0 8px', fontSize: '15px', fontWeight: 700, color: colors.primary,
        }}>{DISCARD_TITLE}</h2>
        <p id="boe-discard-message" style={{
          margin: '0 0 16px', fontSize: '13px', color: colors.secondary, lineHeight: 1.5,
        }}>{DISCARD_MESSAGE}</p>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button ref={keepRef} type="button" onClick={onKeepEditing}
                  className="boe-btn boe-btn-ghost"
                  style={{ padding: '8px 14px', fontSize: '13px' }}>
            {DISCARD_KEEP}
          </button>
          <button type="button" onClick={onDiscard}
                  className="boe-btn boe-btn-danger"
                  style={{ padding: '8px 14px', fontSize: '13px' }}>
            {DISCARD_CONFIRM}
          </button>
        </div>
      </div>
    </div>
  )
}
