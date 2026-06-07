'use client'

import { useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import {
  LayoutDashboard, Users, CalendarClock, LogIn, LogOut as LogOutIcon,
  Upload, Calculator, Wallet, MessageSquareWarning, Home, LogOut, Briefcase, ClipboardList,
} from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { initials } from '@/lib/ui'

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
  const router   = useRouter()
  const pathname = usePathname()

  const navTo = (path: string) => {
    router.push(path)
    setSidebarOpen(false)
  }

  const navItems = [
    { label: 'Attendance Dashboard', path: '/attendance',          icon: <LayoutDashboard size={15} strokeWidth={1.8} /> },
    { label: 'Employee Master',      path: '/attendance/employees', icon: <Users size={15} strokeWidth={1.8} /> },
    { label: 'Leave Requests',       path: '/attendance/leave',    icon: <CalendarClock size={15} strokeWidth={1.8} /> },
    { label: 'Late Arrival',         path: '/attendance/late',     icon: <LogIn size={15} strokeWidth={1.8} /> },
    { label: 'Early Departure',      path: '/attendance/early',    icon: <LogOutIcon size={15} strokeWidth={1.8} /> },
    { label: 'Attendance Upload',    path: '/attendance/upload',   icon: <Upload size={15} strokeWidth={1.8} /> },
    { label: 'Attendance Records',   path: '/attendance/records',  icon: <ClipboardList size={15} strokeWidth={1.8} /> },
    { label: 'Salary Calculation',   path: '/attendance/salary',   icon: <Calculator size={15} strokeWidth={1.8} /> },
    { label: 'My Salary',            path: '/attendance/my-salary', icon: <Wallet size={15} strokeWidth={1.8} /> },
    { label: 'Salary Concerns',      path: '/attendance/concerns', icon: <MessageSquareWarning size={15} strokeWidth={1.8} /> },
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
        </div>

        {/* Bottom profile section */}
        {profile && (
          <div style={{
            marginTop: 'auto',
            borderTop: '1px solid rgba(0,0,0,0.07)',
            padding: '10px 10px 6px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px 6px' }}>
              <div style={{
                width: 30, height: 30, borderRadius: '8px',
                background: '#1A2035',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '11px', fontWeight: 700,
                color: '#E8A030', flexShrink: 0,
                letterSpacing: '0.02em',
              }}>
                {initials(profile.full_name)}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: '12.5px', fontWeight: 600, color: '#111318', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {profile.full_name}
                </div>
                <div style={{ fontSize: '10.5px', color: '#8C94A6', textTransform: 'capitalize' }}>
                  {profile.role} · {profile.team}
                </div>
              </div>
            </div>
            <button
              onClick={onSignOut}
              className="boe-nav-item"
              style={{ color: '#8C94A6', fontSize: '12.5px', gap: '8px' }}
            >
              <LogOut size={14} strokeWidth={1.8} />
              Sign out
            </button>
          </div>
        )}

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
          {actions && <div className="boe-header-actions">{actions}</div>}
        </div>

        {/* Page body */}
        <div className="boe-page-body">
          {children}
        </div>

      </div>
    </div>
  )
}
