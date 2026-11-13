'use client'

import { useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { BarChart3, FileText, Home, Plus, Sparkles } from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import type { QuotationAccess } from '@/lib/quotations/api'
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
  onSignOut: () => void
  children: React.ReactNode
}

export function QuotationsLayout({ profile, access, title, subtitle, actions, onSignOut, children }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [railPinned, toggleRailPinned] = useSidebarPinned()
  const router = useRouter()
  const pathname = usePathname()

  const items = [
    ...(access.create ? [{ href: `${BASE}?new=1`, label: 'New quotation', icon: Plus, active: false, primary: true }] : []),
    { href: BASE, label: 'Quotations', icon: FileText, active: pathname === BASE || (pathname.startsWith(`${BASE}/`) && !pathname.startsWith(`${BASE}/reports`) && !pathname.startsWith(`${BASE}/learning`)), primary: false },
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
              </button>
            )
          })}
        </div>

        <div className="boe-sidebar-foot">
          <SidebarPinButton pinned={railPinned} onToggle={toggleRailPinned} />
          <ViewModeSidebarSection profile={profile} onSignOut={onSignOut} accountSettingsHref={`/account?returnTo=${BASE}`} />
        </div>
      </aside>

      <div className="boe-main-content">
        <div className="boe-page-header">
          <button className="boe-menu-toggle" onClick={() => setSidebarOpen(true)} aria-label="Open menu">☰</button>
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
