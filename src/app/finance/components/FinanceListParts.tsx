'use client'

import React from 'react'

/**
 * THE FINANCE LIST PARTS (Concept A, Notion-style).
 *
 * Shared by Payment Requests, Confirmed Payments and Payments to Verify so the
 * three lists read as one product: the same view bar, the same tabs, the same
 * empty state. Styling lives in globals.css under "FINANCE LISTS".
 */

export type FinanceTabTone = 'zero' | 'partial' | 'full' | 'over' | 'neutral'

export type FinanceTab<K extends string> = {
  key: K
  label: string
  /** The status colour this tab stands for; omit for "All". */
  tone?: FinanceTabTone
  /** NULL while unknown (in flight or failed): drawn as nothing, never as 0. */
  count: number | null
}

/** "3 Sep 2026 – 17 Oct 2026", "From 3 Sep 2026", "Until 17 Oct 2026", or the plain label. */
export function dateChipLabel(from: string, to: string, fmt: (iso: string) => string): string {
  if (from && to) return `${fmt(from)} – ${fmt(to)}`
  if (from) return `From ${fmt(from)}`
  if (to) return `Until ${fmt(to)}`
  return 'Paid date'
}

/**
 * A filter chip that opens a small panel. A native <details>, so it opens with
 * Enter/Space and needs no focus management of its own; the panel holds the
 * caller's own controls unchanged.
 */
export function FilterChip({ label, isSet, children }: {
  label: string
  isSet: boolean
  children: React.ReactNode
}) {
  return (
    <details className={`fin-chip${isSet ? ' is-set' : ''}`}>
      <summary>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        {label}
      </summary>
      <div className="fin-chip-panel">{children}</div>
    </details>
  )
}

/** Empty list: an icon, a headline, one line, and the way forward. */
export function FinanceEmpty({ icon = 'card', title, body, action, role = 'status' }: {
  icon?: 'card' | 'check' | 'search'
  title: string
  body?: React.ReactNode
  action?: React.ReactNode
  role?: 'status' | 'alert'
}) {
  return (
    <div role={role} className="fin-empty">
      <div className="fin-empty-icon" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          {icon === 'check' && <polyline points="20 6 9 17 4 12" />}
          {icon === 'search' && <><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>}
          {icon === 'card' && <><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></>}
        </svg>
      </div>
      <p className="fin-empty-title">{title}</p>
      {body && <p className="fin-empty-body">{body}</p>}
      {action}
    </div>
  )
}

/** Initials + name, for "Requested by". */
export function FinancePerson({ name }: { name: string | null | undefined }) {
  const clean = (name ?? '').trim()
  if (!clean) return <span className="fin-muted">—</span>
  const initials = clean.split(/\s+/).slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('')
  return (
    <span className="fin-person" title={clean}>
      <span className="fin-avatar" aria-hidden="true">{initials}</span>
      <span>{clean}</span>
    </span>
  )
}

/**
 * Status cards that ARE the list's filter (Payment Requests, 2026-10: the owner
 * removed the tabs). Each card shows how many records it holds and narrows the
 * list when pressed; the pressed card is outlined. NULL count = not known yet,
 * drawn as a dash, never as 0.
 */
export function FinanceStatusCards<K extends string>({ cards, active, onSelect, ariaLabel, noun }: {
  cards: { key: K; label: string; tone?: FinanceTabTone; count: number | null }[]
  active: K
  onSelect: (key: K) => void
  ariaLabel: string
  /** Singular noun for the line under the number: "request" → "3 requests". */
  noun: string
}) {
  return (
    <div className="fin-stats" role="group" aria-label={ariaLabel} style={{ gridTemplateColumns: `repeat(${cards.length}, minmax(0, 1fr))` }}>
      {cards.map(c => (
        <button key={c.key} type="button" className="fin-stat" aria-pressed={active === c.key} onClick={() => onSelect(c.key)}>
          <span className="fin-stat-label">
            <span aria-hidden="true" className={`fin-dot fin-dot--${c.tone ?? 'neutral'}`} />
            {c.label}
          </span>
          <span className="fin-stat-value" style={{ display: 'block' }}>{c.count ?? '—'}</span>
          <span className="fin-stat-sub" style={{ display: 'block' }}>{c.count === 1 ? noun : `${noun}s`}</span>
        </button>
      ))}
    </div>
  )
}
