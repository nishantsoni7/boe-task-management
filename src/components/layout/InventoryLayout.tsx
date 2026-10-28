'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { ClipboardList, Home, LayoutGrid, Plus } from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import type { InventoryAccess } from '@/lib/inventory/constants'
import { BoeBrandIcon } from './BoeBrandIcon'
import { NotificationsNavItem } from '@/components/layout/NotificationsNavItem'
import { useUnreadInventoryNotifications } from '@/hooks/queries/useUnreadNotifications'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import s from '@/components/inventory/inventory.module.css'
import { SidebarPinButton, railShellClass, useSidebarPinned } from './RailControls'

// The Inventory module shell — the BOE Module Layout Standard: two columns, a module header with Home →
// /modules, module-only navigation, and the shared user area at the bottom.

const BASE = '/inventory'

type Props = {
  profile: UserProfile | null
  access: InventoryAccess
  /** Requests waiting for a decision. */
  pending: number
  title: string
  subtitle?: string
  actions?: React.ReactNode
  /** The phone's big "Add product" bar; the stock list asks for it. */
  showAddBar?: boolean
  onSignOut: () => void
  children: React.ReactNode
}

export function InventoryLayout({ profile, access, pending, title, subtitle, actions, showAddBar, onSignOut, children }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // Desktop-with-a-mouse only: the sidebar rests as an icon rail and opens over
  // the page on hover, unless pinned. Elsewhere this changes nothing.
  const [railPinned, toggleRailPinned] = useSidebarPinned()
  const router = useRouter()
  const pathname = usePathname()
  const unread = useUnreadInventoryNotifications()

  const items = [
    { href: BASE, label: 'Stock', icon: LayoutGrid, exact: true, badge: 0 },
    ...(access.create ? [{ href: `${BASE}/new`, label: 'Add Product', icon: Plus, exact: true, badge: 0, primary: true }] : []),
    { href: `${BASE}/requests`, label: access.approve ? 'Booking Requests' : 'My Requests', icon: ClipboardList, exact: false, badge: pending },
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
              <div className="boe-sidebar-brand-sub">Inventory</div>
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
            const active = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`)
            const Icon = item.icon
            const primary = 'primary' in item && item.primary
            return (
              <button
                key={item.href}
                className={`boe-nav-item${active ? ' active' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => { setSidebarOpen(false); router.push(item.href) }}
                title={item.label}
                style={primary
                  ? { background: '#B9472E', color: '#fff', fontWeight: 700, fontSize: 14, padding: '11px 12px', marginBottom: '10px', boxShadow: '0 2px 6px rgba(185,71,46,0.30)' }
                  : { fontWeight: active ? 600 : undefined, marginBottom: '2px' }}
              >
                <span style={{ color: primary ? '#fff' : '#B9472E', display: 'flex', alignItems: 'center' }}>
                  <Icon size={15} strokeWidth={1.8} />
                </span>
                <span className="boe-rail-label">{item.label}</span>
                {item.badge > 0 && <span className={`${s.navBadge} boe-nav-count`} aria-label={`${item.badge} waiting`}>{item.badge}</span>}
              </button>
            )
          })}
          <NotificationsNavItem onNavigate={() => setSidebarOpen(false)} count={unread} href={`${BASE}/notifications`} />
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
        <div className={`boe-page-body${showAddBar ? ` ${s.fabPad}` : ''}`}>
          <ViewModeBanner />
          {children}
        </div>
        {showAddBar && (
          <Link href={`${BASE}/new`} className={s.fab} aria-label="Add a new product">
            <Plus size={22} strokeWidth={2.8} aria-hidden="true" /> Add Product
          </Link>
        )}
      </div>
    </div>
  )
}
