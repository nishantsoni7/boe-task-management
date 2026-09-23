'use client'

import { useState, useCallback } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { LayoutDashboard, List, FileText, Bell } from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { BoeBrandIcon } from './BoeBrandIcon'
import { ModuleSwitchButton } from './ModuleSwitchButton'
import { useRefresh } from '@/contexts/RefreshContext'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import { NotificationsNavItem } from '@/components/layout/NotificationsNavItem'
import { useUnreadOrderNotifications } from '@/hooks/queries/useUnreadNotifications'
import { activeOrdersNav, type OrdersNavKey } from '@/lib/navigation/moduleNav'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { ShellHomeLink, ShellNavLink, ShellRefreshButton } from './ModuleShellControls'

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
  /** False on the one screen that answers its own Finance questions. */
  showModuleSwitch?: boolean
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
  showModuleSwitch = true,
  children,
}: OrdersLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [refreshing,  setRefreshing]  = useState(false)
  const router   = useRouter()
  const pathname = usePathname()
  // While a page is still loading it has no profile of its own yet; the
  // session-scoped context already holds the same row (it is the one the module
  // switch reads), so the account block at the foot of the sidebar is drawn
  // from the first frame instead of appearing when the page lands. Display only.
  const { profile: sessionProfile } = usePermissionContext()
  const { triggerRefresh } = useRefresh()

  // Orders-only unread count — drives both the sidebar "Notifications" badge
  // and this layout's link, scoped to Orders' own notification types.
  const unreadOrders = useUnreadOrderNotifications()

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

  // ── NOTHING RE-FETCHES WHEN THE TAB COMES BACK ──
  //
  // There used to be a `visibilitychange` listener here that called
  // handleRefresh() every time this document became visible again. It was
  // written for the dashboard, where a re-read is cheap and invisible, and it
  // was quietly wrong for every screen that owns state:
  //
  //   * on a record page it called the page's own onRefresh, which swaps the
  //     record for a loading state — so glancing at another tab and coming back
  //     blanked the screen, threw away the scroll position, and closed an open
  //     image viewer mid-comparison;
  //   * it fired on EVERY return, however brief, including an alt-tab to copy a
  //     value out of another window;
  //   * it captured handleRefresh from the first render (the effect has no
  //     dependencies and an eslint-disable to match), so what it called was not
  //     necessarily the handler the screen had by then.
  //
  // Returning to a tab is not a request for anything. A person who wants fresh
  // data presses the refresh control in the header, which still does exactly
  // what it always did; a page that needs fresh data on arrival loads it on
  // mount, which is untouched. Nothing here interferes with session expiry
  // either — that is the Supabase client's business, not this layout's.
  //
  // React Query is already configured with refetchOnWindowFocus: false in
  // Providers.tsx, so the badge counts above agree with this and there is one
  // answer to "does focus refetch": no.

  const navTo = (path: string) => {
    router.push(path)
    setSidebarOpen(false)
  }

  const activeKey = activeOrdersNav(pathname)

  // ── THREE DESTINATIONS, AND THE RETIRED ONE IS NOT AMONG THEM ──
  //
  // Order Requests used to sit between Confirmed Orders and PI Drafts, carrying
  // a company-wide volume badge. That workflow is retired: the only path to a
  // Confirmed Order is now PI upload → PI Draft → review → approval, so an entry
  // into it would be an invitation to start something that can no longer finish.
  // The route itself still answers — it explains the retirement and offers PI
  // Drafts — so an old bookmark lands somewhere sensible rather than on a 404.
  //
  // NO BADGE ON PI DRAFTS, deliberately. Drafts are a personal working set whose
  // size is nobody else's business, and a number here would cost a query on
  // every Orders page for something with no decision attached to it.
  //
  // WHICH ONE IS LIT is activeOrdersNav's decision (src/lib/navigation/
  // moduleNav.ts), not a prefix test written here: an Order record lights
  // Confirmed Orders, and Upload PI and a PI record light PI Drafts.
  const navItems: { label: string; path: string; icon: React.ReactNode; key: OrdersNavKey }[] = [
    { label: 'Dashboard',        path: '/orders',        icon: <LayoutDashboard size={15} strokeWidth={1.8} />, key: 'dashboard' },
    { label: 'PI Drafts',        path: '/orders/drafts', icon: <FileText        size={15} strokeWidth={1.8} />, key: 'drafts' },
    { label: 'Confirmed Orders', path: '/orders/all',    icon: <List            size={15} strokeWidth={1.8} />, key: 'confirmed' },
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
          <ShellHomeLink />
        </div>

        {/* Nav — real links (see ModuleShellControls): new tab, aria-current,
            and Next prefetches each destination's code while it is on screen. */}
        <nav className="boe-sidebar-section" aria-label="Orders">
          {navItems.map(item => (
            <ShellNavLink
              key={item.path}
              href={item.path}
              label={item.label}
              icon={item.icon}
              active={item.key === activeKey}
              onNavigate={() => setSidebarOpen(false)}
            />
          ))}

          {/* Permanent Notifications entry — always visible, badge only when
              unread. Scoped to Orders' own notification types, and routes to
              Orders' own notifications page (not the global one). */}
          <NotificationsNavItem
            onNavigate={() => setSidebarOpen(false)}
            count={unreadOrders}
            href="/orders/notifications"
          />
        </nav>

        {/* ── Notification alert block — same pulsing indicator as Task
            Management and Finance, shown only when Orders has unread
            notifications. Was previously missing from this layout, which is
            why the bell never appeared for Orders notifications even though the
            sidebar "Notifications" badge above already worked. ── */}
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
          profile={profile ?? sessionProfile}
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
            <h1 className="boe-page-title">{title}</h1>
            {subtitle && <div className="boe-page-subtitle">{subtitle}</div>}
          </div>
          {/* flexWrap + flexShrink let the wider action row (switch + primary +
              refresh) wrap cleanly on narrow screens instead of being clipped
              by .boe-main-content's overflow-x: hidden. Desktop is unaffected. */}
          <div className="boe-header-actions" style={{ flexWrap: 'wrap', flexShrink: 1 }}>
            {/* ── Switch to Finance ──
                OFFERED ON EVERY ORDERS SCREEN BUT ONE. The Confirmed Order
                detail page answers its own money questions — what is verified,
                what is awaiting, what remains, and which payments make up each
                — in a section and two dialogs of its own, so the switch there
                only invited a reader to leave the page they were reading to
                look up something it already states. Every other Orders screen
                keeps it, and the button, its permission rule and the Finance
                module are untouched. */}
            {showModuleSwitch && <ModuleSwitchButton target="finance" />}
            {actions}
            {showRefresh && (
              <ShellRefreshButton refreshing={refreshing} onRefresh={handleRefresh} />
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
