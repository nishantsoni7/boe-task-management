'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

/**
 * THE ONE PHONE BOTTOM SHEET (owner, 2026-11-05, "one Filter sheet, not four").
 *
 * Confirmed Orders drew the first phone Filter sheet (2026-11-04); Tasks,
 * Sales and Attendance each copied it. This is that sheet once: a backdrop, a
 * dialog panel with its title, an optional "Clear all", Close, and one footer
 * button whose words the caller gives ("Show 12 tasks", "Search", "Done").
 *
 * It is drawn only while open (the caller mounts it), takes focus when it
 * opens, and closes on Escape, the backdrop or Close. The look is the
 * `orders-sheet*` rules in globals.css; a caller may add its own class to the
 * panel (`p3-sheet`, an Attendance module class) so each list keeps its look.
 */
export function BottomSheet({
  title, onClose, onClearAll, doneLabel, onDone, className = 'orders-sheet', children,
}: {
  /** The heading, also the dialog's name for a screen reader. */
  title: string
  onClose: () => void
  /** Offered as "Clear all" in the head when given. */
  onClearAll?: () => void
  /** The footer button: "Show 12 tasks", "Done". */
  doneLabel: ReactNode
  /** Runs when the footer button is pressed, before the sheet closes. */
  onDone?: () => void
  /** The panel's classes; the default is the shared look. */
  className?: string
  children?: ReactNode
}) {
  const panel = useRef<HTMLDivElement | null>(null)

  // Focus once, when the sheet opens; a later render must not take focus
  // from a field inside it.
  useEffect(() => { panel.current?.focus() }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <div className="orders-sheet-backdrop" onClick={onClose} />
      <div ref={panel} className={className} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="orders-sheet-head">
          <h2>{title}</h2>
          {onClearAll && <button type="button" className="orders-sheet-clear" onClick={onClearAll}>Clear all</button>}
          <button type="button" className="orders-sheet-close" aria-label="Close" onClick={onClose}>
            <X size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        {children}
        <button type="button" className="boe-btn boe-btn-primary orders-sheet-apply" onClick={() => { onDone?.(); onClose() }}>
          {doneLabel}
        </button>
      </div>
    </>
  )
}

/**
 * The button that opens a sheet: its words, an optional icon, and a badge with
 * how many settings inside are set. `baseClassName` is the look
 * (`orders-phone-filter` and whatever the list adds); `is-set` follows it when
 * the badge shows, then `className`.
 */
export function SheetTrigger({
  label, icon, badge = 0, ariaLabel = label, open, onOpen, baseClassName = 'orders-phone-filter', className,
}: {
  label: string
  icon?: ReactNode
  badge?: number
  /** The name a screen reader hears; ", 2 set" is added when the badge shows. */
  ariaLabel?: string
  open: boolean
  onOpen: () => void
  baseClassName?: string
  className?: string
}) {
  return (
    <button
      type="button"
      className={`${baseClassName}${badge > 0 ? ' is-set' : ''}${className ? ` ${className}` : ''}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={badge > 0 ? `${ariaLabel}, ${badge} set` : ariaLabel}
      onClick={onOpen}
    >
      {icon}
      {label}
      {badge > 0 && <span className="orders-phone-filter-badge" aria-hidden="true">{badge}</span>}
    </button>
  )
}
