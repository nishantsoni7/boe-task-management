'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Activity, Factory, Home, Plus, UserPlus } from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { useVendorAccess } from '@/hooks/useVendors'
import { BoeBrandIcon } from './BoeBrandIcon'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import s from '@/components/vendors/vendors.module.css'

// The Vendors module shell — the BOE Module Layout Standard: two columns, a module header with Home → /modules,
// module-only navigation, and the shared user area at the bottom.

const BASE = '/vendors'

const NAV_ITEMS = [
  { href: `${BASE}/visit`, label: 'Log Visit', icon: Plus, needs: 'create' },
  { href: `${BASE}/new`, label: 'Add Vendor', icon: UserPlus, needs: 'create' },
  { href: BASE, label: 'All Vendors', icon: Factory, needs: null },
  { href: `${BASE}/activity`, label: 'Visit Activity', icon: Activity, needs: 'activity' },
] as const

type Props = {
  profile: UserProfile | null
  /** Kept for the callers; the nav reads the access flags itself. */
  isAdmin?: boolean
  title: string
  subtitle?: string
  actions?: React.ReactNode
  onSignOut: () => void
  children: React.ReactNode
}

export function VendorsLayout({ profile, title, subtitle, actions, onSignOut, children }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { canCreate, canSeeActivity } = useVendorAccess(profile)
  const router = useRouter()
  const pathname = usePathname()
  const showLogBar = canCreate && !pathname.startsWith(`${BASE}/visit`)

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
          {NAV_ITEMS.filter(item => item.needs === null || (item.needs === 'create' ? canCreate : canSeeActivity)).map(item => {
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
                  ? { background: '#B9472E', color: '#fff', fontWeight: 500, fontSize: 13.5, padding: '8px 12px', marginBottom: '8px' }
                  : { fontWeight: active ? 500 : 400, fontSize: 13.5, marginBottom: '2px' }}
              >
                <span style={{ color: primary ? '#fff' : active ? '#37352F' : '#8A8782', display: 'flex', alignItems: 'center' }}>
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
            <Plus size={18} strokeWidth={2.4} aria-hidden="true" /> Log visit
          </Link>
        )}
      </div>
    </div>
  )
}
