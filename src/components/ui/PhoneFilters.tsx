'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { SlidersHorizontal, X } from 'lucide-react'
import { colors } from '@/lib/tokens'

/**
 * THE PHONE FILTER SET (owner, 2026-11-05, "phones: content first"; folded
 * into one set after Phases 3 and 4 left four copies).
 *
 * Below 768px a list starts with:
 *
 *   - `PhoneChips`: one row of chips that scrolls sideways (a zero count fades),
 *   - `PhoneSearchFilter`: the search box and ONE Filter button, with the number
 *     of filters set, and
 *   - `PhoneFilterSheet`: the bottom sheet behind that button. It holds
 *     option-button groups (`groups`, `PhoneOptionGroup`, `PhoneMultiGroup`)
 *     and/or a page's own controls (`children`, `PhoneSheetField`).
 *
 * Presentation only. Every choice calls the setter the page already had, so a
 * filter set on a phone is the same filter (the same URL / state) on a desktop.
 * A desktop never draws these: the CSS around them (`orders-phone-*`,
 * `boe-p3-*`, `boe-phone-only`, `p3-sheet`, attendance's `phoneOnly`) hides
 * them at 768px and up, and each caller passes the classes it always had.
 * Styles: `.orders-phone-chip*`, `.orders-phone-filter*` and `.orders-sheet*`
 * in globals.css.
 */

type Tone = 'neutral' | 'partial' | 'zero' | 'full' | 'over'

export type PhoneChip<K extends string> = {
  key: K
  label: string
  /** Leave out to draw no count; `null` draws "—" (not read yet, not zero). */
  count?: number | null
  tone?: Tone
}

