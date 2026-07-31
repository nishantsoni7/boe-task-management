'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Monitor, Key,
  Package, ShieldCheck, ClipboardList,
  Home,
} from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { BoeBrandIcon } from './BoeBrandIcon'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import { MobileBottomNav } from '@/components/layout/MobileBottomNav'
import { NotificationsNavItem } from '@/components/layout/NotificationsNavItem'
import { useUnreadAssetNotifications } from '@/hooks/queries/useUnreadNotifications'

export type AssetsView =
  // All users
  | 'my-assets'
  | 'my-access'
  // Requires an Assets & Access management permission
  | 'asset-inventory'
  | 'access-register'
  // Requesters see their own; an admin sees everyone's, with Approve/Reject
  | 'asset-requests'

type AssetsLayoutProps = {
  profile: UserProfile | null
  /**
   * Which sidebar entry is current. Optional because the module's sub-pages
   * (the asset detail page, the notifications page) are routes rather than
   * views — they highlight nothing, or highlight the list they belong to.
   */
  activeView?: AssetsView
  /**
   * How a sidebar click is handled. Optional: the single-page inventory passes
   * its own state setter, and every sub-page omits it and gets navigation back
   * to /assets-access?view=… instead. A sub-page must never have to reimplement
   * the sidebar to be reachable from it.
   */
  onViewChange?: (view: AssetsView) => void
  title: string
  subtitle?: string
  /** Header-right controls, matching OrdersLayout / FinanceLayout. */
  actions?: React.ReactNode
  onSignOut: () => void
  /** Asset Inventory nav — resolve_permission('assets_access', view|manage). */
  canViewInventory: boolean
  /** Access Register nav — admin only while secret_value is plaintext. */
  canManageAccess: boolean
  /** Asset Requests nav — an admin reviewing, or a requester tracking their own. */
  canSeeAssetRequests: boolean
  children: React.ReactNode
}

/** Where a sidebar entry lives when the sidebar has to navigate rather than switch state. */
const VIEW_HREF = (view: AssetsView) => `/assets-access?view=${view}`

const USER_NAV: { view: AssetsView; label: string; icon: React.ReactNode }[] = [
  { view: 'my-assets', label: 'My Assets', icon: <Monitor size={15} strokeWidth={1.8} /> },
  { view: 'my-access', label: 'My Access', icon: <Key     size={15} strokeWidth={1.8} /> },
]

const INVENTORY_NAV: { view: AssetsView; label: string; icon: React.ReactNode } =
  { view: 'asset-inventory', label: 'Asset Inventory', icon: <Package size={15} strokeWidth={1.8} /> }

const ACCESS_NAV: { view: AssetsView; label: string; icon: React.ReactNode } =
  { view: 'access-register', label: 'Access Register', icon: <ShieldCheck size={15} strokeWidth={1.8} /> }

const REQUESTS_NAV: { view: AssetsView; label: string; icon: React.ReactNode } =
  { view: 'asset-requests', label: 'Asset Requests', icon: <ClipboardList size={15} strokeWidth={1.8} /> }

export function AssetsLayout({
  profile,
  activeView,
  onViewChange,
  title,
  subtitle,
  actions,
  onSignOut,
  canViewInventory,
  canManageAccess,
  canSeeAssetRequests,
  children,
}: AssetsLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const router = useRouter()
  const unreadAssets = useUnreadAssetNotifications()

  const managementNav = [
    ...(canViewInventory ? [INVENTORY_NAV] : []),
    ...(canSeeAssetRequests ? [REQUESTS_NAV] : []),
    ...(canManageAccess ? [ACCESS_NAV] : []),
  ]

  // Without an onViewChange the sidebar navigates instead of switching local
  // state, so the same shell works on the single-page inventory AND on the
  // detail / notifications routes.
  const handleNav = (view: AssetsView) => {
    setSidebarOpen(false)
    if (onViewChange) onViewChange(view)
    else router.push(VIEW_HREF(view))
  }

  const NavItem = ({ view, label, icon }: { view: AssetsView; label: string; icon: React.ReactNode }) => {
    const active = activeView === view
    return (
      <button
        className={`boe-nav-item${active ? ' active' : ''}`}
        onClick={() => handleNav(view)}
        style={{ fontWeight: active ? 600 : 400, marginBottom: '2px' }}
      >
        <span style={{ color: active ? '#DC1F2E' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
          {icon}
        </span>
        {label}
      </button>
    )
  }

  return (
    <div className="boe-app-shell">

      {/* Mobile overlay */}
      <div
        className={`boe-sidebar-overlay${sidebarOpen ? ' open' : ''}`}
        onClick={() => setSidebarOpen(false)}
      />

      {/* Sidebar */}
      <aside className={`boe-sidebar${sidebarOpen ? ' open' : ''}`}>

        {/* Brand header */}
        <div className="boe-sidebar-brand" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <BoeBrandIcon />
            <div>
              <div className="boe-sidebar-brand-name">BOE</div>
              <div className="boe-sidebar-brand-sub">Assets &amp; Access</div>
            </div>
          </div>
          <button
            onClick={() => router.push('/modules')}
            title="BOE OS Home"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: '7px',
              background: 'rgba(220,31,46,0.08)',
              border: '1px solid rgba(220,31,46,0.20)',
              color: '#DC1F2E', cursor: 'pointer', flexShrink: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(220,31,46,0.10)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(220,31,46,0.08)' }}
          >
            <Home size={14} strokeWidth={2} />
          </button>
        </div>

        {/* Nav — self-entry (all users) */}
        <div className="boe-sidebar-section">
          <div style={{
            fontSize: '10px', fontWeight: 700, color: '#8C94A6',
            textTransform: 'uppercase', letterSpacing: '0.06em',
            padding: '4px 10px 6px',
          }}>
            My Records
          </div>
          {USER_NAV.map(item => (
            <NavItem key={item.view} {...item} />
          ))}

          {/* Assets' own notification feed, scoped to `asset_%` types. Never
              hidden by count — the entry is how you get to the history, not
              just to what is unread. */}
          <NotificationsNavItem
            href="/assets-access/notifications"
            count={unreadAssets}
            onNavigate={() => setSidebarOpen(false)}
          />

          {/* Management section — permission-gated, not role-gated */}
          {managementNav.length > 0 && (
            <>
              <div style={{
                fontSize: '10px', fontWeight: 700, color: '#8C94A6',
                textTransform: 'uppercase', letterSpacing: '0.06em',
                padding: '14px 10px 6px',
              }}>
                Management
              </div>
              {managementNav.map(item => (
                <NavItem key={item.view} {...item} />
              ))}
            </>
          )}
        </div>

        {/* Bottom profile */}
        <ViewModeSidebarSection
          profile={profile}
          onSignOut={onSignOut}
          accountSettingsHref="/account?returnTo=/assets-access"
        />

      </aside>

      {/* Main content */}
      <div className="boe-main-content">

        {/* Page header */}
        <div className="boe-page-header">
          <button
            className="boe-menu-toggle"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
          >
            ☰
          </button>
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

        {/* Page body */}
        <div className="boe-page-body">
          <ViewModeBanner />
          {children}
        </div>

      </div>

      <MobileBottomNav profile={profile} onSignOut={onSignOut} />

    </div>
  )
}
