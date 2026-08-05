'use client'

import { useEffect, useId, useRef } from 'react'
import { colors } from '@/lib/tokens'
import { shouldCloseFormModal, resolveTrapTarget, FOCUSABLE_SELECTOR } from '@/lib/ui/modalDismissal'

// The one form-modal shell for Meetings.
//
// Every rule below is the BOE Form Modal Dismissal Rule
// (docs/BOE Master Context/05_Business_Rules.md), decided once in
// src/lib/ui/modalDismissal.ts and never re-decided here:
//
//   * Escape, ✕, Cancel and a SUCCESSFUL save close it.
//   * A backdrop click does NOTHING. Someone mid-way through typing an update
//     during a live meeting must not lose it to a stray click.
//   * A FAILED save keeps the dialog open with every value intact, and shows
//     the error inside the dialog where the reader already is.
//   * The page behind is inert: the overlay swallows pointer events, background
//     scrolling is locked, Tab cannot leave, and focus returns on close.
//
// Layering: .boe-sidebar is `position: fixed; z-index: 100`, so anything below
// that leaves the navigation live behind an apparently-modal dialog. 200/201
// are the established pair.
export const MEETING_MODAL_OVERLAY_Z = 200
export const MEETING_MODAL_DIALOG_Z  = 201

export function MeetingModal({
  title, subtitle, onClose, children, width = 480,
}: {
  title: string
  /** One line of context — which SKU is being updated, which order it is under. */
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
      {/* No click handler. The overlay dims the page and swallows pointer
          events aimed at what is behind it — never dismisses the form. */}
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: MEETING_MODAL_OVERLAY_Z }} />
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
          background: colors.base, borderRadius: '12px', border: `1px solid ${colors.border}`,
          zIndex: MEETING_MODAL_DIALOG_Z, padding: '20px',
          display: 'flex', flexDirection: 'column', gap: '14px',
          outline: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' }}>
          <div style={{ minWidth: 0 }}>
            <div id={titleId} style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>{title}</div>
            {subtitle && (
              <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px', wordBreak: 'break-word' }}>
                {subtitle}
              </div>
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

/**
 * A labelled form field.
 *
 * The caption is the `<label>` element itself and it WRAPS the control, which
 * is what actually associates the two. The previous shape rendered the label as
 * a sibling of `{children}` with no `htmlFor`, so every field in this module was
 * visually labelled and programmatically anonymous — a screen reader announced
 * "edit text, blank" for the update box in the middle of a meeting. Implicit
 * association is used rather than `htmlFor`/`id` because the control is an
 * arbitrary child this component cannot put an id on.
 *
 * `group` opts out for a field whose "control" is several buttons (a status
 * strip, a type picker). A `<label>` may contain at most one labelable element,
 * so those get `role="group"` + `aria-label` instead — the correct construct for
 * a set of related controls under one caption.
 */
export function MeetingField({
  label, children, hint, optional, group,
}: {
  label: string
  children: React.ReactNode
  hint?: string
  optional?: boolean
  /** The field holds a button group or several controls, not one input. */
  group?: boolean
}) {
  const body = (
    <>
      <span style={{
        fontSize: '11px', fontWeight: 600, color: colors.muted,
        textTransform: 'uppercase', letterSpacing: '0.05em',
      }}>
        {label}
        {optional && <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}> (optional)</span>}
      </span>
      {children}
      {hint && <div style={{ fontSize: '11px', color: colors.muted }}>{hint}</div>}
    </>
  )

  const style: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px' }

  if (group) {
    return <div role="group" aria-label={label} style={style}>{body}</div>
  }
  return <label style={style}>{body}</label>
}

/**
 * Cancel + submit.
 *
 * `saving` disables the submit, which is also the duplicate-submit guard — the
 * in-progress state and the guard are the same thing on purpose, so a form
 * cannot show one without the other.
 */
export function MeetingModalActions({
  onClose, onSave, saving, saveLabel, disabled, destructive, secondary,
}: {
  onClose: () => void
  onSave: () => void
  saving: boolean
  saveLabel: string
  disabled?: boolean
  destructive?: boolean
  /** An extra left-aligned action, e.g. "Save & next SKU". */
  secondary?: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'flex-end', paddingTop: '4px', flexWrap: 'wrap' }}>
      {secondary && <div style={{ marginRight: 'auto' }}>{secondary}</div>}
      <button
        onClick={() => { if (shouldCloseFormModal('cancel')) onClose() }}
        className="boe-btn boe-btn-ghost"
        style={{ padding: '8px 16px', fontSize: '13px' }}
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
export function MeetingModalError({ message }: { message: string }) {
  return (
    <div role="alert" style={{
      padding: '10px 12px', borderRadius: '8px',
      background: 'rgba(217,79,79,0.1)', color: '#C13030', fontSize: '12px',
      whiteSpace: 'pre-wrap',
    }}>
      {message}
    </div>
  )
}

/** The shared badge used for every meeting/order/item state. */
export function MeetingBadge({ meta }: { meta: { label: string; bg: string; color: string; border: string } }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: '5px',
      background: meta.bg, color: meta.color, border: `1px solid ${meta.border}`,
      fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {meta.label}
    </span>
  )
}
