'use client'

import { PageBackButton } from '@/components/layout/PageBackButton'
import { useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { BarChart3, FileText, Home, Inbox, Plus, Sparkles } from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { askKeys, fetchRequestCount, type QuotationAccess } from '@/lib/quotations/api'
import { BoeBrandIcon } from './BoeBrandIcon'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import { SidebarPinButton, railShellClass, useSidebarPinned } from './RailControls'

// The Quotations module shell — the BOE Module Layout Standard: two columns, a module header with Home →
// /modules, module-only navigation, and the shared user area at the bottom. Same build as InventoryLayout.

const BASE = '/quotations'

type Props = {
  profile: UserProfile | null
  access: QuotationAccess
  title: string
  subtitle?: string
  actions?: React.ReactNode
  /** A centred column no wider than this many px (the header's title and actions line up with it), as BoeOsLayout's contentMaxWidth. The builder uses 1360. */
  contentMaxWidth?: number
  onSignOut: () => void
  children: React.ReactNode
}

export function QuotationsLayout({ profile, access, title, subtitle, actions, contentMaxWidth, onSignOut, children }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [railPinned, toggleRailPinned] = useSidebarPinned()
  const router = useRouter()
  const pathname = usePathname()

  // Requests waiting for this person to answer (20 Nov 2026): one small read, after the page has drawn, refreshed every two minutes.
  const waitingQ = useQuery({ queryKey: askKeys.count, queryFn: () => fetchRequestCount(createClient()), enabled: !!profile, staleTime: 60_000, refetchInterval: 120_000, retry: false })
  const waiting = waitingQ.data ?? 0

  const items = [
    ...(access.create ? [{ href: `${BASE}?new=1`, label: 'New quotation', icon: Plus, active: false, primary: true }] : []),
    { href: BASE, label: 'Quotations', icon: FileText, active: pathname === BASE || (pathname.startsWith(`${BASE}/`) && !pathname.startsWith(`${BASE}/reports`) && !pathname.startsWith(`${BASE}/learning`) && !pathname.startsWith(`${BASE}/requests`)), primary: false },
    // The quotation requests, Pending and Completed (18 Nov 2026); the page says so when somebody has none.
    { href: `${BASE}/requests`, label: 'Requests', icon: Inbox, active: pathname.startsWith(`${BASE}/requests`), primary: false, badge: waiting },
    { href: `${BASE}/reports`, label: 'Reports', icon: BarChart3, active: pathname.startsWith(`${BASE}/reports`), primary: false },
    // Price learning is the pricing desk's (Admin, or edit + see-all), the same rule as price approval; the database decides.
    ...(access.admin || (access.edit && access.view_all) ? [{ href: `${BASE}/learning`, label: 'Price learning', icon: Sparkles, active: pathname.startsWith(`${BASE}/learning`), primary: false }] : []),
  ]

  return (
    <div className={railShellClass(railPinned)}>
      <div className={`boe-sidebar-overlay${sidebarOpen ? ' open' : ''}`} onClick={() => setSidebarOpen(false)} />

      <aside className={`boe-sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="boe-sidebar-brand" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <BoeBrandIcon />
            <div className="boe-rail-label">
              <div className="boe-sidebar-brand-name">BOE One</div>
              <div className="boe-sidebar-brand-sub">Quotations</div>
            </div>
          </div>
          <button
            className="boe-rail-label"
            onClick={() => router.push('/modules')}
            title="BOE One Home"
            aria-label="BOE One Home"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: '8px',
              background: 'rgba(185,71,46,0.08)', border: '1px solid rgba(185,71,46,0.20)', color: '#963B27', cursor: 'pointer', flexShrink: 0,
            }}
          >
            <Home size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="boe-sidebar-section">
          {items.map(item => {
            const Icon = item.icon
            return (
              <button
                key={item.href}
                className={`boe-nav-item${item.active ? ' active' : ''}`}
                aria-current={item.active ? 'page' : undefined}
                onClick={() => { setSidebarOpen(false); router.push(item.href) }}
                title={item.label}
                style={item.primary
                  ? { background: '#B9472E', color: '#fff', fontWeight: 700, fontSize: 14, padding: '11px 12px', marginBottom: '10px', boxShadow: '0 2px 6px rgba(185,71,46,0.30)' }
                  : { fontWeight: item.active ? 600 : undefined, marginBottom: '2px' }}
              >
                <span style={{ color: item.primary ? '#fff' : '#B9472E', display: 'flex', alignItems: 'center' }}>
                  <Icon size={15} strokeWidth={1.8} />
                </span>
                <span className="boe-rail-label">{item.label}</span>
                {'badge' in item && item.badge ? <span className="boe-rail-label" style={{ marginLeft: 'auto', minWidth: 20, padding: '0 6px', borderRadius: 10, background: '#B9472E', color: '#fff', fontSize: 11.5, fontWeight: 700, textAlign: 'center' }} aria-label={`${item.badge} waiting`}>{item.badge}</span> : null}
              </button>
            )
          })}
        </div>

        <div className="boe-sidebar-foot">
          <SidebarPinButton pinned={railPinned} onToggle={toggleRailPinned} />
          <ViewModeSidebarSection profile={profile} onSignOut={onSignOut} accountSettingsHref={`/account?returnTo=${BASE}`} />
        </div>
      </aside>

      <div
        className={`boe-main-content${contentMaxWidth ? ' boe-main-content-capped' : ''}`}
        style={contentMaxWidth ? { '--boe-content-max': `${contentMaxWidth}px` } as React.CSSProperties : undefined}
      >
        <div className="boe-page-header">
          <button className="boe-menu-toggle" onClick={() => setSidebarOpen(true)} aria-label="Open menu">☰</button>
          <PageBackButton />
          <div className="boe-page-title-group">
            <div className="boe-page-title">{title}</div>
            {subtitle && <div className="boe-page-subtitle">{subtitle}</div>}
          </div>
          {actions && <div className="boe-header-actions" style={{ flexWrap: 'wrap', flexShrink: 1 }}>{actions}</div>}
        </div>
        <div className="boe-page-body">
          <ViewModeBanner />
          {children}
        </div>
      </div>
    </div>
  )
}
