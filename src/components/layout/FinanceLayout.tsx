'use client'

import { useState, useCallback } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { CheckSquare, CreditCard, Home, RefreshCw, Bell } from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { BoeBrandIcon } from './BoeBrandIcon'
import { ModuleSwitchButton } from './ModuleSwitchButton'
import { useRefresh } from '@/contexts/RefreshContext'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import { NotificationsNavItem } from '@/components/layout/NotificationsNavItem'
import { useUnreadFinanceNotifications } from '@/hooks/queries/useUnreadNotifications'
import {
  useReceivedPaymentsCounts,
  RECEIVED_PAYMENTS_COUNTS_KEY,
} from '@/hooks/queries/useReceivedPaymentsCounts'
import { useQueryClient } from '@tanstack/react-query'

/**
 * The one Received Payments list — now ONE nav entry, no `?view=` sub-items.
 *
 * ONLY TWO PRIMARY PAYMENT SECTIONS, per the current requirement: Payment
 * Requests and Confirmed Payments. Payments to Verify is no longer a separate
 * top-level entry — verifying is already covered from Payment Requests — and
 * the four Confirmed Payments sub-views (All / Orders / PI Drafts / Available)
 * are retired from the sidebar in favour of an IN-PAGE filter bar over
 * `confirmed_allocation_status` (see ReceivedPaymentsView.tsx). Neither route
 * is deleted — /finance/payments-to-verify still renders and still works for
 * anyone who lands on it directly — only the sidebar entries are gone.
 */
export const RECEIVED_PAYMENTS_PATH = '/finance/received'

type FinanceLayoutProps = {
  profile: UserProfile | null
  title: string
  subtitle?: string
  actions?: React.ReactNode
  onSignOut: () => void
  onRefresh?: () => Promise<void>
  children: React.ReactNode
}

