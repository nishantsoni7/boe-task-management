'use client'

// A button that opens a sheet from the bottom of the screen, for the
// Attendance & Payroll pages on a phone (owner, 2026-11-05, "phones: content
// first"). Filters with date fields, an "Add holiday" form, or a page's
// downloads go in here so the list starts on the first screen.
//
// It reuses the look of the Confirmed Orders filter sheet (the `.orders-sheet*`
// and `.orders-phone-filter` rules in globals.css, see
// app/orders/all/PhoneListControls.tsx) so every module's sheet is the same
// sheet. Unlike that one, it takes any content: the page passes its own
// controls, wired to the same state the desktop controls use, so a filter set
// on a phone is the same filter on a desktop.
//
// Presentation only. The trigger is drawn on a phone alone (ui.phoneOnly);
// the desktop keeps its inline controls.

import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import styles from './ui.module.css'

export function PhoneSheet({
  label, icon, badge = 0, title, doneLabel = 'Done', onDone, onClear, children, initiallyOpen = false, className,
}: {
  /** The trigger's text, e.g. "Filter". */
  label: string
  icon?: React.ReactNode
  /** How many settings inside are not at their default; drawn as a dot count. */
  badge?: number
  /** The sheet's heading, e.g. "Filter and sort". */
  title: string
  doneLabel?: string
  /** Runs when the sheet's main button is pressed, before it closes (e.g. Search). */
  onDone?: () => void
  /** Offered as "Clear all" in the sheet's head when given. */
  onClear?: () => void
  children: React.ReactNode
  /** Tests only: draw the sheet open. */
  initiallyOpen?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(initiallyOpen)
  const panel = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    panel.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      <button
        type="button"
        className={`orders-phone-filter ${styles.phoneOnly} ${styles.sheetTrigger}${badge > 0 ? ' is-set' : ''}${className ? ` ${className}` : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={badge > 0 ? `${label}, ${badge} set` : label}
        onClick={() => setOpen(true)}
      >
        {icon}
        {label}
        {badge > 0 && <span className="orders-phone-filter-badge" aria-hidden="true">{badge}</span>}
      </button>
      {open && (
        <>
          <div className="orders-sheet-backdrop" onClick={() => setOpen(false)} />
          <div
            ref={panel}
            className={`orders-sheet ${styles.sheet}`}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
          >
            <div className="orders-sheet-head">
              <h2>{title}</h2>
              {onClear && <button type="button" className="orders-sheet-clear" onClick={onClear}>Clear all</button>}
              <button type="button" className="orders-sheet-close" aria-label="Close" onClick={() => setOpen(false)}>
                <X size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
            {children}
            <button type="button" className="boe-btn boe-btn-primary orders-sheet-apply" onClick={() => { onDone?.(); setOpen(false) }}>
              {doneLabel}
            </button>
          </div>
        </>
      )}
    </>
  )
}
