'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { LayoutDashboard, List, ClipboardList, Home, RefreshCw, Bell } from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { BoeBrandIcon } from './BoeBrandIcon'
import { ModuleSwitchButton } from './ModuleSwitchButton'
import { useRefresh } from '@/contexts/RefreshContext'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import { NotificationsNavItem } from '@/components/layout/NotificationsNavItem'
import { useUnreadOrderNotifications } from '@/hooks/queries/useUnreadNotifications'
import { useOrderRequestsCount } from '@/hooks/queries/useOrderRequestsCount'

type OrdersLayoutProps = {
  profile: UserProfile | null
  title: string
  subtitle?: string
  actions?: React.ReactNode
  onSignOut: () => void
  onRefresh?: () => Promise<void>
  /**
   * Whether the header shows the refresh control. Defaults to true, so every
   * existing Orders page keeps exactly the header it had.
   *
   * Opt out on a screen with nothing to re-fetch — /orders/import reads a local
   * workbook and holds no server data, so a refresh there would clear nothing
   * and reload nothing.
   */
  showRefresh?: boolean
  children: React.ReactNode
}

export function OrdersLayout({
  profile,
  title,
  subtitle,
  actions,
  onSignOut,
  onRefresh,
  showRefresh = true,
  children,
}: OrdersLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [refreshing,  setRefreshing]  = useState(false)
  const router   = useRouter()
  const pathname = usePathname()
  const { triggerRefresh } = useRefresh()

  // Orders-only unread count — drives both the sidebar "Notifications" badge
  // and this layout's link, scoped to Orders' own notification types.
  const unreadOrders = useUnreadOrderNotifications()

  // Neutral TOTAL count of Order Requests — the same scope as the Order
  // Requests page's "All" tab (every status). Drives the "Order Requests" nav
  // badge below. Unlike unreadOrders this is never an unread/alert count, so
  // reading a request or a notification never changes it, and it never affects
  // the bell block or the Notifications entry's badge styling.
  const orderRequestsCount = useOrderRequestsCount()

  const handleRefresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    if (onRefresh) {
      await onRefresh()
    } else {
      triggerRefresh()
      router.refresh()
    }
    setRefreshing(false)
  }, [refreshing, onRefresh, triggerRefresh, router])

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') handleRefresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const navTo = (path: string) => {
    router.push(path)
    setSidebarOpen(false)
  }

  const navItems: { label: string; path: string; icon: React.ReactNode; exact: boolean; badge?: number }[] = [
    { label: 'Dashboard',       path: '/orders',          icon: <LayoutDashboard size={15} strokeWidth={1.8} />, exact: true },
    { label: 'Confirmed Orders', path: '/orders/all',     icon: <List            size={15} strokeWidth={1.8} />, exact: false },
    // badge stays undefined only while the count query is still loading; a real
    // 0 is passed through and rendered.
    { label: 'Order Requests',  path: '/orders/requests', icon: <ClipboardList   size={15} strokeWidth={1.8} />, exact: false, badge: orderRequestsCount },
  ]

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
              <div className="boe-sidebar-brand-sub">Orders</div>
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

        {/* Nav */}
        <div className="boe-sidebar-section">
          {navItems.map(item => {
            const active = item.exact ? pathname === item.path : pathname.startsWith(item.path)
            return (
              <button
                key={item.path}
                className={`boe-nav-item${active ? ' active' : ''}`}
                onClick={() => navTo(item.path)}
                style={{ fontWeight: active ? 600 : 400, marginBottom: '2px' }}
              >
                <span style={{ color: active ? '#DC1F2E' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
                  {item.icon}
                </span>
                {item.label}
                {/* Neutral volume badge — rendered for any resolved count,
                    including 0 (only a still-loading undefined hides it). Grey
                    on grey, never the red unread-alert styling. */}
                {typeof item.badge === 'number' && (
                  <span style={{
                    marginLeft: 'auto', flexShrink: 0,
                    fontSize: '10px', fontWeight: 700, color: '#3D4455',
                    background: 'rgba(0,0,0,0.08)', borderRadius: '999px',
                    padding: '1px 6px', lineHeight: '15px', minWidth: '17px', textAlign: 'center',
                  }}>
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                )}
              </button>
            )
          })}

          {/* Permanent Notifications entry — always visible, badge only when
              unread. Scoped to Orders' own notification types, and routes to
              Orders' own notifications page (not the global one). */}
          <NotificationsNavItem
            onNavigate={() => setSidebarOpen(false)}
            count={unreadOrders}
            href="/orders/notifications"
          />
        </div>

        {/* ── Notification alert block — same pulsing indicator as Task
            Management and Finance, shown only when Orders has unread
            notifications. Was previously missing from this layout, which is
            why the bell never appeared for Order Request notifications even
            though the sidebar "Notifications" badge above already worked. ── */}
        {unreadOrders > 0 && (
          <div style={{ padding: '0 10px 14px' }}>
            <button
              onClick={() => navTo('/orders/notifications')}
              className="boe-notif-alert"
            >
              <div className="boe-notif-alert-bell">
                <Bell size={24} strokeWidth={1.8} color="#DC1F2E" />
              </div>
              <div style={{
                fontSize: '28px', fontWeight: 800, color: '#111318', lineHeight: 1,
              }}>
                {unreadOrders > 99 ? '99+' : unreadOrders}
              </div>
              <div style={{ fontSize: '11.5px', fontWeight: 600, color: '#3D4455' }}>
                unread {unreadOrders === 1 ? 'notification' : 'notifications'}
              </div>
              <div style={{
                fontSize: '10px', fontWeight: 600, color: '#DC1F2E',
                letterSpacing: '0.05em', textTransform: 'uppercase',
              }}>
                Tap to review →
              </div>
            </button>
          </div>
        )}

        {/* Bottom profile section */}
        <ViewModeSidebarSection
          profile={profile}
          onSignOut={onSignOut}
          accountSettingsHref="/account?returnTo=/orders"
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
          {/* flexWrap + flexShrink let the wider action row (switch + primary +
              refresh) wrap cleanly on narrow screens instead of being clipped
              by .boe-main-content's overflow-x: hidden. Desktop is unaffected. */}
          <div className="boe-header-actions" style={{ flexWrap: 'wrap', flexShrink: 1 }}>
            <ModuleSwitchButton target="finance" profile={profile} />
            {actions}
            {showRefresh && (
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              title="Refresh"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 32, height: 32, borderRadius: '8px',
                background: refreshing ? 'rgba(220,31,46,0.08)' : 'rgba(0,0,0,0.05)',
                border: '1px solid rgba(0,0,0,0.10)',
                color: refreshing ? '#DC1F2E' : '#6B7384',
                cursor: refreshing ? 'default' : 'pointer',
                flexShrink: 0, transition: 'background 0.15s, color 0.15s',
              }}
              onMouseEnter={e => { if (!refreshing) { e.currentTarget.style.background = 'rgba(220,31,46,0.08)'; e.currentTarget.style.color = '#DC1F2E' } }}
              onMouseLeave={e => { if (!refreshing) { e.currentTarget.style.background = 'rgba(0,0,0,0.05)'; e.currentTarget.style.color = '#6B7384' } }}
            >
              <RefreshCw
                size={14}
                strokeWidth={2}
                style={refreshing ? { animation: 'boe-spin 0.7s linear infinite' } : undefined}
              />
            </button>
            )}
          </div>
        </div>

        {/* Page body */}
        <div className="boe-page-body">
          <ViewModeBanner />
          {children}
        </div>

      </div>
    </div>
  )
}
