'use client'

import { AppLink as Link } from '@/components/ui/AppLink'
import { Home, RefreshCw } from 'lucide-react'

// The three controls OrdersLayout and FinanceLayout draw identically — the
// sidebar destination, the BOE OS Home door and the header Refresh. They were
// copied between the two files as <button onClick={router.push}> with inline
// hover handlers; they are here once so the two shells cannot drift, and so each
// is the right element:
//
//   * a DESTINATION is an <a> (Next <Link>). It opens in a new tab, shows its
//     address on hover and announces itself with aria-current. Its page loads
//     when it is clicked, never in advance (AppLink, owner 2026-11-12): loading
//     the menu's pages ahead preloaded stylesheets of pages never opened
//     (measured 2026-11-11: /finance/founders on every Finance page);
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
  return (
    <Link
      href={href}
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
