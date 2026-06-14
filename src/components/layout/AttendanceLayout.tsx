'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import {
  LayoutDashboard, Users, Upload, Home, Briefcase, ClipboardList, Banknote, RefreshCw, CalendarX, FileBarChart,
} from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { useRefresh } from '@/contexts/RefreshContext'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'

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

  const navItems = [
    { label: 'Attendance Dashboard', path: '/attendance',          icon: <LayoutDashboard size={15} strokeWidth={1.8} /> },
    { label: 'Employee Master',      path: '/attendance/employees', icon: <Users size={15} strokeWidth={1.8} /> },
    { label: 'Attendance Upload',    path: '/attendance/upload',   icon: <Upload size={15} strokeWidth={1.8} /> },
    { label: 'Attendance Records',   path: '/attendance/records',  icon: <ClipboardList size={15} strokeWidth={1.8} /> },
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
            <div className="boe-sidebar-brand-icon">
              <Briefcase size={15} color="#E8A030" strokeWidth={2} />
            </div>
            <div>
              <div className="boe-sidebar-brand-name">BOE</div>
              <div className="boe-sidebar-brand-sub">Attendance &amp; Salary</div>
            </div>
          </div>
          <button
            onClick={() => router.push('/')}
            title="BOE Home"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: '7px',
              background: 'rgba(232,160,48,0.12)',
              border: '1px solid rgba(232,160,48,0.25)',
              color: '#E8A030', cursor: 'pointer', flexShrink: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(232,160,48,0.22)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(232,160,48,0.12)' }}
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
                <span style={{ color: active ? '#E8A030' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
                  {item.icon}
                </span>
                {item.label}
              </button>
            )
          })}

          {/* Holiday Management — admin only */}
          {profile?.role === 'admin' && (
            <button
              className={`boe-nav-item${pathname.startsWith('/attendance/holidays') ? ' active' : ''}`}
              onClick={() => navTo('/attendance/holidays')}
              style={{ fontWeight: pathname.startsWith('/attendance/holidays') ? 600 : 400, marginBottom: '2px' }}
            >
              <span style={{ color: pathname.startsWith('/attendance/holidays') ? '#E8A030' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
                <CalendarX size={15} strokeWidth={1.8} />
              </span>
              Holiday Management
            </button>
          )}

          {/* Payroll — admin only */}
          {profile?.role === 'admin' && (
            <button
              className={`boe-nav-item${pathname.startsWith('/payroll') && !pathname.startsWith('/payroll/monthly-review') ? ' active' : ''}`}
              onClick={() => navTo('/payroll')}
              style={{ fontWeight: pathname.startsWith('/payroll') && !pathname.startsWith('/payroll/monthly-review') ? 600 : 400, marginBottom: '2px' }}
            >
              <span style={{ color: pathname.startsWith('/payroll') && !pathname.startsWith('/payroll/monthly-review') ? '#E8A030' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
                <Banknote size={15} strokeWidth={1.8} />
              </span>
              Payroll
            </button>
          )}

          {/* Payroll Monthly Review — admin only */}
          {profile?.role === 'admin' && (
            <button
              className={`boe-nav-item${pathname.startsWith('/payroll/monthly-review') ? ' active' : ''}`}
              onClick={() => navTo('/payroll/monthly-review')}
              style={{ fontWeight: pathname.startsWith('/payroll/monthly-review') ? 600 : 400, marginBottom: '2px' }}
            >
              <span style={{ color: pathname.startsWith('/payroll/monthly-review') ? '#E8A030' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
                <FileBarChart size={15} strokeWidth={1.8} />
              </span>
              Payroll Review
            </button>
          )}
        </div>

        {/* Bottom profile section */}
        <ViewModeSidebarSection profile={profile} onSignOut={onSignOut} />

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
                background: refreshing ? 'rgba(232,160,48,0.15)' : 'rgba(0,0,0,0.05)',
                border: '1px solid rgba(0,0,0,0.10)',
                color: refreshing ? '#E8A030' : '#6B7384',
                cursor: refreshing ? 'default' : 'pointer',
                flexShrink: 0, transition: 'background 0.15s, color 0.15s',
              }}
              onMouseEnter={e => { if (!refreshing) { e.currentTarget.style.background = 'rgba(232,160,48,0.12)'; e.currentTarget.style.color = '#E8A030' } }}
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
