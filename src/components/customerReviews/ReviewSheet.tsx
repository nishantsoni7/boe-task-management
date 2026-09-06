'use client'

import { useCallback, useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { colors } from '@/lib/tokens'

// ── The module's one dialog ───────────────────────────────────────────────────
//
// A BOTTOM SHEET ON A PHONE AND A CENTRED DIALOG ON A DESKTOP, and it is the
// same element in both: .boe-modal-overlay / .boe-modal-sheet in globals.css
// already do exactly that — `align-items: flex-end` with square top corners
// below 640px, centred with a full radius above it. No new visual language and
// no second set of classes; this component wires behaviour to the styling that
// is already there.
//
// WHY IT IS HERE AND NOT SHARED. Finance has an equivalent shell
// (src/app/finance/components/FinanceModalShell.tsx) with the same three
// behaviours, and importing it would make this module depend on a Finance page
// module — the one thing CustomerReviewsLayout says it does not do. It is also
// a desktop-centred dialog rather than a sheet, and this workflow is primarily
// used from a phone. Copying ~60 lines of focus handling is the cheaper of the
// two mistakes available, and no shared component was changed to make it work.
//
// THREE BEHAVIOURS, AND THEY ARE THE ACCESSIBILITY OF THE THING:
//
//   1. ON OPEN, FOCUS MOVES IN. A keyboard or screen-reader user is inside the
//      dialog rather than still on the list behind it.
//   2. WHILE OPEN, TAB CYCLES WITHIN IT. A dialog whose focus can walk out onto
//      the page underneath is not modal to anybody navigating by keyboard.
//   3. ON CLOSE, FOCUS RETURNS TO WHATEVER OPENED IT — and only if that control
//      is still in the document, because the row a dialog's own action removed
//      cannot be focused and trying would drop focus onto <body>.
//
// The trap moves focus and nothing else. It is an accessibility affordance, not
// a security boundary: nothing below it depends on focus staying put.
//
// ESCAPE CLOSES, AND A BACKDROP CLICK MAY NOT. `dismissOnBackdrop` defaults to
// true; a sheet holding typed guidance passes false, which is the BOE form
// modal rule — a stray tap outside never discards what somebody wrote, while
// Escape and the × still close.

export function ReviewSheet({
  title,
  subtitle,
  onClose,
  children,
  footer,
  maxWidth = '480px',
  dismissOnBackdrop = true,
}: {
  title: string
  subtitle?: string
  onClose: () => void
  children: React.ReactNode
  /**
   * Pinned to the bottom of the sheet and always visible.
   *
   * The primary action of a full-height sheet on a phone is otherwise below a
   * long review body, which means scrolling to the end before you can act. A
   * sticky footer is the difference between one thumb movement and four.
   */
  footer?: React.ReactNode
  maxWidth?: string
  dismissOnBackdrop?: boolean
}) {
  const dialogRef = useRef<HTMLDivElement>(null)

  // Escape, and the background does not scroll behind the sheet.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [onClose])

  // Focus in, focus cycling, focus back.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const root = dialogRef.current
      if (!root) return
      const focusable = Array.from(root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),'
        + ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter(el => el.offsetParent !== null || el === document.activeElement)
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement

      if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault(); last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault(); first.focus()
      }
    }

    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (opener && document.contains(opener)) opener.focus()
    }
  }, [])

  const onBackdrop = useCallback((e: React.MouseEvent) => {
    if (!dismissOnBackdrop) return
    if (e.target === e.currentTarget) onClose()
  }, [dismissOnBackdrop, onClose])

  return (
    <div className="boe-modal-overlay" onClick={onBackdrop}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="boe-modal-sheet"
        style={{
          maxWidth,
          maxHeight: 'calc(100vh - 24px)',
          display: 'flex',
          flexDirection: 'column',
          // The sheet scrolls its BODY rather than itself, so a sticky footer
          // stays put instead of scrolling away with the content.
          overflow: 'hidden',
        }}
      >
        <div className="boe-modal-header" style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{
              margin: 0, fontSize: '14px', fontWeight: 700, color: colors.primary,
              lineHeight: 1.35, overflowWrap: 'anywhere',
            }}>
              {title}
            </h2>
            {subtitle && (
              <p style={{
                margin: '3px 0 0', fontSize: '11px', color: colors.tertiary,
                lineHeight: 1.4, overflowWrap: 'anywhere',
              }}>
                {subtitle}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            // 44px, like every other control here. A close button is the one a
            // person reaches for when they have changed their mind, and a
            // 32px target on a phone is one they miss and then press again —
            // on whatever is underneath it.
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: '44px', height: '44px', flexShrink: 0,
              borderRadius: '8px', border: `1px solid ${colors.border}`,
              background: 'transparent', color: colors.tertiary, cursor: 'pointer',
            }}
          >
            <X size={15} strokeWidth={2} />
          </button>
        </div>

        <div className="boe-modal-body" style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
          {children}
        </div>

        {footer && (
          <div style={{
            padding: '12px 16px',
            borderTop: `1px solid ${colors.border}`,
            background: '#FFFFFF',
            display: 'flex', gap: '8px', flexWrap: 'wrap',
            // Clears the home indicator on a phone without affecting a desktop.
            paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
          }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
