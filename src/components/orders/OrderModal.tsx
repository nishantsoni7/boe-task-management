'use client'

import { useEffect, useId, useRef } from 'react'
import { colors } from '@/lib/tokens'
import { shouldCloseFormModal, resolveTrapTarget, FOCUSABLE_SELECTOR } from '@/lib/ui/modalDismissal'

// The form-modal shell for Order Management.
//
// Third instance of the same shape, after FinanceModal (Finance) and AssetModal
// (Assets & Access). The duplication is per-module by convention in this
// codebase, but the RULE is not duplicated: every decision below is made in
// src/lib/ui/modalDismissal.ts, which is the single source of truth for the BOE
// Form Modal Dismissal Rule (docs/BOE Master Context/05_Business_Rules.md).
//
//   * Escape, the ✕ control, Cancel and a SUCCESSFUL save close it.
//   * A backdrop click does NOTHING. The overlay carries no click handler at
//     all — it exists to dim the page and swallow pointer events aimed at the
//     sidebar behind it. An amendment form holds typed values and a reason; an
//     accidental click must never discard them.
//   * A FAILED save keeps the modal open with every entered value intact, and
//     shows the error inside the dialog.
//   * The page behind is inert: background scrolling is locked and Tab cannot
//     leave the dialog.
//   * Focus enters on open and returns to whatever opened it on close.
//
// Layering: .boe-sidebar is `position: fixed; z-index: 100` (globals.css), so a
// shell below that leaves the navigation live behind an apparently-modal
// dialog. 200/201 is the established "clears the sidebar" pair.
export const ORDERS_MODAL_OVERLAY_Z = 200
export const ORDERS_MODAL_DIALOG_Z  = 201

export function OrderModal({
  title, subtitle, onClose, children, width = 460,
}: {
  title: string
  subtitle?: string
  onClose: () => void
  children: React.ReactNode
  /** Wider for the multi-field amend form. */
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

  // Escape closes; Tab and Shift+Tab cannot leave the dialog. Capture phase, so
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
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: ORDERS_MODAL_OVERLAY_Z }} />
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
          zIndex: ORDERS_MODAL_DIALOG_Z, padding: '24px',
          display: 'flex', flexDirection: 'column', gap: '14px',
          outline: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' }}>
          <div style={{ minWidth: 0 }}>
            <div id={titleId} style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>{title}</div>
            {subtitle && (
              <div style={{ fontSize: '12px', color: colors.tertiary, marginTop: '3px' }}>{subtitle}</div>
            )}
          </div>
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

export function OrderField({
  label, children, hint, error,
}: { label: string; children: React.ReactNode; hint?: string; error?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <label style={{
        fontSize: '11px', fontWeight: 600, color: colors.muted,
        textTransform: 'uppercase', letterSpacing: '0.05em',
      }}>
        {label}
      </label>
      {children}
      {error
        ? <div style={{ fontSize: '11px', color: '#C13030' }}>{error}</div>
        : hint && <div style={{ fontSize: '11px', color: colors.muted }}>{hint}</div>}
    </div>
  )
}

/**
 * Cancel + submit.
 *
 * `saving` disables the submit button, which is what stops a double-click from
 * firing two writes — the in-progress state and the duplicate-submit guard are
 * the same thing on purpose, so a form cannot show one without the other.
 */
export function OrderModalActions({
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
    <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px', flexWrap: 'wrap' }}>
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
export function OrderModalError({ message }: { message: string }) {
  return (
    <div role="alert" style={{
      padding: '10px 12px', borderRadius: '8px',
      background: 'rgba(217,79,79,0.1)', color: '#C13030', fontSize: '12px', lineHeight: 1.5,
    }}>
      {message}
    </div>
  )
}

/** A neutral in-dialog notice — used to state the money position before a cancellation. */
export function OrderModalNotice({ tone = 'info', children }: {
  tone?: 'info' | 'warning'
  children: React.ReactNode
}) {
  const palette = tone === 'warning'
    ? { bg: 'rgba(217,119,6,0.10)', fg: '#92400E' }
    : { bg: colors.raised, fg: colors.secondary }
  return (
    <div style={{
      padding: '10px 12px', borderRadius: '8px',
      background: palette.bg, color: palette.fg, fontSize: '12px', lineHeight: 1.55,
    }}>
      {children}
    </div>
  )
}
