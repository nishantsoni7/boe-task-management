'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Banknote, BookOpen, FileBarChart, Home, RefreshCw } from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { PAYROLL_GUIDE_PATH } from '@/lib/payroll/guidePath'
import { BoeBrandIcon } from './BoeBrandIcon'
import { useRefresh } from '@/contexts/RefreshContext'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import { IssueNotificationBell } from '@/components/layout/IssueNotificationBell'
import { useUnreadAttendancePayrollNotifications } from '@/hooks/queries/useUnreadNotifications'

type PayrollLayoutProps = {
  profile: UserProfile | null
  title: string
  subtitle?: string
  actions?: React.ReactNode
  onSignOut: () => void
  children: React.ReactNode
}

export function PayrollLayout({
  profile,
  title,
  subtitle,
  actions,
  onSignOut,
  children,
}: PayrollLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [refreshing,  setRefreshing]  = useState(false)
  const router   = useRouter()
  const pathname = usePathname()
  const { triggerRefresh } = useRefresh()

  // The same count the Attendance sidebar shows — one category, one query key,
  // one fetch. Unconditional here because every /payroll route is behind
  // PayrollGuard, which is admins only (resolveManagementAccess).
  const unreadIssues = useUnreadAttendancePayrollNotifications()

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

  // The guide is last: it explains the module rather than being a place work
  // happens. It is also the one /payroll route employees may open — PayrollGuard
  // lets them through to PAYROLL_GUIDE_PATH and nothing else — which is why it
  // appears in the Attendance sidebar too, for readers who never see this one.
  const navItems = [
    { label: 'Payroll Dashboard',  path: '/payroll',                icon: <Banknote     size={15} strokeWidth={1.8} /> },
    { label: 'Monthly Review',     path: '/payroll/monthly-review', icon: <FileBarChart size={15} strokeWidth={1.8} /> },
    { label: 'How Payroll Works',  path: PAYROLL_GUIDE_PATH,        icon: <BookOpen     size={15} strokeWidth={1.8} /> },
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
              <div className="boe-sidebar-brand-sub">Payroll</div>
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
            const active = item.path === '/payroll'
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

        </div>

        {/* The Payroll door into the shared Attendance & Payroll issue feed.
            Same rows, same count and now the same two-state bell as the
            Attendance sidebar — see /payroll/notifications. */}
        <IssueNotificationBell
          unread={unreadIssues}
          href="/payroll/notifications"
          onNavigate={() => setSidebarOpen(false)}
        />

        {/* Bottom profile section */}
        <ViewModeSidebarSection
          profile={profile}
          onSignOut={onSignOut}
          accountSettingsHref="/account?returnTo=/payroll"
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
