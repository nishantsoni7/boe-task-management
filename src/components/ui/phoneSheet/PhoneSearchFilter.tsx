'use client'

import { useState, type ReactNode } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { BottomSheet, SheetTrigger } from './BottomSheet'
import { PhoneSheetGroups, type PhoneSheetGroup } from './PhoneSheetGroups'
import { showResultsLabel } from './labels'

/**
 * THE PHONE LIST TOOLS ROW (owner, 2026-11-05, phone phase 3, "content
 * first"): an optional search box, then ONE Filter button whose bottom sheet
 * holds the list's filters, then any extra controls the page adds (a "+", a
 * view toggle). The row is `boe-p3-tools`, drawn on a phone only.
 *
 * Presentation only. Every choice calls the setter the page already had, so a
 * filter set on a phone is the same filter on a desktop.
 */
export function PhoneSearchFilter({
  search, groups, activeCount, resultCount, noun, resultLabel, onClearAll, initiallyOpen = false, children, className,
}: {
  className?: string
  search?: {
    value: string
    onChange: (value: string) => void
    onBlur?: () => void
    placeholder: string
    label: string
  }
  /** The sheet's groups; with none, no Filter button is drawn. */
  groups: PhoneSheetGroup[]
  /** How many of the sheet's filters are set. */
  activeCount: number
  resultCount: number
  /** The rows' noun for "Show 12 tasks": ['task', 'tasks']. */
  noun: [string, string]
  /** The result button's words in place of "Show N nouns". */
  resultLabel?: string
  onClearAll: () => void
  /** Tests only: draw the sheet open. */
  initiallyOpen?: boolean
  /** Extra controls after the Filter button (a "+" or a view toggle). */
  children?: ReactNode
}) {
  const [open, setOpen] = useState(initiallyOpen)

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
        <SheetTrigger
          label="Filter"
          icon={<SlidersHorizontal size={16} strokeWidth={2} aria-hidden="true" />}
          badge={activeCount}
          open={open}
          onOpen={() => setOpen(true)}
          baseClassName="orders-phone-filter boe-p3-filter"
        />
      )}
      {children}
      {open && (
        <BottomSheet
          title="Filter"
          onClose={() => setOpen(false)}
          onClearAll={onClearAll}
          doneLabel={resultLabel ?? showResultsLabel(resultCount, noun)}
        >
          <PhoneSheetGroups groups={groups} idPrefix="p3-sheet-" />
        </BottomSheet>
      )}
    </div>
  )
}
