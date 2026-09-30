'use client'

import { useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { BadgeCheck, History, Home, MessageSquareHeart, PieChart } from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { BoeBrandIcon } from './BoeBrandIcon'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import { NotificationsNavItem } from '@/components/layout/NotificationsNavItem'
import { useUnreadReviewNotifications } from '@/hooks/queries/useUnreadNotifications'
import { useCustomReviewPendingCount } from '@/hooks/queries/useCustomReviewPendingCount'

// The Review Workflow module shell.
//
// Complies with the BOE Module Layout Standard, same as MeetingsLayout: two
// columns, a module header with a Home button back to /modules, module-only
// navigation in the middle, and the shared user area at the bottom. No
// cross-module links.
//
// CUSTOM REVIEWS ONLY. The generated-review workflow (Reviews queue, Batches, Image
// Library, Progress) is deactivated for every role and has no entry here; its
// pages redirect to the landing page and everything behind them is kept.
//
//   My Reviews     the landing page for everyone: the monthly leaderboard, Submit
//                  review, and the employee's own reviews (edit / delete).
//   Custom Submissions  verifiers: open the proof, approve with credits or reject
//                  with a reason. Also the history of every submission, including
//                  approved, rejected and deleted ones. Carries the pending count.
//   Reports        verifiers: custom reviews by month, type and employee; eligible
//                  totals, credits, points and duplicates.
//
// A verifier also gets the module's Notifications entry: custom reviews
// submitted or reapplied for approval are addressed to them.
//
// THERE IS NO ENTRY FOR FINISHED CARDS, AND THAT IS DELIBERATE. A verified card
// is finished, and the product owner's rule is that a finished card appears in
// no frontend list at all. The record and its audit trail stay in the database
// — nothing is deleted — but the module offers no screen that reads them back.

type CustomerReviewsLayoutProps = {
  profile: UserProfile | null
  title: string
  subtitle?: string
  actions?: React.ReactNode
  /** Verifier-only navigation. Hidden entirely for everyone else. */
  canVerify: boolean
  onSignOut: () => void
  children: React.ReactNode
}

type NavItem = {
  label: string
  path: string
  icon: React.ReactNode
  /** Only `pathname === path` lights this item. The module root needs it. */
  exact?: boolean
  verifierOnly?: boolean
  /** Which count this entry carries, if any. */
  count?: 'custom-pending'
}

const NAV_ITEMS: NavItem[] = [
  {
    label: 'My Reviews',
    path: '/customer-reviews',
    icon: <MessageSquareHeart size={15} strokeWidth={1.8} />,
    exact: true,
  },
  {
    label: 'Custom Submissions',
    path: '/customer-reviews/custom',
    icon: <BadgeCheck size={15} strokeWidth={1.8} />,
    verifierOnly: true,
    count: 'custom-pending',
  },
  {
    label: 'History',
    path: '/customer-reviews/history',
    icon: <History size={15} strokeWidth={1.8} />,
    verifierOnly: true,
  },
  {
    label: 'Reports',
    path: '/customer-reviews/reports',
    icon: <PieChart size={15} strokeWidth={1.8} />,
    verifierOnly: true,
  },
]

export function CustomerReviewsLayout({
  profile, title, subtitle, actions, canVerify, onSignOut, children,
}: CustomerReviewsLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const router = useRouter()
  const pathname = usePathname()

  // BOTH COUNTS ARE A VERIFIER'S. A candidate cannot act on the queue, so their
  // sidebar never asks for either number — `enabled` is the resolved `verify`.
  const pendingCustom = useCustomReviewPendingCount(canVerify)
  const unreadReviews = useUnreadReviewNotifications(canVerify)

  const items = NAV_ITEMS
    .filter(item => !item.verifierOnly || canVerify)

  // BY ROUTE, not by query — the same shape MeetingsLayout uses. The root is
  // `exact` because otherwise it would claim every page beneath it.
  //
  // A DETAIL SCREEN LIGHTS NOTHING, deliberately. `/customer-reviews/<id>` is
  // not one of the questions the nav asks, and pretending "Reviews" is selected
  // while somebody reads one card tells them nothing true.
  const isActive = (item: NavItem): boolean =>
    item.exact ? pathname === item.path : pathname.startsWith(item.path)

  const navTo = (item: NavItem) => {
    setSidebarOpen(false)
    router.push(item.path)
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

        <div
          className="boe-sidebar-brand"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <BoeBrandIcon />
            <div>
              <div className="boe-sidebar-brand-name">BOE</div>
              <div className="boe-sidebar-brand-sub">Review Workflow</div>
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

        <div className="boe-sidebar-section">
          {items.map(item => {
            const active = isActive(item)
            const count = item.count === 'custom-pending' ? pendingCustom : undefined
            return (
              <button
                key={item.path}
                className={`boe-nav-item${active ? ' active' : ''}`}
                onClick={() => navTo(item)}
                style={{ fontWeight: active ? 600 : 400, marginBottom: '2px' }}
              >
                <span style={{ color: active ? '#DC1F2E' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
                  {item.icon}
                </span>
                {item.label}
                {/* The same neutral volume badge Finance's sidebar uses. Hidden
                    at zero and while unknown: the queue's own empty state already
                    says there is nothing waiting. */}
                {typeof count === 'number' && count > 0 && (
                  <span
                    aria-label={`${count} waiting for approval`}
                    style={{
                      marginLeft: 'auto', flexShrink: 0,
                      fontSize: '10px', fontWeight: 700, color: '#3D4455',
                      background: 'rgba(0,0,0,0.08)', borderRadius: '999px',
                      padding: '1px 6px', lineHeight: '15px', minWidth: '17px', textAlign: 'center',
                    }}
                  >
                    {count > 999 ? '999+' : count}
                  </span>
                )}
              </button>
            )
          })}

          {/* The module's own Notifications entry, for the people its rows are
              addressed to. Scoped to the Review Workflow's notification types. */}
          {canVerify && (
            <NotificationsNavItem
              onNavigate={() => setSidebarOpen(false)}
              count={unreadReviews}
              href="/customer-reviews/notifications"
            />
          )}
        </div>

        <ViewModeSidebarSection
          profile={profile}
          onSignOut={onSignOut}
          accountSettingsHref="/account?returnTo=/customer-reviews"
        />

      </aside>

      {/* Main content */}
      <div className="boe-main-content">

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

        <div className="boe-page-body">
          <ViewModeBanner />
          {children}
        </div>

      </div>
    </div>
  )
}
