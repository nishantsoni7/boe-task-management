'use client'

// The ONE shell for the combined Attendance & Payroll module.
//
// This replaces AttendanceLayout and PayrollLayout, which were two copies of
// the same component differing only in the brand sub-label and the sidebar
// array. Anything fixed in one of them had to be remembered in the other, and
// twice it was not.
//
// One shell, one nav definition (attendancePayrollNav.tsx), one brand. The
// mobile menu is this same <aside> with `.open` toggled, so desktop and mobile
// render the identical list — there is no second menu to keep in step.
//
// Page anatomy, top to bottom, the same on every page of the module:
//
//   header       title · one-line description · the page's primary action ·
//                notification bell · refresh
//   section tabs one row, only for a section that groups several pages
//   body         the page (status filters, tables and forms live here)
//
// What this does NOT merge: the guards. /attendance is still behind
// AttendanceGuard and /payroll behind PayrollGuard, both of which resolve
// admin-only management access independently of anything here. A sidebar is a
// convenience, never an authorisation — see resolveManagementAccess in
// src/lib/moduleAccess.ts.

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import { Home, RefreshCw } from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { BoeBrandIcon } from './BoeBrandIcon'
import { useRefresh } from '@/contexts/RefreshContext'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import { IssueNotificationBell } from '@/components/layout/IssueNotificationBell'
import { ModuleSectionTabs } from '@/components/layout/ModuleSectionTabs'
import { useUnreadAttendancePayrollNotifications } from '@/hooks/queries/useUnreadNotifications'
import {
  ATTENDANCE_PAYROLL_MODULE_NAME,
  adminSectionFor,
  attendancePayrollNavFor,
  isAttendancePayrollNavItemActive,
  notificationsPathFor,
} from './attendancePayrollNav'
import styles from './attendancePayrollShell.module.css'

type AttendancePayrollLayoutProps = {
  profile: UserProfile | null
  title: string
  subtitle?: string
  actions?: React.ReactNode
  onSignOut: () => void
  children: React.ReactNode
}

export function AttendancePayrollLayout({
  profile,
  title,
  subtitle,
  actions,
  onSignOut,
  children,
}: AttendancePayrollLayoutProps) {
  const router   = useRouter()
  const pathname = usePathname()
  // The drawer is open only for the page it was opened on, so it closes on ANY
  // route change — a sidebar link, a tab, the bell, the browser's Back button —
  // without an effect to reset it.
  const [drawerOpenedAt, setDrawerOpenedAt] = useState<string | null>(null)
  const sidebarOpen = drawerOpenedAt === pathname
  const setSidebarOpen = (open: boolean) => setDrawerOpenedAt(open ? pathname : null)
  const [refreshing,  setRefreshing]  = useState(false)
  const { triggerRefresh } = useRefresh()

  const handleRefresh = useCallback(() => {
    if (refreshing) return
    setRefreshing(true)
    triggerRefresh()
    router.refresh()
    setTimeout(() => setRefreshing(false), 1000)
  }, [refreshing, triggerRefresh, router])

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') handleRefresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // This shell renders both the management screens (/attendance/*, /payroll/*)
  // and the self-service ones (/my-attendance, /my-payroll, /my-issues). Every
  // management destination is admin-only, so showing them to a non-admin only
  // produces links that bounce off the module guard. Hiding them is a usability
  // fix, never the control — the guards, the API routes and RLS are what
  // actually refuse the access.
  const isAdmin = profile?.role === 'admin'

  const navItems = attendancePayrollNavFor(!!isAdmin)

  // The tab row belongs to the admin section the URL is in. An employee's
  // sidebar is flat, and a page outside every section (notifications, the
  // account page) has no row.
  const section = isAdmin ? adminSectionFor(pathname) : null

  // Employee-raised attendance and payroll issues: one category, one query key,
  // one count, whichever page of the module you are on.
  //
  // Requested for EVERYONE. It used to be admin-only because every row of this
  // category was addressed to an admin, so an employee's count could only ever
  // have been zero. Since an admin's decision notifies the employee who raised
  // the issue, an employee has rows of their own here — and a bell that never
  // lights up for the one person waiting on an answer was the whole complaint.
  // Rows stay pinned to `user_id = caller` in every endpoint, so this widens the
  // FEED and not the visibility of anybody's data.
  const unreadIssues = useUnreadAttendancePayrollNotifications()

  // Admins review the whole company's issues at /attendance/notifications, which
  // is behind AttendanceGuard. An employee's door onto the same feed is their
  // own page. ONE door per role; /payroll/notifications still resolves — it is
  // the same shared feed and old links must keep working.
  const notificationsHref = notificationsPathFor(!!isAdmin)

  return (
    <div className="boe-app-shell">

      {/* Mobile overlay */}
      <div
        className={`boe-sidebar-overlay${sidebarOpen ? ' open' : ''}`}
        onClick={() => setSidebarOpen(false)}
      />

      {/* Sidebar — the same element on desktop and mobile */}
      <aside className={`boe-sidebar${sidebarOpen ? ' open' : ''}`}>

        {/* Brand header */}
        <div className="boe-sidebar-brand" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <BoeBrandIcon />
            <div>
              <div className="boe-sidebar-brand-name">BOE</div>
              <div className="boe-sidebar-brand-sub">{ATTENDANCE_PAYROLL_MODULE_NAME}</div>
            </div>
          </div>
          <button
            onClick={() => router.push('/modules')}
            title="BOE OS Home"
            aria-label="BOE OS Home"
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

        {/* Nav — real links, so each one prefetches, opens in a new tab and
            announces itself with aria-current. */}
        <nav className="boe-sidebar-section" aria-label={`${ATTENDANCE_PAYROLL_MODULE_NAME} sections`}>
          {navItems.map(item => {
            // Admin sections light for every page inside them (a tab's page, a
            // payslip, an employee record). Employee entries use the path rules.
            const active = isAdmin
              ? section?.path === item.path
              : isAttendancePayrollNavItemActive(pathname, item)
            return (
              <Link
                key={item.path}
                href={item.path}
                className={`boe-nav-item${active ? ' active' : ''}`}
                aria-current={active ? 'page' : undefined}
                style={{ fontWeight: active ? 600 : 400, marginBottom: '2px' }}
              >
                <span aria-hidden="true" style={{ color: active ? '#DC1F2E' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
                  {item.icon}
                </span>
                {item.label}
              </Link>
            )
          })}
        </nav>

        {/* Bottom profile section */}
        <ViewModeSidebarSection
          profile={profile}
          onSignOut={onSignOut}
          // Back to the page they left, rather than to whichever half of the
          // module the old two shells happened to name.
          accountSettingsHref={`/account?returnTo=${encodeURIComponent(pathname)}`}
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
          <div className="boe-header-actions">
            {actions}
            {/* The module's one door onto the notification feed, with its
                unread count — see IssueNotificationBell. */}
            <IssueNotificationBell unread={unreadIssues} href={notificationsHref} />
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              title="Refresh"
              aria-label="Refresh"
              className={`${styles.iconBtn}${refreshing ? ` ${styles.iconBtnActive}` : ''}`}
            >
              <RefreshCw
                size={14}
                strokeWidth={2}
                className={refreshing ? styles.spin : undefined}
                aria-hidden="true"
              />
            </button>
          </div>
        </div>

        {/* Section tabs — one row, beneath the header */}
        {section && <ModuleSectionTabs section={section} pathname={pathname} />}

        {/* Page body */}
        <div className="boe-page-body">
          <ViewModeBanner />
          {children}
        </div>

      </div>
    </div>
  )
}
