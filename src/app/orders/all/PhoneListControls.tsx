'use client'

import { useEffect, useRef, useState } from 'react'
import { SlidersHorizontal, X } from 'lucide-react'

/**
 * THE CONFIRMED ORDERS CONTROLS ON A PHONE (owner, 2026-11-04, "Option A:
 * compact list"). On a phone the six status cards and the four filter chips
 * filled the whole first screen, so not one Order showed. Below 768px they are
 * replaced by:
 *
 *   - one row of status chips that scrolls sideways (a zero count is faded),
 *   - the search box and ONE Filter button, with the number of filters set,
 *   - a bottom sheet that holds Sales person, Order date, Source and Sort.
 *
 * Presentation only. Every choice writes the same URL state the desktop
 * controls write (the page passes its own setters), so a filter set on a
 * phone is the same filter on a desktop, and Back returns to it.
 * The desktop cards and chips are untouched; CSS decides which set shows.
 */

export type PhoneStatusChip<K extends string> = {
  key: K
  label: string
  tone: 'neutral' | 'partial' | 'zero' | 'full' | 'over'
  count: number | null
}

export function PhoneStatusChips<K extends string>({ chips, active, onSelect }: {
  chips: PhoneStatusChip<K>[]
  active: K
  onSelect: (key: K) => void
}) {
  return (
    <div className="orders-phone-chips" role="group" aria-label="Order status">
      {chips.map(c => (
        <button
          key={c.key}
          type="button"
          className={`orders-phone-chip${c.count === 0 ? ' is-zero' : ''}`}
          aria-pressed={active === c.key}
          onClick={() => onSelect(c.key)}
        >
          <span aria-hidden="true" className={`fin-dot fin-dot--${c.tone}`} />
          {c.label}
          <span className="orders-phone-chip-count">{c.count ?? '—'}</span>
        </button>
      ))}
    </div>
  )
}

export type PhoneFilterGroup = {
  id: string
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}

/** "Show 1 order" / "Show 13 orders". */
export function showOrdersLabel(count: number): string {
  return `Show ${count} order${count === 1 ? '' : 's'}`
}

export function PhoneFilterButton({ activeCount, groups, resultCount, onClearAll, initiallyOpen = false }: {
  /** How many of the sheet's filters are set (Sort is not a filter). */
  activeCount: number
  groups: PhoneFilterGroup[]
  /** The rows the list shows now: every choice applies at once. */
  resultCount: number
  onClearAll: () => void
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
        className={`orders-phone-filter${activeCount > 0 ? ' is-set' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={activeCount > 0 ? `Filter and sort, ${activeCount} set` : 'Filter and sort'}
        onClick={() => setOpen(true)}
      >
        <SlidersHorizontal size={16} strokeWidth={2} aria-hidden="true" />
        Filter
        {activeCount > 0 && <span className="orders-phone-filter-badge" aria-hidden="true">{activeCount}</span>}
      </button>
      {open && (
        <>
          <div className="orders-sheet-backdrop" onClick={() => setOpen(false)} />
          <div
            ref={panel}
            className="orders-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Filter and sort"
            tabIndex={-1}
          >
            <div className="orders-sheet-head">
              <h2>Filter and sort</h2>
              <button type="button" className="orders-sheet-clear" onClick={onClearAll}>Clear all</button>
              <button type="button" className="orders-sheet-close" aria-label="Close" onClick={() => setOpen(false)}>
                <X size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
            {groups.map(g => (
              <div key={g.id} className="orders-sheet-group" role="group" aria-labelledby={`orders-sheet-${g.id}`}>
                <div id={`orders-sheet-${g.id}`} className="orders-sheet-label">{g.label}</div>
                <div className="orders-sheet-options">
                  {g.options.map(o => (
                    <button
                      key={o.value}
                      type="button"
                      aria-pressed={g.value === o.value}
                      onClick={() => g.onChange(o.value)}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <button type="button" className="boe-btn boe-btn-primary orders-sheet-apply" onClick={() => setOpen(false)}>
              {showOrdersLabel(resultCount)}
            </button>
          </div>
        </>
      )}
    </>
  )
}
