'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Home, RefreshCw } from 'lucide-react'
import { INTENT_DWELL_MS } from '@/hooks/useIntentWarm'

// The three controls OrdersLayout and FinanceLayout draw identically — the
// sidebar destination, the BOE OS Home door and the header Refresh. They were
// copied between the two files as <button onClick={router.push}> with inline
// hover handlers; they are here once so the two shells cannot drift, and so each
// is the right element:
//
//   * a DESTINATION is an <a> (Next <Link>). It opens in a new tab, shows its
//     address on hover, announces itself with aria-current, and Next prefetches
//     its code once the person shows INTENT (the pointer RESTING on it, focus,
//     touch), so the click lands on a route that is already in hand. Not while
//     the item is merely on screen: that prefetched every page of the menu on
//     every load and preloaded stylesheets of pages never opened (measured
//     2026-11-11: /finance/founders on every Finance page);
//   * an ACTION (Refresh) stays a <button>, and says what it is to a screen
//     reader rather than relying on a tooltip.
//
// Colours, sizes and hover values are the ones the two layouts already used.

export function ShellNavLink({ href, label, icon, active, onNavigate, trailing }: {
  href: string
  label: string
  icon: React.ReactNode
  active: boolean
  /** Closes the mobile sidebar. Navigation itself is the link's. */
  onNavigate?: () => void
  /** A badge, drawn after the label. */
  trailing?: React.ReactNode
}) {
  // Next's own hover-prefetch pattern: off until the person shows intent, then
  // back to the default. The pointer must REST (INTENT_DWELL_MS), so crossing
  // the menu on the way elsewhere warms nothing; focus and touch are deliberate.
  const [warm, setWarm] = useState(false)
  const rest = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(rest.current), [])

  return (
    <Link
      href={href}
      prefetch={warm ? null : false}
      onPointerEnter={() => { clearTimeout(rest.current); rest.current = setTimeout(() => setWarm(true), INTENT_DWELL_MS) }}
      onPointerLeave={() => clearTimeout(rest.current)}
      onFocus={() => setWarm(true)}
      onTouchStart={() => setWarm(true)}
      className={`boe-nav-item${active ? ' active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={onNavigate}
      title={label}
      style={{ fontWeight: active ? 600 : 400, marginBottom: '2px', textDecoration: 'none' }}
    >
      <span aria-hidden="true" style={{ color: active ? '#B9472E' : '#686D6C', display: 'flex', alignItems: 'center' }}>
        {icon}
      </span>
      <span className="boe-rail-label">{label}</span>
      {trailing}
    </Link>
  )
}

export function ShellHomeLink() {
  return (
    <Link
      href="/modules"
      title="BOE One Home"
      aria-label="BOE One Home"
      className="boe-shell-home boe-rail-label"
    >
      <Home size={14} strokeWidth={2} aria-hidden="true" />
    </Link>
  )
}

export function ShellRefreshButton({ refreshing, onRefresh }: {
  refreshing: boolean
  onRefresh: () => void
}) {
  return (
    <button
      type="button"
      onClick={onRefresh}
      disabled={refreshing}
      title="Refresh"
      aria-label={refreshing ? 'Refreshing' : 'Refresh'}
      className={`boe-shell-refresh${refreshing ? ' is-refreshing' : ''}`}
    >
      <RefreshCw
        size={14}
        strokeWidth={2}
        aria-hidden="true"
        style={refreshing ? { animation: 'boe-spin 0.7s linear infinite' } : undefined}
      />
    </button>
  )
}
