'use client'

import { useState, useEffect, useCallback } from 'react'
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
import {
  PAYMENT_VIEW_OPTIONS,
  type PaymentView,
} from '@/lib/finance/paymentClassification'

/** The one Received Payments list. Its four views are `?view=` on this route. */
export const RECEIVED_PAYMENTS_PATH = '/finance/received'

type FinanceLayoutProps = {
  profile: UserProfile | null
  title: string
  subtitle?: string
  actions?: React.ReactNode
  onSignOut: () => void
  onRefresh?: () => Promise<void>
  /**
   * Which of the four Received Payments views the reader is on, when they are on
   * that list at all.
   *
   * PASSED IN RATHER THAN READ FROM THE URL. The view lives in `?view=`, and
   * calling useSearchParams here would put every screen that uses this layout
   * behind a Suspense boundary for a highlight only one of them needs. The
   * payments list already resolves the view for its own query; handing the same
   * value to the sidebar is one source rather than two readings of one URL.
   */
  activeReceivedView?: PaymentView
  children: React.ReactNode
}

export function FinanceLayout({
  profile,
  title,
  subtitle,
  actions,
  onSignOut,
  onRefresh,
  activeReceivedView,
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

  // Neutral volume counts for the two Received Payments entries. Not unread
  // counts: opening a page never changes them.
  const receivedCounts = useReceivedPaymentsCounts()

  const handleRefresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    // The Refresh control (and the visibilitychange handler below) re-reads the
    // page; the sidebar counts are part of the same picture, so they are
    // invalidated in the same breath rather than being left to staleTime.
    queryClient.invalidateQueries({ queryKey: RECEIVED_PAYMENTS_COUNTS_KEY })
    if (onRefresh) {
      await onRefresh()
    } else {
      triggerRefresh()
      router.refresh()
    }
    setRefreshing(false)
  }, [refreshing, onRefresh, triggerRefresh, router, queryClient])

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

  const navItems = [
    { label: 'Payment Requests',      path: '/finance',          icon: <CheckSquare size={15} strokeWidth={1.8} /> },
  ]

  // ── Received Payments: one list, four views ──
  //
  // The section used to hold two sibling ROUTES — Linked and Non-Linked — and
  // that split is gone. It could not express a payment divided between an Order
  // and a PI Draft, which belongs in both views at once, and it counted a
  // retired Order Request linkage as though something would still come to
  // collect the money.
  //
  // These four are the canonical classification (paymentClassification.ts), each
  // a `?view=` on the one list. THEY DO NOT SUM TO "All": a split payment with a
  // balance is counted in three of them, because it genuinely is in three.
  //
  // `badge` stays undefined only while the count query is in flight, or when the
  // classification columns are not yet in the database — a real zero renders as
  // "0" rather than disappearing.
  const receivedSubItems: { label: string; path: string; badge: number | undefined }[] =
    PAYMENT_VIEW_OPTIONS.map(option => ({
      label: option.label === 'All' ? 'All Payments' : option.label,
      path: `${RECEIVED_PAYMENTS_PATH}?view=${option.value}`,
      badge: receivedCounts[option.value],
    }))

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
              </button>
            )
          })}

          {/* ── Received Payments ── inert section heading + its two pages.
              Same .boe-nav-item metrics as a real item so the row heights line
              up, but rendered as a div with no hover/press affordance. */}
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: '9px',
              padding: '7px 10px', marginBottom: '2px',
              fontSize: '13px', fontWeight: 500, color: '#6B7384',
              lineHeight: 1.3, userSelect: 'none',
            }}
          >
            <span style={{ color: '#A0A9BE', display: 'flex', alignItems: 'center' }}>
              <CreditCard size={15} strokeWidth={1.8} />
            </span>
            Received Payments
          </div>
          <div
            role="group"
            aria-label="Received Payments"
            style={{
              marginLeft: '17px', paddingLeft: '10px',
              borderLeft: '1px solid rgba(0,0,0,0.09)',
            }}
          >
            {receivedSubItems.map(item => {
              // The view lives in the query string, so `pathname` alone cannot
              // tell these four apart. A screen that is not the payments list
              // passes no view and highlights none of them.
              const active = pathname === RECEIVED_PAYMENTS_PATH
                && activeReceivedView !== undefined
                && item.path.endsWith(`view=${activeReceivedView}`)
              return (
                <button
                  key={item.path}
                  className={`boe-nav-item${active ? ' active' : ''}`}
                  onClick={() => navTo(item.path)}
                  style={{ fontWeight: active ? 600 : 400, marginBottom: '2px', fontSize: '12.5px' }}
                >
                  <span
                    className="boe-nav-dot"
                    style={{ background: active ? '#DC1F2E' : '#A0A9BE' }}
                  />
                  {item.label}
                  {/* Neutral volume badge — grey on grey, never the red
                      unread-alert styling. marginLeft:auto pins it to the
                      trailing edge without disturbing the submenu indent. */}
                  {typeof item.badge === 'number' && (
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
          </div>

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
