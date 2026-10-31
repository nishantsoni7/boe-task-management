'use client'

// ── A COLUMN THAT SORTS FROM ITS OWN HEADING (owner, 2026-10-31) ─────────────
//
// Project Code and Product Value, the two columns the list can sort by. The
// heading writes the same sort key the toolbar chip does, so the URL, the Back
// button and the chip all stay right. The chip stays too: a phone has no headings.

import { ArrowDown, ArrowUp } from 'lucide-react'

export function SortHeader<K extends string>({ label, current, high, low, onSort, className }: {
  label: string
  current: K
  /** The key for highest first: what a first press asks for. */
  high: K
  low: K
  onSort: (next: K) => void
  className?: string
}) {
  const active = current === high || current === low
  const Arrow = current === low ? ArrowUp : ArrowDown
  return (
    <th className={className} aria-sort={active ? (current === low ? 'ascending' : 'descending') : undefined}>
      <button
        type="button"
        className={`orders-sort${active ? ' is-active' : ''}`}
        onClick={() => onSort(current === high ? low : high)}
      >
        {label}
        <Arrow size={12} strokeWidth={2.4} aria-hidden="true" />
      </button>
    </th>
  )
}
