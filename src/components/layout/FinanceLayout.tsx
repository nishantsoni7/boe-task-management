'use client'

import { useState, useCallback } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { CheckSquare, CreditCard, Bell, Receipt } from 'lucide-react'
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
import { activeFinanceNav, type FinanceNavKey } from '@/lib/navigation/moduleNav'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { ShellHomeLink, ShellNavLink, ShellRefreshButton } from './ModuleShellControls'

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

/**
 * The expense log, and the quick-entry route inside it.
 *
 * MONEY GOING OUT, AND STRUCTURALLY SEPARATE FROM THE TWO PAYMENT SECTIONS
 * ABOVE. An expense has no customer, no PI, no Order, no allocation and no
 * verification; it shares neither a table nor a workflow with a received
 * payment. It is a third Finance section, not a third view of the payments.
 */
export const EXPENSES_PATH = '/finance/expenses'
export const ADD_EXPENSE_PATH = '/finance/expenses/new'

/** The one count the sidebar draws. Module-level, so its identity is stable. */
const SIDEBAR_COUNTED_VIEWS = ['all'] as const

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
  // While a page is still loading it has no profile of its own yet; the
  // session-scoped context already holds the same row (it is the one the module
  // switch reads), so the account block at the foot of the sidebar is drawn
  // from the first frame instead of appearing when the page lands. Display only.
  const { profile: sessionProfile } = usePermissionContext()
  const { triggerRefresh } = useRefresh()
  const queryClient = useQueryClient()

  // Finance-only unread count — drives both the sidebar "Notifications" badge and
  // the pulsing alert block below. Shares the notifications query cache, so
  // marking read anywhere clears it via the existing invalidation.
  const unreadFinance = useUnreadFinanceNotifications()

  // Neutral volume count for the Confirmed Payments entry. Not an unread
  // count: opening the page never changes it.
  // Only "all" is drawn, so only "all" is counted — one head query, not four.
  const receivedCounts = useReceivedPaymentsCounts(SIDEBAR_COUNTED_VIEWS)

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
  //
  // WHICH ONE IS LIT is activeFinanceNav's decision (src/lib/navigation/
  // moduleNav.ts). It used to be an exact path match, so no sub-route of
  // Confirmed Payments, and not the retired Payments to Verify page, lit anything.
  const navItems: { label: string; path: string; icon: React.ReactNode; key: FinanceNavKey; badge?: number }[] = [
    { label: 'Payment Requests',  path: '/finance',              icon: <CheckSquare size={15} strokeWidth={1.8} />, key: 'requests' },
    { label: 'Confirmed Payments', path: RECEIVED_PAYMENTS_PATH,  icon: <CreditCard size={15} strokeWidth={1.8} />, key: 'confirmed', badge: receivedCounts.all },
    // MONEY GOING OUT. Not a third payment section — see EXPENSES_PATH above.
    // No badge: an expense log has no queue and nothing waiting on anybody, so a
    // number beside it would count rows rather than report work.
    { label: 'Expenses',           path: EXPENSES_PATH,           icon: <Receipt size={15} strokeWidth={1.8} />,    key: 'expenses' },
  ]
  const activeKey = activeFinanceNav(pathname)

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
          <ShellHomeLink />
        </div>

        {/* Nav — real links (see ModuleShellControls): new tab, aria-current,
            and Next prefetches each destination's code while it is on screen. */}
        <nav className="boe-sidebar-section" aria-label="Finance">
          {navItems.map(item => (
            <ShellNavLink
              key={item.path}
              href={item.path}
              label={item.label}
              icon={item.icon}
              active={item.key === activeKey}
              onNavigate={() => setSidebarOpen(false)}
              trailing={
                /* Neutral volume badge — grey on grey, never the red
                   unread-alert styling. Hidden at a real zero: a badge
                   reading "0" beside a page with nothing on it describes
                   the same fact twice, once as a number and once as the
                   page's own empty state. */
                typeof item.badge === 'number' && item.badge > 0 ? (
                  <span style={{
                    marginLeft: 'auto', flexShrink: 0,
                    fontSize: '10px', fontWeight: 700, color: '#3D4455',
                    background: 'rgba(0,0,0,0.08)', borderRadius: '999px',
                    padding: '1px 6px', lineHeight: '15px', minWidth: '17px', textAlign: 'center',
                  }}>
                    {item.badge > 999 ? '999+' : item.badge}
                  </span>
                ) : undefined
              }
            />
          ))}

          {/* Permanent Notifications entry — always visible, badge only when
              unread. Scoped to Finance's own notification types, and routes to
              Finance's own notifications page (not the global one). */}
          <NotificationsNavItem
            onNavigate={() => setSidebarOpen(false)}
            count={unreadFinance}
            href="/finance/notifications"
          />
        </nav>

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
          profile={profile ?? sessionProfile}
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
            <h1 className="boe-page-title">{title}</h1>
            {subtitle && <div className="boe-page-subtitle">{subtitle}</div>}
          </div>
          {/* flexWrap + flexShrink let the wider action row (switch + primary +
              refresh) wrap cleanly on narrow screens instead of being clipped
              by .boe-main-content's overflow-x: hidden. Desktop is unaffected. */}
          <div className="boe-header-actions" style={{ flexWrap: 'wrap', flexShrink: 1 }}>
            <ModuleSwitchButton target="orders" />
            {actions}
            <ShellRefreshButton refreshing={refreshing} onRefresh={handleRefresh} />
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
