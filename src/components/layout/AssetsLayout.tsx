'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Monitor, Key,
  Package, ShieldCheck,
  Home,
} from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { BoeBrandIcon } from './BoeBrandIcon'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import { MobileBottomNav } from '@/components/layout/MobileBottomNav'

export type AssetsView =
  // All users
  | 'my-assets'
  | 'my-access'
  // Admin only
  | 'asset-inventory'
  | 'access-register'

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
  { view: 'my-assets', label: 'My Assets', icon: <Monitor size={15} strokeWidth={1.8} /> },
  { view: 'my-access', label: 'My Access', icon: <Key     size={15} strokeWidth={1.8} /> },
]

const ADMIN_NAV: { view: AssetsView; label: string; icon: React.ReactNode }[] = [
  { view: 'asset-inventory', label: 'Asset Inventory', icon: <Package     size={15} strokeWidth={1.8} /> },
  { view: 'access-register', label: 'Access Register', icon: <ShieldCheck size={15} strokeWidth={1.8} /> },
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
        <span style={{ color: active ? '#DC1F2E' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
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
            <BoeBrandIcon />
            <div>
              <div className="boe-sidebar-brand-name">BOE</div>
              <div className="boe-sidebar-brand-sub">Assets &amp; Access</div>
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
        <ViewModeSidebarSection
          profile={profile}
          onSignOut={onSignOut}
          accountSettingsHref="/account?returnTo=/assets-access"
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
        </div>

        {/* Page body */}
        <div className="boe-page-body">
          <ViewModeBanner />
          {children}
        </div>

      </div>

      <MobileBottomNav profile={profile} onSignOut={onSignOut} />

    </div>
  )
}
