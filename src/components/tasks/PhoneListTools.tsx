'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { SlidersHorizontal, X } from 'lucide-react'

/**
 * PHONE LIST TOOLS FOR TASKS, MEETINGS AND ADMIN (owner, 2026-11-05, phone
 * phase 3, "content first").
 *
 * The same shape as Confirmed Orders on a phone (app/orders/all/
 * PhoneListControls.tsx): one row of chips that scrolls sideways, then the
 * search box and ONE Filter button whose bottom sheet holds the rest. It reuses
 * that design's classes (`orders-phone-chip`, `orders-sheet…`) so every list
 * looks the same, but names its own things: the chip group's label and the
 * noun on the sheet's "Show 12 tasks" button (the Orders component says
 * "orders" and "Order status", which would be wrong here).
 *
 * Presentation only. Every choice calls the setter the page already had, so a
 * filter set on a phone is the same filter on a desktop.
 */

export type PhoneChip<K extends string> = {
  key: K
  label: string
  count?: number | null
  tone?: 'neutral' | 'partial' | 'zero' | 'full' | 'over'
}

export function PhoneChips<K extends string>({ label, chips, active, onSelect, className }: {
  label: string
  chips: PhoneChip<K>[]
  active: K
  onSelect: (key: K) => void
  className?: string
}) {
  return (
    <div className={`boe-p3-chips${className ? ` ${className}` : ''}`} role="group" aria-label={label}>
      {chips.map(c => (
        <button
          key={c.key}
          type="button"
          className={`orders-phone-chip${c.count === 0 ? ' is-zero' : ''}`}
          aria-pressed={active === c.key}
          onClick={() => onSelect(c.key)}
        >
          {c.tone && <span aria-hidden="true" className={`fin-dot fin-dot--${c.tone}`} />}
          {c.label}
          {c.count !== undefined && <span className="orders-phone-chip-count">{c.count ?? '—'}</span>}
        </button>
      ))}
    </div>
  )
}

export type PhoneSheetGroup = {
  id: string
  label: string
  value?: string
  options?: { value: string; label: string }[]
  onChange?: (value: string) => void
  /** Free content instead of option buttons (a date field, a toggle). */
  content?: ReactNode
}

/** "Show 1 task" / "Show 12 tasks". */
export function showResultsLabel(count: number, noun: [string, string]): string {
  return `Show ${count} ${count === 1 ? noun[0] : noun[1]}`
}

export function PhoneSearchFilter({
  search, groups, activeCount, resultCount, noun, onClearAll, initiallyOpen = false, children, className,
}: {
  className?: string
  search?: {
    value: string
    onChange: (value: string) => void
    onBlur?: () => void
    placeholder: string
    label: string
  }
  groups: PhoneSheetGroup[]
  /** How many of the sheet's filters are set. */
  activeCount: number
  resultCount: number
  noun: [string, string]
  onClearAll: () => void
  /** Tests only: draw the sheet open. */
  initiallyOpen?: boolean
  /** Extra controls after the Filter button (a "+" or a view toggle). */
  children?: ReactNode
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
    <div className={`boe-p3-tools${className ? ` ${className}` : ''}`} role="search">
      {search && (
        <label className="boe-list-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#686D6C" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="search"
            aria-label={search.label}
            placeholder={search.placeholder}
            value={search.value}
            onChange={e => search.onChange(e.target.value)}
            onBlur={search.onBlur}
          />
          {search.value && (
            <button type="button" onClick={() => search.onChange('')} aria-label="Clear search" className="boe-list-search-clear">✕</button>
          )}
        </label>
      )}
      {groups.length > 0 && (
        <button
          type="button"
          className={`orders-phone-filter boe-p3-filter${activeCount > 0 ? ' is-set' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={activeCount > 0 ? `Filter, ${activeCount} set` : 'Filter'}
          onClick={() => setOpen(true)}
        >
          <SlidersHorizontal size={16} strokeWidth={2} aria-hidden="true" />
          Filter
          {activeCount > 0 && <span className="orders-phone-filter-badge" aria-hidden="true">{activeCount}</span>}
        </button>
      )}
      {children}
      {open && (
        <>
          <div className="orders-sheet-backdrop" onClick={() => setOpen(false)} />
          <div ref={panel} className="orders-sheet" role="dialog" aria-modal="true" aria-label="Filter" tabIndex={-1}>
            <div className="orders-sheet-head">
              <h2>Filter</h2>
              <button type="button" className="orders-sheet-clear" onClick={onClearAll}>Clear all</button>
              <button type="button" className="orders-sheet-close" aria-label="Close" onClick={() => setOpen(false)}>
                <X size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
            {groups.map(g => (
              <div key={g.id} className="orders-sheet-group" role="group" aria-labelledby={`p3-sheet-${g.id}`}>
                <div id={`p3-sheet-${g.id}`} className="orders-sheet-label">{g.label}</div>
                {g.content ?? (
                  <div className="orders-sheet-options">
                    {(g.options ?? []).map(o => (
                      <button key={o.value} type="button" aria-pressed={g.value === o.value} onClick={() => g.onChange?.(o.value)}>
                        {o.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <button type="button" className="boe-btn boe-btn-primary orders-sheet-apply" onClick={() => setOpen(false)}>
              {showResultsLabel(resultCount, noun)}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
