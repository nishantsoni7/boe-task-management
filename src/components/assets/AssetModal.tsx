'use client'

import { useEffect, useId, useRef } from 'react'
import { colors } from '@/lib/tokens'
import { shouldCloseFormModal, resolveTrapTarget, FOCUSABLE_SELECTOR } from '@/lib/ui/modalDismissal'

// The one form-modal shell for Assets & Access.
//
// Extracted from the inventory page so the inventory screen and the asset
// detail page cannot end up with two dialogs that behave differently — which is
// exactly how the original defects appeared. Every rule below is the BOE Form
// Modal Dismissal Rule (docs/BOE Master Context/05_Business_Rules.md), stated
// once here and decided in src/lib/ui/modalDismissal.ts:
//
//   * Escape, the ✕ control, Cancel and a SUCCESSFUL save close it.
//   * A backdrop click does NOTHING. Not "close after confirming", not "close
//     if untouched" — nothing. A user can spend real time in these forms and an
//     accidental click must never discard it.
//   * A FAILED save keeps the modal open with every entered value intact, and
//     shows the error inside the dialog where the reader is already looking.
//   * The page behind is inert: the overlay swallows pointer events, background
//     scrolling is locked, and Tab cannot leave the dialog.
//   * Focus enters on open and returns to whatever opened it on close.
//
// Layering: .boe-sidebar is `position: fixed; z-index: 100` (globals.css). A
// shell at 59/60 renders UNDER it and leaves the navigation live and clickable
// behind an apparently-modal dialog — the original bug. These are the Finance
// modal constants, the established "clears the sidebar" pair. None of
// .boe-app-shell / .boe-main-content / .boe-page-body creates a stacking
// context, so a fixed child at 200 really is above 100.
export const ASSETS_MODAL_OVERLAY_Z = 200
export const ASSETS_MODAL_DIALOG_Z  = 201

export function AssetModal({
  title, onClose, children, width = 440,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  /** Wider for the multi-field forms (service records, warranty details). */
  width?: number
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    return () => {
      document.body.style.overflow = prevOverflow
      previouslyFocused?.focus?.()
    }
  }, [])

  // Escape closes; Tab and Shift+Tab cannot leave the dialog. Capture phase so
  // the trap runs before anything inside the dialog handles the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (shouldCloseFormModal('escape')) onClose()
        return
      }
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

  return (
    <>
      {/* Overlay: no click handler at all. It exists to dim the page and to
          swallow pointer events aimed at the sidebar and the page behind it —
          never to dismiss the form. */}
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: ASSETS_MODAL_OVERLAY_Z }} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          width: `${width}px`, maxWidth: 'calc(100vw - 32px)',
          maxHeight: 'calc(100vh - 48px)', overflowY: 'auto',
          background: colors.base, borderRadius: '12px', border: `1px solid ${colors.border}`,
          zIndex: ASSETS_MODAL_DIALOG_Z, padding: '24px',
          display: 'flex', flexDirection: 'column', gap: '14px',
          outline: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
          <div id={titleId} style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>{title}</div>
          <button
            onClick={() => { if (shouldCloseFormModal('close-icon')) onClose() }}
            aria-label="Close"
            className="boe-btn boe-btn-ghost"
            style={{ padding: '4px 10px', fontSize: '13px', flexShrink: 0 }}
          >✕</button>
        </div>
        {children}
      </div>
    </>
  )
}

export function AssetField({
  label, children, hint,
}: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <label style={{
        fontSize: '11px', fontWeight: 600, color: colors.muted,
        textTransform: 'uppercase', letterSpacing: '0.05em',
      }}>
        {label}
      </label>
      {children}
      {hint && <div style={{ fontSize: '11px', color: colors.muted }}>{hint}</div>}
    </div>
  )
}

/**
 * Cancel + submit.
 *
 * `saving` disables the submit button, which is what stops a double-click from
 * firing two writes — the in-progress state and the duplicate-submit guard are
 * the same thing on purpose, so a form cannot show one without the other.
 *
 * `destructive` restyles the submit for an action that cannot be undone. It is
 * a visual distinction, not a second confirmation step: the modal itself is the
 * confirmation, and stacking a window.confirm on top of a form the user
 * deliberately opened is friction, not safety.
 */
export function AssetModalActions({
  onClose, onSave, saving, saveLabel, destructive, disabled,
}: {
  onClose: () => void
  onSave: () => void
  saving: boolean
  saveLabel: string
  destructive?: boolean
  disabled?: boolean
}) {
  return (
    <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
      <button
        onClick={() => { if (shouldCloseFormModal('cancel')) onClose() }}
        className="boe-btn boe-btn-ghost"
        style={{ padding: '8px 18px', fontSize: '13px' }}
      >
        Cancel
      </button>
      <button
        onClick={onSave}
        disabled={saving || disabled}
        className={`boe-btn ${destructive ? 'boe-btn-ghost' : 'boe-btn-primary'}`}
        style={{
          padding: '8px 18px', fontSize: '13px',
          ...(destructive
            ? { color: '#C13030', borderColor: 'rgba(217,79,79,0.45)', fontWeight: 600 }
            : {}),
          opacity: saving || disabled ? 0.6 : 1,
        }}
      >
        {saving ? 'Saving…' : saveLabel}
      </button>
    </div>
  )
}

/** In-dialog error. Stays inside the modal, where the reader already is. */
export function AssetModalError({ message }: { message: string }) {
  return (
    <div role="alert" style={{
      padding: '10px 12px', borderRadius: '8px',
      background: 'rgba(217,79,79,0.1)', color: '#C13030', fontSize: '12px',
    }}>
      {message}
    </div>
  )
}
