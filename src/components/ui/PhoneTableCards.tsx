'use client'

import { useEffect, useRef, type ReactNode } from 'react'

/**
 * TABLES BECOME CARDS ON A PHONE (owner, 2026-11-05, "phones: content first").
 *
 * Wrap any table in this and, below 768px, each row is drawn as a card: the
 * first cell is the card's title, and every other cell shows its column name
 * above its value. Nothing scrolls sideways any more. On a desktop the table
 * is untouched.
 *
 * The column names come from the table's own <thead>: after each render every
 * body cell gets a `data-label` from the heading above it, so no page has to
 * repeat its headings. A heading with no text (a checkbox or actions column)
 * gives no label. Styles: `.boe-cardtable` in globals.css.
 */
export function labelTableCells(root: HTMLElement): void {
  for (const table of Array.from(root.querySelectorAll('table'))) {
    const heads = Array.from(table.querySelectorAll('thead tr:last-child th')).map(th => (th.textContent ?? '').trim())
    for (const row of Array.from(table.querySelectorAll('tbody tr'))) {
      let col = 0
      for (const cell of Array.from(row.children) as HTMLTableCellElement[]) {
        const label = heads[col] ?? ''
        if (label) cell.setAttribute('data-label', label)
        else cell.removeAttribute('data-label')
        col += cell.colSpan || 1
      }
    }
  }
}

export function PhoneTableCards({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null)
  // After every render: the rows may have changed.
  useEffect(() => { if (ref.current) labelTableCells(ref.current) })
  return <div ref={ref} className={className ? `boe-cardtable ${className}` : 'boe-cardtable'}>{children}</div>
}