export function PhoneChips<K extends string>({ label, chips, active, onSelect, rowClassName = 'boe-p3-chips', className }: {
  /** The group's accessible name, e.g. "Order status", "Task view". */
  label: string
  chips: PhoneChip<K>[]
  active: K
  onSelect: (key: K) => void
  /** The row's own class: `boe-p3-chips` (default) or Orders' `orders-phone-chips`. */
  rowClassName?: string
  /** Extra classes on the row (e.g. `boe-p3-inset`). */
  className?: string
}) {
  return (
    <div className={`${rowClassName}${className ? ` ${className}` : ''}`} role="group" aria-label={label}>
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

/** "Show 1 order" / "Show 12 tasks". */
export function showResultsLabel(count: number, noun: readonly [string, string]): string {
  return `Show ${count} ${count === 1 ? noun[0] : noun[1]}`
}

export type PhoneSearch = {
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  placeholder: string
  /** The input's accessible name. */
  label: string
}

/** The 44px search box of a phone tools row. */
export function PhoneSearchBox({ value, onChange, onBlur, placeholder, label }: PhoneSearch) {
  return (
    <label className="boe-list-search">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        onBlur={onBlur}
      />
      {value && (
        <button type="button" onClick={() => onChange('')} aria-label="Clear search" className="boe-list-search-clear">✕</button>
      )}
    </label>
  )
}

export type PhoneSheetGroup = {
  id: string
  label: string
  value?: string
  options?: readonly { readonly value: string; readonly label: string }[]
  onChange?: (value: string) => void
  /** Free content instead of option buttons (a date field, a set of selects). */
  content?: ReactNode
}

/** A labelled group of the sheet: one option pressed at a time, or the group's own content. */
export function PhoneOptionGroup({ id, label, value, options = [], onChange, content }: PhoneSheetGroup) {
  return (
    <div className="orders-sheet-group" role="group" aria-labelledby={`p3-sheet-${id}`}>
      <div id={`p3-sheet-${id}`} className="orders-sheet-label">{label}</div>
      {content ?? (
        <div className="orders-sheet-options">
          {options.map(o => (
            <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange?.(o.value)}>
              {o.label}
            </button>
          ))}
        </div>
      )}
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

/** A labelled block of the sheet for a page's own control (a select, a date input). */
export function PhoneSheetField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="orders-sheet-group p3-sheet-field">
      <div className="orders-sheet-label">{label}</div>
      {children}
    </div>
  )
}

/**
 * ONE BUTTON THAT OPENS A BOTTOM SHEET. The button shows `label` (default
 * "Filter") and a badge with `activeCount`; the sheet has `title` as its
 * heading, an optional "Clear all", the `groups`, then `children`, and one
 * main button (`applyLabel`, e.g. "Show 12 leads"). Every choice applies at
 * once; the main button runs `onApply` and closes the sheet.
 */
export function PhoneFilterSheet({
  activeCount = 0, groups = [], children, title = 'Filter', label = 'Filter', ariaLabel, icon,
  applyLabel = 'Done', onApply, onClearAll, triggerClassName, sheetClassName, initiallyOpen = false,
}: {
  /** How many of the sheet's settings are set (Sort is not a filter): drawn as a badge. */
  activeCount?: number
  groups?: PhoneSheetGroup[]
  /** Extra controls under the option groups. */
  children?: ReactNode
  /** The sheet's heading and the dialog's name, e.g. "Filter and sort". */
  title?: string
  /** The button's text. */
  label?: string
  /** The button's accessible name (", N set" is added). Defaults to `title`. */
  ariaLabel?: string
  /** The button's icon; defaults to the sliders icon, `null` draws none. */
  icon?: ReactNode
  applyLabel?: string
  /** Runs when the main button is pressed, before the sheet closes (e.g. Search). */
  onApply?: () => void
  /** Offered as "Clear all" in the sheet's head when given. */
  onClearAll?: () => void
  /** The caller's classes on the button, e.g. `boe-phone-only p3-filter`. */
  triggerClassName?: string
  /** The caller's classes on the sheet, e.g. `p3-sheet`. */
  sheetClassName?: string
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

  const name = ariaLabel ?? title
  const drawnIcon = icon === undefined ? <SlidersHorizontal size={16} strokeWidth={2} aria-hidden="true" /> : icon

  return (
    <>
      <button
        type="button"
        className={`orders-phone-filter${triggerClassName ? ` ${triggerClassName}` : ''}${activeCount > 0 ? ' is-set' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={activeCount > 0 ? `${name}, ${activeCount} set` : name}
        onClick={() => setOpen(true)}
      >
        {drawnIcon}
        {label}
        {activeCount > 0 && <span className="orders-phone-filter-badge" aria-hidden="true">{activeCount}</span>}
      </button>
      {open && (
        <>
          <div className="orders-sheet-backdrop" onClick={() => setOpen(false)} />
          <div
            ref={panel}
            className={`orders-sheet${sheetClassName ? ` ${sheetClassName}` : ''}`}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
          >
            <div className="orders-sheet-head">
              <h2>{title}</h2>
              {onClearAll && <button type="button" className="orders-sheet-clear" onClick={onClearAll}>Clear all</button>}
              <button type="button" className="orders-sheet-close" aria-label="Close" onClick={() => setOpen(false)}>
                <X size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
            {groups.map(g => <PhoneOptionGroup key={g.id} {...g} />)}
            {children}
            <button type="button" className="boe-btn boe-btn-primary orders-sheet-apply" onClick={() => { onApply?.(); setOpen(false) }}>
              {applyLabel}
            </button>
          </div>
        </>
      )}
    </>
  )
}

/**
 * The phone tools row (`boe-p3-tools`): the search box, ONE Filter button
 * whose sheet says "Show N <noun>", then the page's extra controls (a "+", a
 * view toggle). The Filter button is drawn only when there are groups.
 */
export function PhoneSearchFilter({
  search, groups, activeCount, resultCount, noun, onClearAll, initiallyOpen = false, children, className,
}: {
  className?: string
  search?: PhoneSearch
  groups: PhoneSheetGroup[]
  /** How many of the sheet's filters are set. */
  activeCount: number
  resultCount: number
  noun: readonly [string, string]
  onClearAll: () => void
  /** Tests only: draw the sheet open. */
  initiallyOpen?: boolean
  /** Extra controls after the Filter button. */
  children?: ReactNode
}) {
  return (
    <div className={`boe-p3-tools${className ? ` ${className}` : ''}`} role="search">
      {search && <PhoneSearchBox {...search} />}
      {groups.length > 0 && (
        <PhoneFilterSheet
          activeCount={activeCount}
          groups={groups}
          triggerClassName="boe-p3-filter"
          applyLabel={showResultsLabel(resultCount, noun)}
          onClearAll={onClearAll}
          initiallyOpen={initiallyOpen}
        />
      )}
      {children}
    </div>
  )
}
