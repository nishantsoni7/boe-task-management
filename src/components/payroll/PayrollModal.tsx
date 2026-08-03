'use client'

import { useEffect, useId, useRef } from 'react'
import { colors } from '@/lib/tokens'
import { shouldCloseFormModal, resolveTrapTarget, FOCUSABLE_SELECTOR } from '@/lib/ui/modalDismissal'

// The form-modal shell for Payroll, following the same construction as the
// Assets one (src/components/assets/AssetModal.tsx). Both defer the actual
// policy to src/lib/ui/modalDismissal.ts, so the BOE Form Modal Dismissal Rule
// is stated once and neither module can drift from it:
//
//   * Escape, the ✕ control, Cancel and a SUCCESSFUL save close it.
//   * A backdrop click does nothing at all.
//   * A FAILED save keeps the dialog open with every entered value intact.
//   * The page behind is inert; Tab cannot leave the dialog; focus returns to
//     whatever opened it.
//
// Layering matches the established pair: .boe-sidebar is fixed at z-index 100,
// so anything below that leaves the navigation clickable behind the dialog.
export const PAYROLL_MODAL_OVERLAY_Z = 200
export const PAYROLL_MODAL_DIALOG_Z  = 201

export function PayrollModal({
  title, subtitle, onClose, children, width = 520,
}: {
  title: string
  subtitle?: string
  onClose: () => void
  children: React.ReactNode
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
      {/* Dims the page and swallows clicks aimed at the sidebar behind it.
          Deliberately has no click handler — it never dismisses the form. */}
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: PAYROLL_MODAL_OVERLAY_Z }} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          width: `${width}px`, maxWidth: 'calc(100vw - 24px)',
          maxHeight: 'calc(100vh - 40px)', overflowY: 'auto',
          background: colors.base, borderRadius: 12, border: `1px solid ${colors.border}`,
          zIndex: PAYROLL_MODAL_DIALOG_Z, padding: 22,
          display: 'flex', flexDirection: 'column', gap: 14,
          outline: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <div id={titleId} style={{ fontSize: 15, fontWeight: 700, color: colors.primary }}>{title}</div>
            {subtitle && (
              <div style={{ fontSize: 12, color: colors.tertiary, marginTop: 3 }}>{subtitle}</div>
            )}
          </div>
          <button
            onClick={() => { if (shouldCloseFormModal('close-icon')) onClose() }}
            aria-label="Close"
            className="boe-btn boe-btn-ghost"
            style={{ padding: '4px 10px', fontSize: 13, flexShrink: 0 }}
          >✕</button>
        </div>
        {children}
      </div>
    </>
  )
}

export function PayrollField({
  label, children, hint,
}: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <label style={{
        fontSize: 11, fontWeight: 600, color: colors.muted,
        textTransform: 'uppercase', letterSpacing: '0.05em',
      }}>
        {label}
      </label>
      {children}
      {hint && <div style={{ fontSize: 11, color: colors.muted }}>{hint}</div>}
    </div>
  )
}

/** `saving` both shows progress and blocks a second submit — one state, not two. */
export function PayrollModalActions({
  onClose, onSave, saving, saveLabel, disabled,
}: {
  onClose: () => void
  onSave: () => void
  saving: boolean
  saveLabel: string
  disabled?: boolean
}) {
  return (
    <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 4, flexWrap: 'wrap' }}>
      <button
        onClick={() => { if (shouldCloseFormModal('cancel')) onClose() }}
        className="boe-btn boe-btn-ghost"
        style={{ padding: '8px 18px', fontSize: 13 }}
      >
        Cancel
      </button>
      <button
        onClick={onSave}
        disabled={saving || disabled}
        className="boe-btn boe-btn-primary"
        style={{ padding: '8px 18px', fontSize: 13, opacity: saving || disabled ? 0.6 : 1 }}
      >
        {saving ? 'Saving…' : saveLabel}
      </button>
    </div>
  )
}

/** In-dialog error. A failed save never closes the modal, so this is where it goes. */
export function PayrollModalError({ message }: { message: string }) {
  return (
    <div role="alert" style={{
      padding: '10px 12px', borderRadius: 8,
      background: 'rgba(217,79,79,0.1)', color: '#C13030', fontSize: 12,
    }}>
      {message}
    </div>
  )
}
