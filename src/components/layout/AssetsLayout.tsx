'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  User, Monitor, Key, Wrench,
  Users, Package, ShieldCheck, Activity,
  Home, Briefcase,
} from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'

export type AssetsView =
  // All users
  | 'my-details'
  | 'my-assets'
  | 'login-details'
  | 'maintenance-history'
  // Admin only
  | 'employee-overview'
  | 'asset-inventory'
  | 'access-register'
  | 'activity-log'

type AssetsLayoutProps = {
  profile: UserProfile | null
  activeView: AssetsView
  onViewChange: (view: AssetsView) => void
  title: string
  subtitle?: string
  onSignOut: () => void
  children: React.ReactNode
}

const USER_NAV: { view: AssetsView; label: string; icon: React.ReactNode }[] = [
  { view: 'my-details',          label: 'My Details',          icon: <User     size={15} strokeWidth={1.8} /> },
  { view: 'my-assets',           label: 'My Assets',           icon: <Monitor  size={15} strokeWidth={1.8} /> },
  { view: 'login-details',       label: 'Login Details',       icon: <Key      size={15} strokeWidth={1.8} /> },
  { view: 'maintenance-history', label: 'Maintenance History', icon: <Wrench   size={15} strokeWidth={1.8} /> },
]

const ADMIN_NAV: { view: AssetsView; label: string; icon: React.ReactNode }[] = [
  { view: 'employee-overview', label: 'Employee Overview', icon: <Users       size={15} strokeWidth={1.8} /> },
  { view: 'asset-inventory',   label: 'Asset Inventory',   icon: <Package     size={15} strokeWidth={1.8} /> },
  { view: 'access-register',   label: 'Access Register',   icon: <ShieldCheck size={15} strokeWidth={1.8} /> },
  { view: 'activity-log',      label: 'Activity Log',      icon: <Activity    size={15} strokeWidth={1.8} /> },
]

export function AssetsLayout({
  profile,
  activeView,
  onViewChange,
  title,
  subtitle,
  onSignOut,
  children,
}: AssetsLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const router = useRouter()

  const isAdmin = profile?.role === 'admin'

  const handleNav = (view: AssetsView) => {
    onViewChange(view)
    setSidebarOpen(false)
  }

  const NavItem = ({ view, label, icon }: { view: AssetsView; label: string; icon: React.ReactNode }) => {
    const active = activeView === view
    return (
      <button
        className={`boe-nav-item${active ? ' active' : ''}`}
        onClick={() => handleNav(view)}
        style={{ fontWeight: active ? 600 : 400, marginBottom: '2px' }}
      >
        <span style={{ color: active ? '#E8A030' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
          {icon}
        </span>
        {label}
      </button>
    )
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

        {/* Brand header */}
        <div className="boe-sidebar-brand" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div className="boe-sidebar-brand-icon">
              <Briefcase size={15} color="#E8A030" strokeWidth={2} />
            </div>
            <div>
              <div className="boe-sidebar-brand-name">BOE</div>
              <div className="boe-sidebar-brand-sub">Assets &amp; Access</div>
            </div>
          </div>
          <button
            onClick={() => router.push('/')}
            title="Back to modules"
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

        {/* Nav — self-entry (all users) */}
        <div className="boe-sidebar-section">
          <div style={{
            fontSize: '10px', fontWeight: 700, color: '#8C94A6',
            textTransform: 'uppercase', letterSpacing: '0.06em',
            padding: '4px 10px 6px',
          }}>
            My Records
          </div>
          {USER_NAV.map(item => (
            <NavItem key={item.view} {...item} />
          ))}

          {/* Admin-only section */}
          {isAdmin && (
            <>
              <div style={{
                fontSize: '10px', fontWeight: 700, color: '#8C94A6',
                textTransform: 'uppercase', letterSpacing: '0.06em',
                padding: '14px 10px 6px',
              }}>
                Admin
              </div>
              {ADMIN_NAV.map(item => (
                <NavItem key={item.view} {...item} />
              ))}
            </>
          )}
        </div>

        {/* Bottom profile */}
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
