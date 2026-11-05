'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { SlidersHorizontal, X } from 'lucide-react'
import type { PhoneFilterGroup } from '@/app/orders/all/PhoneListControls'

/**
 * ONE FILTER BUTTON ON A PHONE (owner, 2026-11-05, Phase 3: Sales, Leads,
 * Vendors, Showroom, Reviews, SEO, Marketing).
 *
 * The same control as Confirmed Orders' PhoneFilterButton (the same look, the
 * same `orders-sheet` styles), for lists that are not Orders: the result
 * button names the list's own rows ("Show 12 leads"), and a page can put its
 * own controls (a date input, a long select) into the sheet as children.
 *
 * The button is drawn on a phone only (`boe-phone-only`); a desktop keeps the
 * page's own filters. Every choice calls the page's own setter, so the
 * filter is the same URL / state the desktop controls write.
 */
export function PhoneFilterSheet({
  activeCount, groups = [], resultLabel, onClearAll, children, title = 'Filter', initiallyOpen = false,
}: {
  /** How many of the sheet's filters are set: drawn as a badge. */
  activeCount: number
  groups?: PhoneFilterGroup[]
  /** The apply button: "Show 12 leads". Every choice applies at once. */
  resultLabel: string
  onClearAll?: () => void
  /** Extra controls under the option groups. */
  children?: ReactNode
  title?: string
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

  return (
    <>
      <button
        type="button"
        className={`boe-phone-only orders-phone-filter p3-filter${activeCount > 0 ? ' is-set' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={activeCount > 0 ? `${title}, ${activeCount} set` : title}
        onClick={() => setOpen(true)}
      >
        <SlidersHorizontal size={16} strokeWidth={2} aria-hidden="true" />
        Filter
        {activeCount > 0 && <span className="orders-phone-filter-badge" aria-hidden="true">{activeCount}</span>}
      </button>
      {open && (
        <>
          <div className="orders-sheet-backdrop" onClick={() => setOpen(false)} />
          <div ref={panel} className="orders-sheet p3-sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
            <div className="orders-sheet-head">
              <h2>{title}</h2>
              {onClearAll && <button type="button" className="orders-sheet-clear" onClick={onClearAll}>Clear all</button>}
              <button type="button" className="orders-sheet-close" aria-label="Close" onClick={() => setOpen(false)}>
                <X size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
            {groups.map(g => (
              <div key={g.id} className="orders-sheet-group" role="group" aria-labelledby={`p3-sheet-${g.id}`}>
                <div id={`p3-sheet-${g.id}`} className="orders-sheet-label">{g.label}</div>
                <div className="orders-sheet-options">
                  {g.options.map(o => (
                    <button key={o.value} type="button" aria-pressed={g.value === o.value} onClick={() => g.onChange(o.value)}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {children}
            <button type="button" className="boe-btn boe-btn-primary orders-sheet-apply" onClick={() => setOpen(false)}>
              {resultLabel}
            </button>
          </div>
        </>
      )}
    </>
  )
}

/** A labelled block of the sheet for a page's own control (a select, a date input). */
export function PhoneSheetField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="orders-sheet-group p3-sheet-field">
      <div className="orders-sheet-label">{label}</div>
      {children}
    </div>
  )
}

/** A group of the sheet where several options can be on at once (Vendors' Expertise, Area...). */
export function PhoneMultiGroup({ id, label, options, value, onChange, emptyText }: {
  id: string
  label: string
  options: readonly { readonly value: string; readonly label: string }[]
  value: readonly string[]
  onChange: (next: string[]) => void
  emptyText?: string
}) {
  return (
    <div className="orders-sheet-group" role="group" aria-labelledby={`p3-sheet-${id}`}>
      <div id={`p3-sheet-${id}`} className="orders-sheet-label">{label}</div>
      <div className="orders-sheet-options">
        {options.length === 0 && emptyText && <span className="p3-sheet-empty">{emptyText}</span>}
        {options.map(o => {
          const on = value.includes(o.value)
          return (
            <button key={o.value} type="button" aria-pressed={on}
                    onClick={() => onChange(on ? value.filter(v => v !== o.value) : [...value, o.value])}>
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
