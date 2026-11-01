'use client'

import { useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { CalendarRange, Home, LayoutDashboard, ListOrdered, Target, Users } from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import { BoeBrandIcon } from './BoeBrandIcon'
import { SidebarPinButton, railShellClass, useSidebarPinned } from './RailControls'

// The SEO module shell: the BOE Module Layout Standard, two columns, a module header with Home → /modules,
// module-only navigation, and the shared user area at the bottom.

const BASE = '/seo'

const NAV_ITEMS = [
  { href: BASE, label: 'Overview', icon: LayoutDashboard },
  { href: `${BASE}/rankings`, label: 'Rankings', icon: ListOrdered },
  { href: `${BASE}/competitors`, label: 'Competitors', icon: Users },
  { href: `${BASE}/year`, label: 'Year review', icon: CalendarRange },
  { href: `${BASE}/board`, label: 'Vision board', icon: Target },
] as const

type Props = {
  profile: UserProfile | null
  title: string
  subtitle?: string
  onSignOut: () => void
  children: React.ReactNode
}

export function SeoLayout({ profile, title, subtitle, onSignOut, children }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [railPinned, toggleRailPinned] = useSidebarPinned()
  const router = useRouter()
  const pathname = usePathname()

  return (
    <div className={railShellClass(railPinned)}>
      <div className={`boe-sidebar-overlay${sidebarOpen ? ' open' : ''}`} onClick={() => setSidebarOpen(false)} />

      <aside className={`boe-sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="boe-sidebar-brand" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <BoeBrandIcon />
            <div className="boe-rail-label">
              <div className="boe-sidebar-brand-name">BOE One</div>
              <div className="boe-sidebar-brand-sub">SEO</div>
            </div>
          </div>
          <button
            className="boe-rail-label"
            onClick={() => router.push('/modules')}
            title="BOE One Home"
            aria-label="BOE One Home"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: '8px',
              background: 'rgba(185,71,46,0.08)', border: '1px solid rgba(185,71,46,0.20)',
              color: '#B9472E', cursor: 'pointer', flexShrink: 0,
            }}
          >
            <Home size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="boe-sidebar-section">
          {NAV_ITEMS.map(item => {
            const active = pathname === item.href
            const Icon = item.icon
            return (
              <button
                key={item.href}
                className={`boe-nav-item${active ? ' active' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => { setSidebarOpen(false); router.push(item.href) }}
                style={{ fontWeight: active ? 500 : 400, fontSize: 13.5, marginBottom: '2px' }}
              >
                <span style={{ color: active ? '#37352F' : '#8A8782', display: 'flex', alignItems: 'center' }}>
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
        </div>
        <div className="boe-page-body">
          <ViewModeBanner />
          {children}
        </div>
      </div>
    </div>
  )
}
