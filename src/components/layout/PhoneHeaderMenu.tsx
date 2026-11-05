'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MoreHorizontal, Plus, X } from 'lucide-react'

/**
 * THE PHONE HEADER MENU (owner, 2026-11-05, "phones: content first").
 *
 * Below 768px every module header is one row: the menu button, the title with
 * one short line under it, and icon buttons. The few actions a LAYOUT adds to
 * every page of its module (Hand over cash in Finance, Self Task and Delegate
 * Task in Task Management) would push that row onto a second line, so on a
 * phone they move into this menu: a "⋯" or "+" button that opens a sheet from
 * the bottom of the screen. On a desktop the button is hidden (CSS,
 * `.boe-phone-only`) and the layout keeps drawing the full buttons
 * (`.boe-desktop-only`).
 *
 * Each item is a plain callback the layout already had (open a dialog, go to a
 * route), so nothing is rendered twice and no dialog lives inside the sheet.
 */
export type PhoneMenuItem = {
  key: string
  label: string
  icon?: ReactNode
  /** The main action is drawn filled, the rest plain. */
  primary?: boolean
  onSelect: () => void
}

export function PhoneHeaderMenu({ label, kind = 'more', items, initiallyOpen = false }: {
  /** What the button and the sheet are called: "More actions", "New task". */
  label: string
  kind?: 'more' | 'add'
  items: PhoneMenuItem[]
  /** Tests only: draw the sheet open. */
  initiallyOpen?: boolean
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

  if (items.length === 0) return null

  return (
    <>
      <button
        type="button"
        className={`boe-phone-only boe-header-icon${kind === 'add' ? ' boe-header-icon--add' : ''}`}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {kind === 'add'
          ? <Plus size={20} strokeWidth={2.2} aria-hidden="true" />
          : <MoreHorizontal size={20} strokeWidth={2} aria-hidden="true" />}
      </button>
      {open && (
        <>
          <div className="boe-psheet-backdrop" onClick={() => setOpen(false)} />
          <div ref={panel} className="boe-psheet" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
            <div className="boe-psheet-head">
              <h2>{label}</h2>
              <button type="button" className="boe-psheet-close" aria-label="Close" onClick={() => setOpen(false)}>
                <X size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
            <div className="boe-psheet-menu">
              {items.map(item => (
                <button
                  key={item.key}
                  type="button"
                  className={item.primary ? 'boe-psheet-item is-primary' : 'boe-psheet-item'}
                  onClick={() => { setOpen(false); item.onSelect() }}
                >
                  {item.icon && <span className="boe-psheet-item-icon" aria-hidden="true">{item.icon}</span>}
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  )
}
