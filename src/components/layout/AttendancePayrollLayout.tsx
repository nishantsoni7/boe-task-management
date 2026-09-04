'use client'

// The ONE shell for the combined Attendance & Payroll module.
//
// This replaces AttendanceLayout and PayrollLayout, which were two copies of
// the same component differing only in the brand sub-label and the sidebar
// array. Anything fixed in one of them had to be remembered in the other, and
// twice it was not: the Payroll sidebar never gained the role branch, and the
// Attendance sidebar never gained the Monthly Review link.
//
// One shell, one nav definition (attendancePayrollNav.tsx), one brand. The
// mobile menu is this same <aside> with `.open` toggled, so desktop and mobile
// render the identical list — there is no second menu to keep in step.
//
// What this does NOT merge: the guards. /attendance is still behind
// AttendanceGuard and /payroll behind PayrollGuard, both of which resolve
// admin-only management access independently of anything here. A sidebar is a
// convenience, never an authorisation — see resolveManagementAccess in
// src/lib/moduleAccess.ts.

import { useState, useEffect, useCallback } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Home, RefreshCw } from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { BoeBrandIcon } from './BoeBrandIcon'
import { useRefresh } from '@/contexts/RefreshContext'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import { IssueNotificationBell } from '@/components/layout/IssueNotificationBell'
import { useUnreadAttendancePayrollNotifications } from '@/hooks/queries/useUnreadNotifications'
import {
  ATTENDANCE_PAYROLL_MODULE_NAME,
  ATTENDANCE_PAYROLL_NAV_GROUP_LABEL,
  attendancePayrollNavFor,
  isAttendancePayrollNavItemActive,
} from './attendancePayrollNav'

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
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [refreshing,  setRefreshing]  = useState(false)
  const router   = useRouter()
  const pathname = usePathname()
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

  const navTo = (path: string) => {
    router.push(path)
    setSidebarOpen(false)
  }

  // This shell renders both the management screens (/attendance/*, /payroll/*)
  // and the self-service ones (/my-attendance, /my-payroll, /my-issues). Every
  // management destination is admin-only, so showing them to a non-admin only
  // produces links that bounce off the module guard. Hiding them is a usability
  // fix, never the control — the guards, the API routes and RLS are what
  // actually refuse the access.
  const isAdmin = profile?.role === 'admin'

  const navItems = attendancePayrollNavFor(!!isAdmin)

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
  // is behind AttendanceGuard. An employee's door onto the same feed sits beside
  // their own issue list instead.
  //
  // ONE door per role. /payroll/notifications still resolves — it is the same
  // shared feed and old links must keep working — but the sidebar no longer
  // offers a second entry to the identical queue.
  const notificationsHref = isAdmin ? '/attendance/notifications' : '/my-issues/notifications'

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
          {navItems.map((item, i) => {
            const active = isAttendancePayrollNavItemActive(pathname, item)
            // A group header renders once, the first time its group differs
            // from the item before it — so Administration and Help each get
            // exactly one label, and the two primary entries above them
            // (Overview, View Attendance, View Payroll) get none at all.
            const previousGroup = i > 0 ? navItems[i - 1].group : undefined
            const showGroupHeader = item.group && item.group !== previousGroup
            return (
              <div key={item.path}>
                {showGroupHeader && (
                  <div style={{
                    padding: '14px 12px 6px', fontSize: 10.5, fontWeight: 700,
                    color: '#8C94A6', textTransform: 'uppercase', letterSpacing: '0.08em',
                  }}>
                    {ATTENDANCE_PAYROLL_NAV_GROUP_LABEL[item.group!]}
                  </div>
                )}
                <button
                  className={`boe-nav-item${active ? ' active' : ''}`}
                  onClick={() => navTo(item.path)}
                  aria-current={active ? 'page' : undefined}
                  style={{ fontWeight: active ? 600 : 400, marginBottom: '2px' }}
                >
                  <span style={{ color: active ? '#DC1F2E' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
                    {item.icon}
                  </span>
                  {item.label}
                </button>
              </div>
            )
          })}
        </div>

        {/* The issue feed, in the shape every other module uses: the large alert
            while something is unread, the plain nav entry otherwise. This is the
            module's only door onto the feed — same rows, same count, same query
            cache for admins and employees; only the destination differs by role. */}
        <IssueNotificationBell
          unread={unreadIssues}
          href={notificationsHref}
          onNavigate={() => setSidebarOpen(false)}
        />

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
            <div className="boe-page-title">{title}</div>
            {subtitle && <div className="boe-page-subtitle">{subtitle}</div>}
          </div>
          <div className="boe-header-actions">
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
