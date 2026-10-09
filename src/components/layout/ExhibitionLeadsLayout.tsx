'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { BarChart3, CalendarDays, Home, ListChecks, Plus, Users } from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { BoeBrandIcon } from './BoeBrandIcon'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import a from '@/components/exhibitionLeads/addLead.module.css'

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
  // Adding a lead is the module's main job: on every other page a phone shows a big red bar to start one.
  const showAddBar = !pathname.startsWith(`${BASE}/add`)

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
            // Add Lead is the primary action: it is always the filled red item.
            const primary = item.href === `${BASE}/add`
            return (
              <button
                key={item.href}
                className={`boe-nav-item${active ? ' active' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => { setSidebarOpen(false); router.push(item.href) }}
                style={primary
                  ? { background: '#DC1F2E', color: '#fff', fontWeight: 700, fontSize: 14, padding: '11px 12px', marginBottom: '10px', boxShadow: '0 2px 6px rgba(220,31,46,0.30)' }
                  : { fontWeight: active ? 600 : undefined, marginBottom: '2px' }}
              >
                <span style={{ color: primary ? '#fff' : '#DC1F2E', display: 'flex', alignItems: 'center' }}>
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
        <div className={`boe-page-body${showAddBar ? ` ${a.fabPad}` : ''}`}>
          <ViewModeBanner />
          {children}
        </div>
        {showAddBar && (
          <Link href={`${BASE}/add`} className={a.fab} aria-label="Add a new lead">
            <Plus size={22} strokeWidth={2.8} aria-hidden="true" /> Add Lead
          </Link>
        )}
      </div>
    </div>
  )
}
