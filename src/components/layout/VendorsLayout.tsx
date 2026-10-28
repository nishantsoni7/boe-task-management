'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Activity, Factory, Home, Plus } from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { BoeBrandIcon } from './BoeBrandIcon'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import s from '@/components/vendors/vendors.module.css'

// The Vendors module shell — the BOE Module Layout Standard: two columns, a module header with Home → /modules,
// module-only navigation, and the shared user area at the bottom.

const BASE = '/vendors'

const NAV_ITEMS = [
  { href: `${BASE}/visit`, label: 'Log a Visit', icon: Plus, adminOnly: false },
  { href: BASE, label: 'All Vendors', icon: Factory, adminOnly: false },
  { href: `${BASE}/activity`, label: 'Visit Activity', icon: Activity, adminOnly: true },
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

export function VendorsLayout({ profile, isAdmin, title, subtitle, actions, onSignOut, children }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const router = useRouter()
  const pathname = usePathname()
  const showLogBar = !pathname.startsWith(`${BASE}/visit`)

  return (
    <div className="boe-app-shell">
      <div className={`boe-sidebar-overlay${sidebarOpen ? ' open' : ''}`} onClick={() => setSidebarOpen(false)} />

      <aside className={`boe-sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="boe-sidebar-brand" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <BoeBrandIcon />
            <div>
              <div className="boe-sidebar-brand-name">BOE One</div>
              <div className="boe-sidebar-brand-sub">Vendors</div>
            </div>
          </div>
          <button
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
          {NAV_ITEMS.filter(item => isAdmin || !item.adminOnly).map(item => {
            const active = item.href === BASE ? pathname === BASE : pathname === item.href || pathname.startsWith(`${item.href}/`)
            const Icon = item.icon
            const primary = item.href === `${BASE}/visit`
            return (
              <button
                key={item.href}
                className={`boe-nav-item${active ? ' active' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => { setSidebarOpen(false); router.push(item.href) }}
                style={primary
                  ? { background: '#B9472E', color: '#fff', fontWeight: 700, fontSize: 14, padding: '11px 12px', marginBottom: '10px', boxShadow: '0 2px 6px rgba(185,71,46,0.30)' }
                  : { fontWeight: active ? 600 : undefined, marginBottom: '2px' }}
              >
                <span style={{ color: primary ? '#fff' : '#B9472E', display: 'flex', alignItems: 'center' }}>
                  <Icon size={15} strokeWidth={1.8} />
                </span>
                {item.label}
              </button>
            )
          })}
        </div>

        <ViewModeSidebarSection profile={profile} onSignOut={onSignOut} accountSettingsHref={`/account?returnTo=${BASE}`} />
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
        <div className={`boe-page-body${showLogBar ? ` ${s.fabPad}` : ''}`}>
          <ViewModeBanner />
          {children}
        </div>
        {showLogBar && (
          <Link href={`${BASE}/visit`} className={s.fab} aria-label="Log a vendor visit">
            <Plus size={22} strokeWidth={2.8} aria-hidden="true" /> Log a Visit
          </Link>
        )}
      </div>
    </div>
  )
}
