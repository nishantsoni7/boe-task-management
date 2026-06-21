'use client'

import { useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Home, Settings, X } from 'lucide-react'
import { BoeBrandIcon } from './BoeBrandIcon'
import type { UserProfile } from '@/lib/types'
import { ViewModeSidebarSection } from './AdminViewModeControls'

type BoeOsLayoutProps = {
  profile: UserProfile | null
  title: string
  subtitle?: string
  onSignOut: () => void
  children: React.ReactNode
}

export function BoeOsLayout({ profile, title, subtitle, onSignOut, children }: BoeOsLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const router   = useRouter()
  const pathname = usePathname()

  const navTo = (path: string) => {
    router.push(path)
    setSidebarOpen(false)
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

        {/* Brand */}
        <div className="boe-sidebar-brand">
          <BoeBrandIcon />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="boe-sidebar-brand-name">BOE</div>
            <div className="boe-sidebar-brand-sub">Operating System</div>
          </div>
        </div>

        {/* Nav */}
        <div className="boe-sidebar-section">
          <OsNavItem
            label="Home"
            icon={<Home size={15} strokeWidth={1.8} />}
            active={pathname === '/modules'}
            onClick={() => navTo('/modules')}
          />
          <OsNavItem
            label="Account Settings"
            icon={<Settings size={15} strokeWidth={1.8} />}
            active={pathname === '/account'}
            onClick={() => navTo('/account?returnTo=/modules')}
          />
        </div>

        {/* Bottom: profile + account settings + view as + sign out */}
        <ViewModeSidebarSection
          profile={profile}
          onSignOut={onSignOut}
          accountSettingsHref="/account?returnTo=/modules"
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
        </div>

        {/* Page body */}
        <div className="boe-page-body">
          {children}
        </div>

      </div>
    </div>
  )
}

// ── Sidebar nav item ──────────────────────────────────────────────────────────

function OsNavItem({
  label, icon, active, onClick,
}: {
  label: string
  icon: React.ReactNode
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      className={`boe-nav-item${active ? ' active' : ''}`}
      onClick={onClick}
      style={{ fontWeight: active ? 600 : 400, marginBottom: '2px' }}
    >
      <span style={{ color: active ? '#DC1F2E' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
        {icon}
      </span>
      {label}
    </button>
  )
}
