'use client'

import { useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Home, LayoutGrid, Building2, Users, ShieldCheck, Layers, History, X, ClipboardList } from 'lucide-react'
import { BoeBrandIcon } from './BoeBrandIcon'
import type { UserProfile } from '@/lib/types'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'

export type ControlCenterTab = 'overview' | 'departments' | 'people' | 'modules'

type ControlCenterLayoutProps = {
  profile: UserProfile | null
  title: string
  subtitle?: string
  onSignOut: () => void
  children: React.ReactNode
  /** Current tab, only meaningful on the main /admin/control-center page. */
  activeTab?: ControlCenterTab
  /** When provided, Overview/Departments/People/Module Visibility switch tabs
   *  in place instead of navigating — used by the main control-center page. */
  onTabChange?: (tab: ControlCenterTab) => void
}

export function ControlCenterLayout({
  profile, title, subtitle, onSignOut, children, activeTab, onTabChange,
}: ControlCenterLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const router   = useRouter()
  const pathname = usePathname()

  const navTo = (path: string) => {
    router.push(path)
    setSidebarOpen(false)
  }

  // Overview/Departments/People/Module Visibility live as tabs on the main
  // control-center page. If we're already there (onTabChange provided),
  // switch tabs in place; otherwise navigate to that page and land on the tab.
  const goToTab = (tab: ControlCenterTab) => {
    if (onTabChange) {
      onTabChange(tab)
      setSidebarOpen(false)
    } else {
      navTo(`/admin/control-center?tab=${tab}`)
    }
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

        {/* Section 1: Module header with Home button */}
        <div className="boe-sidebar-brand" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <BoeBrandIcon />
            <div>
              <div className="boe-sidebar-brand-name">Control Center</div>
              <div className="boe-sidebar-brand-sub">BOE Operating System</div>
            </div>
          </div>
          <button
            onClick={() => navTo('/modules')}
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

        {/* Section 2: Control Center navigation only */}
        <div className="boe-sidebar-section">
          <NavItem
            label="Overview"
            icon={<LayoutGrid size={15} strokeWidth={1.8} />}
            active={pathname === '/admin/control-center' && (!onTabChange || activeTab === 'overview')}
            onClick={() => goToTab('overview')}
          />
          <NavItem
            label="Departments"
            icon={<Building2 size={15} strokeWidth={1.8} />}
            active={pathname === '/admin/control-center' && activeTab === 'departments'}
            onClick={() => goToTab('departments')}
          />
          <NavItem
            label="People"
            icon={<Users size={15} strokeWidth={1.8} />}
            active={pathname === '/admin/control-center' && activeTab === 'people'}
            onClick={() => goToTab('people')}
          />
          <NavItem
            label="Access Control"
            icon={<ShieldCheck size={15} strokeWidth={1.8} />}
            active={pathname === '/admin/control-center/permissions'}
            onClick={() => navTo('/admin/control-center/permissions')}
          />
          <NavItem
            label="Action Queue"
            icon={<ClipboardList size={15} strokeWidth={1.8} />}
            active={pathname === '/admin/control-center/action-queue'}
            onClick={() => navTo('/admin/control-center/action-queue')}
          />
          <NavItem
            label="Module Visibility"
            icon={<Layers size={15} strokeWidth={1.8} />}
            active={pathname === '/admin/control-center' && activeTab === 'modules'}
            onClick={() => goToTab('modules')}
          />
          <NavItem
            label="Change History"
            icon={<History size={15} strokeWidth={1.8} />}
            active={false}
            disabled
            badge="Soon"
          />
        </div>

        {/* Section 3: Global user area */}
        <ViewModeSidebarSection
          profile={profile}
          onSignOut={onSignOut}
          accountSettingsHref="/account?returnTo=/admin/control-center"
        />
      </aside>

      {/* Main content */}
      <div className="boe-main-content">

        {/* Sticky page header */}
        <div className="boe-page-header">
          <button
            className="boe-menu-toggle"
            onClick={() => setSidebarOpen(o => !o)}
            aria-label="Open menu"
          >
            {sidebarOpen ? <X size={18} /> : '☰'}
          </button>
          <div className="boe-page-title-group">
            <div className="boe-page-title">{title}</div>
            {subtitle && <div className="boe-page-subtitle">{subtitle}</div>}
          </div>
          <div className="boe-header-actions">
            <button
              onClick={() => navTo('/modules')}
              title="BOE OS Home"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 32, height: 32, borderRadius: '8px',
                background: 'rgba(0,0,0,0.05)',
                border: '1px solid rgba(0,0,0,0.10)',
                color: '#6B7384', cursor: 'pointer',
                flexShrink: 0, transition: 'background 0.15s, color 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(220,31,46,0.08)'; e.currentTarget.style.color = '#DC1F2E' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.05)'; e.currentTarget.style.color = '#6B7384' }}
            >
              <Home size={14} strokeWidth={2} />
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

function NavItem({
  label, icon, active, onClick, disabled, badge,
}: {
  label: string
  icon: React.ReactNode
  active: boolean
  onClick?: () => void
  disabled?: boolean
  badge?: string
}) {
  return (
    <button
      className={`boe-nav-item${active ? ' active' : ''}`}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={disabled ? 'Coming soon' : undefined}
      style={{
        fontWeight: active ? 600 : 400,
        marginBottom: '2px',
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <span style={{ color: active ? '#DC1F2E' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
        {icon}
      </span>
      {label}
      {badge && <span className="boe-nav-badge amber">{badge}</span>}
    </button>
  )
}
