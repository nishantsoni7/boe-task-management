'use client'

import { useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { BarChart3, CalendarDays, Home, ListChecks, Plus, Users } from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { BoeBrandIcon } from './BoeBrandIcon'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'

// The Exhibition Leads module shell — the BOE Module Layout Standard: two
// columns, a module header with Home → /modules, module-only navigation, and the
// shared user area at the bottom. One navigation definition serves desktop and
// the phone menu (the same sidebar element with a class toggled).

const BASE = '/exhibition-leads'

const NAV_ITEMS = [
  { href: `${BASE}/add`, label: 'Add Lead', icon: Plus, adminOnly: false },
  { href: `${BASE}/my`, label: 'My Leads', icon: ListChecks, adminOnly: false },
  { href: `${BASE}/all`, label: 'All Exhibition Leads', icon: Users, adminOnly: true },
  { href: `${BASE}/ranking`, label: 'Ranking', icon: BarChart3, adminOnly: true },
  { href: `${BASE}/exhibitions`, label: 'Exhibitions', icon: CalendarDays, adminOnly: true },
] as const

type Props = {
  profile: UserProfile | null
  isAdmin: boolean
  title: string
  subtitle?: string
  actions?: React.ReactNode
  onSignOut: () => void
  children: React.ReactNode
}

export function ExhibitionLeadsLayout({ profile, isAdmin, title, subtitle, actions, onSignOut, children }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const router = useRouter()
  const pathname = usePathname()

  return (
    <div className="boe-app-shell">
      <div
        className={`boe-sidebar-overlay${sidebarOpen ? ' open' : ''}`}
        onClick={() => setSidebarOpen(false)}
      />

      <aside className={`boe-sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="boe-sidebar-brand" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <BoeBrandIcon />
            <div>
              <div className="boe-sidebar-brand-name">BOE</div>
              <div className="boe-sidebar-brand-sub">Exhibition Leads</div>
            </div>
          </div>
          <button
            onClick={() => router.push('/modules')}
            title="BOE OS Home"
            aria-label="BOE OS Home"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: '7px',
              background: 'rgba(220,31,46,0.08)',
              border: '1px solid rgba(220,31,46,0.20)',
              color: '#DC1F2E', cursor: 'pointer', flexShrink: 0,
            }}
          >
            <Home size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="boe-sidebar-section">
          {NAV_ITEMS.filter(item => isAdmin || !item.adminOnly).map(item => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
            const Icon = item.icon
            return (
              <button
                key={item.href}
                className={`boe-nav-item${active ? ' active' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => { setSidebarOpen(false); router.push(item.href) }}
                style={{ fontWeight: active ? 600 : undefined, marginBottom: '2px' }}
              >
                <span style={{ color: '#DC1F2E', display: 'flex', alignItems: 'center' }}>
                  <Icon size={15} strokeWidth={1.8} />
                </span>
                {item.label}
              </button>
            )
          })}
        </div>

        <ViewModeSidebarSection
          profile={profile}
          onSignOut={onSignOut}
          accountSettingsHref={`/account?returnTo=${BASE}/add`}
        />
      </aside>

      <div className="boe-main-content">
        <div className="boe-page-header">
          <button className="boe-menu-toggle" onClick={() => setSidebarOpen(true)} aria-label="Open menu">☰</button>
          <div className="boe-page-title-group">
            <div className="boe-page-title">{title}</div>
            {subtitle && <div className="boe-page-subtitle">{subtitle}</div>}
          </div>
          {actions && (
            <div className="boe-header-actions" style={{ flexWrap: 'wrap', flexShrink: 1 }}>
              {actions}
            </div>
          )}
        </div>
        <div className="boe-page-body">
          <ViewModeBanner />
          {children}
        </div>
      </div>
    </div>
  )
}
