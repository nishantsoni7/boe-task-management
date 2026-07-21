'use client'

import { useEffect, useRef } from 'react'
import { colors } from '@/lib/tokens'

// ── Finance modal layering system ────────────────────────────────────────────
// Shared by both Finance pages (Payment Requests and Received Payments). The
// Finance sidebar (.boe-sidebar, globals.css) is `position: fixed;
// z-index: 100`, so every Finance modal overlay/dialog must clear that layer.
// Every Finance modal — compact confirmation or full two-column detail/review
// — uses this single pair; only one Finance modal is ever open at a time, so
// a second tier isn't needed. Do not introduce ad hoc z-index values elsewhere
// in either page — reuse these constants (or the shells below, which already
// apply them).
export const FINANCE_MODAL_OVERLAY_Z = 200
export const FINANCE_MODAL_DIALOG_Z  = 201

// Locks background scroll and wires Escape-to-close for the lifetime of any
// Finance modal. Scroll state is restored on close/unmount.
export function useModalScrollLockAndEscape(onClose: () => void) {
  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
}

// ── Compact modal shell ───────────────────────────────────────────────────────
// For confirmations and small forms (edit, delete, link/unlink, new-request).
// Callers keep their own field/body content; this only standardizes the
// overlay, frame, header, and close control.
export function FinanceModal({
  title,
  onClose,
  children,
  width = '480px',
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  width?: string
}) {
  useModalScrollLockAndEscape(onClose)
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: FINANCE_MODAL_OVERLAY_Z }} />
      <div style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        width, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto',
        background: colors.base, borderRadius: '12px', border: `1px solid ${colors.border}`,
        zIndex: FINANCE_MODAL_DIALOG_Z, padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>{title}</div>
          <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '13px' }}>✕</button>
        </div>
        {children}
      </div>
    </>
  )
}

// ── Full request detail/review modal shell ───────────────────────────────────
// Common overlay + dialog frame for the two-column Payment Request modals
// (Payment Requests' view/review, Received Payments' view). Both render the
// same header (request number, submitted line, status badge, close) and the
// same scrollable two-zone body (left ≈56%, right ≈44%, wrapping to a stacked
// single column on narrow viewports) — only the zone contents differ per
// caller. The status badge is accepted pre-rendered so this shell never needs
// to know either page's status-label/colour mapping.
export function RequestModalShell({
  requestNumber,
  submittedLine,
  statusBadge,
  onClose,
  left,
  right,
  ariaLabel,
  top,
  bottom,
  footer,
  width = '880px',
}: {
  requestNumber: string
  submittedLine: React.ReactNode
  statusBadge: React.ReactNode
  onClose: () => void
  left: React.ReactNode
  right: React.ReactNode
  ariaLabel?: string
  // Optional full-width zones rendered inside the same scroll container:
  // `top` above the two columns (summary strips), `bottom` below them
  // (context/history blocks that must span both columns).
  top?: React.ReactNode
  bottom?: React.ReactNode
  // Optional non-scrolling action bar pinned below the body. Callers that
  // don't pass it get the exact previous layout.
  footer?: React.ReactNode
  // Dialog width. Defaults to the Finance modals' original 880px.
  width?: string
}) {
  useModalScrollLockAndEscape(onClose)
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => { dialogRef.current?.focus() }, [])

  return (
    <>
      {/* Overlay */}
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: FINANCE_MODAL_OVERLAY_Z }} />

      {/* Dialog */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? `Payment request ${requestNumber}`}
        tabIndex={-1}
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          width, maxWidth: 'calc(100vw - 24px)', maxHeight: '88vh',
          background: colors.base, borderRadius: '12px', border: `1px solid ${colors.border}`,
          boxShadow: '0 12px 40px rgba(0,0,0,0.16)',
          zIndex: FINANCE_MODAL_DIALOG_Z, display: 'flex', flexDirection: 'column', overflow: 'hidden', outline: 'none',
        }}
      >
        {/* ── Sticky header — request number is the primary identifier ── */}
        <div style={{
          padding: '15px 20px', borderBottom: `1px solid ${colors.border}`,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexShrink: 0,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '19px', fontWeight: 700, color: colors.primary, wordBreak: 'break-word', lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' }}>
              {requestNumber}
            </div>
            <div style={{ fontSize: '12.5px', color: colors.tertiary, marginTop: '4px', wordBreak: 'break-word' }}>
              {submittedLine}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
            {statusBadge}
            <button onClick={onClose} aria-label="Close" className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '13px' }}>✕</button>
          </div>
        </div>

        {/* ── Scrollable body — single scroll container holding a two-zone workspace.
            On desktop the two zones sit side by side (left ≈56%, right ≈44%); when
            the modal is too narrow they wrap and stack in DOM order.

            Every direct child is flexShrink: 0. This container is a column flex
            box, so its children are shrinkable by default — and a child that
            sets `overflow: hidden` (the rounded, clipped summary/table cards the
            callers pass in `top` and `bottom`) also loses its automatic minimum
            size, which lets flexbox squash it to a few pixels instead of letting
            this container scroll. That silently blanked the Order Request
            summary strip whenever the content was taller than the dialog.
            Pinning the children at their natural height is what makes
            `overflowY: auto` above actually take effect. ── */}
        <div style={{ padding: '18px 20px', overflowY: 'auto', overflowX: 'hidden', flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {top && <div style={{ flexShrink: 0 }}>{top}</div>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px', alignItems: 'flex-start', flexShrink: 0 }}>
            <div style={{ flex: '56 1 360px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {left}
            </div>
            <div style={{ flex: '44 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {right}
            </div>
          </div>
          {bottom && <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '16px' }}>{bottom}</div>}
        </div>

        {/* ── Optional pinned action bar — always reachable while the body scrolls ── */}
        {footer && (
          <div style={{ padding: '12px 20px', borderTop: `1px solid ${colors.border}`, flexShrink: 0, background: colors.base }}>
            {footer}
          </div>
        )}
      </div>
    </>
  )
}
