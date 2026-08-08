'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import {
  LayoutDashboard, Users, Upload, Home, ClipboardList, RefreshCw, CalendarX,
  CalendarDays, MessageSquareWarning,
} from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { BoeBrandIcon } from './BoeBrandIcon'
import { useRefresh } from '@/contexts/RefreshContext'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import { IssueNotificationBell } from '@/components/layout/IssueNotificationBell'
import { useUnreadAttendancePayrollNotifications } from '@/hooks/queries/useUnreadNotifications'

type AttendanceLayoutProps = {
  profile: UserProfile | null
  title: string
  subtitle?: string
  actions?: React.ReactNode
  onSignOut: () => void
  children: React.ReactNode
}

export function AttendanceLayout({
  profile,
  title,
  subtitle,
  actions,
  onSignOut,
  children,
}: AttendanceLayoutProps) {
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

  // This layout is shared with /my-payroll, which an ordinary employee opens.
  // Every /attendance destination is an admin surface, so showing them to a
  // non-admin only produces links that bounce off the module guard. Hiding them
  // is a usability fix, never the control — the guard, the API routes and RLS
  // are what actually refuse the access.
  const isAdmin = profile?.role === 'admin'

  // Employee-raised attendance and payroll issues, shared with the Payroll
  // sidebar through one category and therefore one query key — the two badges
  // are the same number by construction, not by coincidence.
  //
  // Requested for EVERYONE now. It used to be admin-only because every row of
  // this category was addressed to an admin, so an employee's count could only
  // ever have been zero and the request would have 403'd. Since an admin's
  // decision notifies the employee who raised the issue, an employee has rows
  // of their own here — and a bell that never lights up for the one person
  // waiting on an answer was the whole complaint. Rows stay pinned to
  // `user_id = caller` in every endpoint, so this widens the FEED and not the
  // visibility of anybody's data.
  const unreadIssues = useUnreadAttendancePayrollNotifications()

  // Admins review the whole company's issues at /attendance/notifications,
  // which is behind AttendanceGuard. An employee's door onto the same feed sits
  // beside their own issue list instead.
  const notificationsHref = isAdmin ? '/attendance/notifications' : '/my-issues/notifications'

  const navItems = isAdmin
    ? [
        { label: 'Attendance Dashboard', path: '/attendance',           icon: <LayoutDashboard size={15} strokeWidth={1.8} /> },
        { label: 'Employee Master',      path: '/attendance/employees', icon: <Users size={15} strokeWidth={1.8} /> },
        { label: 'Attendance Upload',    path: '/attendance/upload',    icon: <Upload size={15} strokeWidth={1.8} /> },
        { label: 'Attendance Records',   path: '/attendance/records',   icon: <ClipboardList size={15} strokeWidth={1.8} /> },
      ]
    : [
        { label: 'My Attendance',        path: '/my-attendance',        icon: <CalendarDays size={15} strokeWidth={1.8} /> },
        { label: 'My Payroll',           path: '/my-payroll',           icon: <ClipboardList size={15} strokeWidth={1.8} /> },
        // Reporting a problem is now reachable without first finding the record
        // it is about — see /my-issues.
        { label: 'My Issues',            path: '/my-issues',            icon: <MessageSquareWarning size={15} strokeWidth={1.8} /> },
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
              <div className="boe-sidebar-brand-sub">Attendance &amp; Salary</div>
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
            const active = item.path === '/attendance'
              ? pathname === item.path
              : pathname.startsWith(item.path)
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

          {/* Holiday Management — admin only */}
          {isAdmin && (
            <button
              className={`boe-nav-item${pathname.startsWith('/attendance/holidays') ? ' active' : ''}`}
              onClick={() => navTo('/attendance/holidays')}
              style={{ fontWeight: pathname.startsWith('/attendance/holidays') ? 600 : 400, marginBottom: '2px' }}
            >
              <span style={{ color: pathname.startsWith('/attendance/holidays') ? '#DC1F2E' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
                <CalendarX size={15} strokeWidth={1.8} />
              </span>
              Holiday Management
            </button>
          )}

        </div>

        {/* The notification bell, in the shape every other module uses: the
            large alert while something is unread, the plain nav entry
            otherwise. Attendance and Payroll had only the quiet entry, and only
            for admins — so the bell an employee saw never moved, whatever had
            happened to the issue they raised.

            Same count, same category, same query cache as the Payroll shell;
            only the destination differs by role. */}
        <IssueNotificationBell
          unread={unreadIssues}
          href={notificationsHref}
          onNavigate={() => setSidebarOpen(false)}
        />

        {/* Bottom profile section */}
        <ViewModeSidebarSection
          profile={profile}
          onSignOut={onSignOut}
          accountSettingsHref="/account?returnTo=/attendance"
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