export function FinanceLayout({
  profile,
  title,
  subtitle,
  actions,
  onSignOut,
  onRefresh,
  children,
}: FinanceLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [refreshing,  setRefreshing]  = useState(false)
  const router   = useRouter()
  const pathname = usePathname()
  const { triggerRefresh } = useRefresh()
  const queryClient = useQueryClient()

  // Finance-only unread count — drives both the sidebar "Notifications" badge and
  // the pulsing alert block below. Shares the notifications query cache, so
  // marking read anywhere clears it via the existing invalidation.
  const unreadFinance = useUnreadFinanceNotifications()

  // Neutral volume count for the Confirmed Payments entry. Not an unread
  // count: opening the page never changes it.
  const receivedCounts = useReceivedPaymentsCounts()

  const handleRefresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    // The Refresh control re-reads the page; the sidebar count is part of the
    // same picture, so it is invalidated in the same breath rather than being
    // left to staleTime.
    queryClient.invalidateQueries({ queryKey: RECEIVED_PAYMENTS_COUNTS_KEY })
    if (onRefresh) {
      await onRefresh()
    } else {
      triggerRefresh()
      router.refresh()
    }
    setRefreshing(false)
  }, [refreshing, onRefresh, triggerRefresh, router, queryClient])

  // ── NOTHING RE-FETCHES WHEN THE TAB COMES BACK ──
  //
  // THE CAUSE, NAMED. There was a `visibilitychange` listener here that called
  // handleRefresh() every time this document became visible again. OrdersLayout
  // removed its copy of the same listener and explained why; Finance kept one,
  // which is why an Order page survived an alt-tab and a Finance page did not.
  //
  // What it actually did, on every return however brief:
  //
  //   * called the page's own onRefresh — for Confirmed Payments and Payments
  //     to Verify that is loadRequests(), which sets listLoading and repaints
  //     the table, so a glance at another tab threw away the scroll position
  //     and made the rows jump under a reader's cursor;
  //   * invalidated RECEIVED_PAYMENTS_COUNTS_KEY, so the sidebar badges went
  //     blank and came back;
  //   * ran router.refresh() on any page that passes no onRefresh, remounting
  //     the tree — which is what closed an open modal and discarded a
  //     half-typed correction note;
  //   * captured handleRefresh from the FIRST render (empty dependency array,
  //     with an eslint-disable to keep it quiet), so what it called was not
  //     necessarily the handler the screen had by then.
  //
  // Returning to a tab is not a request for anything. Filters, pagination,
  // scroll, an open modal and a partly-typed form all survive it now.
  //
  // WHAT STILL UPDATES THE SCREEN, unchanged: the Refresh control in the header
  // (handleRefresh, which also invalidates the counts); every mutation, which
  // reloads the list it changed; verification, allocation and reversal, for the
  // same reason; a real navigation, which mounts; and a page's own load on
  // mount. React Query is configured with refetchOnWindowFocus: false in
  // Providers.tsx, so there is ONE answer to "does focus refetch": no.
  //
  // SESSION EXPIRY IS UNTOUCHED. That is the Supabase client's business and
  // AuthIdentityBoundary's, not this layout's, and neither is changed here.
  // Nothing is replaced with polling.

  const navTo = (path: string) => {
    router.push(path)
    setSidebarOpen(false)
  }

  // EXACTLY TWO PRIMARY PAYMENT SECTIONS. Payment Requests is a structurally
  // separate record with its own lifecycle, not a view of the payments table
  // and nothing to do with the retired Order Requests. Confirmed Payments is
  // the one list of money that has arrived — its former four `?view=`
  // sub-items (All / Orders / PI Drafts / Available) are retired from the
  // sidebar in favour of the in-page allocation-status filter bar, and the
  // former standalone "Payments to Verify" entry is gone too: verifying a
  // payment is already reachable from Payment Requests, so a third top-level
  // section for it duplicated a workflow rather than adding one. `badge` is
  // undefined only while the count query is in flight, or when the
  // classification columns are not yet in the database — a real zero is
  // rendered as no badge at all (see the `> 0` guard below), matching the
  // Confirmed Payments page's own empty state rather than showing a "0" next
  // to a page that has nothing on it.
  const navItems: { label: string; path: string; icon: React.ReactNode; badge?: number }[] = [
    { label: 'Payment Requests',  path: '/finance',              icon: <CheckSquare size={15} strokeWidth={1.8} /> },
    { label: 'Confirmed Payments', path: RECEIVED_PAYMENTS_PATH,  icon: <CreditCard size={15} strokeWidth={1.8} />, badge: receivedCounts.all },
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
              <div className="boe-sidebar-brand-sub">Finance</div>
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
            const active = pathname === item.path
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
                {/* Neutral volume badge — grey on grey, never the red
                    unread-alert styling. Hidden at a real zero: a badge
                    reading "0" beside a page with nothing on it describes
                    the same fact twice, once as a number and once as the
                    page's own empty state. */}
                {typeof item.badge === 'number' && item.badge > 0 && (
                  <span style={{
                    marginLeft: 'auto', flexShrink: 0,
                    fontSize: '10px', fontWeight: 700, color: '#3D4455',
                    background: 'rgba(0,0,0,0.08)', borderRadius: '999px',
                    padding: '1px 6px', lineHeight: '15px', minWidth: '17px', textAlign: 'center',
                  }}>
                    {item.badge > 999 ? '999+' : item.badge}
                  </span>
                )}
              </button>
            )
          })}

          {/* Permanent Notifications entry — always visible, badge only when
              unread. Scoped to Finance's own notification types, and routes to
              Finance's own notifications page (not the global one). */}
          <NotificationsNavItem
            onNavigate={() => setSidebarOpen(false)}
            count={unreadFinance}
            href="/finance/notifications"
          />
        </div>

        {/* ── Notification alert block — same pulsing indicator as Task Management,
            shown only when Finance has unread notifications. ── */}
        {unreadFinance > 0 && (
          <div style={{ padding: '0 10px 14px' }}>
            <button
              onClick={() => navTo('/finance/notifications')}
              className="boe-notif-alert"
            >
              <div className="boe-notif-alert-bell">
                <Bell size={24} strokeWidth={1.8} color="#DC1F2E" />
              </div>
              <div style={{
                fontSize: '28px', fontWeight: 800, color: '#111318', lineHeight: 1,
              }}>
                {unreadFinance > 99 ? '99+' : unreadFinance}
              </div>
              <div style={{ fontSize: '11.5px', fontWeight: 600, color: '#3D4455' }}>
                unread {unreadFinance === 1 ? 'notification' : 'notifications'}
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
          accountSettingsHref="/account?returnTo=/finance"
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
            <ModuleSwitchButton target="orders" profile={profile} />
            {actions}
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
