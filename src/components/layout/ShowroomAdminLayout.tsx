'use client'

import { useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { ClipboardList, QrCode, Package, Home, X } from 'lucide-react'
import { BoeBrandIcon } from './BoeBrandIcon'
import type { UserProfile } from '@/lib/types'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'

type ShowroomAdminLayoutProps = {
  profile: UserProfile | null
  title: string
  subtitle?: string
  onSignOut: () => void
  children: React.ReactNode
}

export function ShowroomAdminLayout({ profile, title, subtitle, onSignOut, children }: ShowroomAdminLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const router   = useRouter()
  const pathname = usePathname()

  const isAdmin = profile?.role === 'admin'

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

        {/* Brand header — with home icon top-right matching other modules */}
        <div className="boe-sidebar-brand" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <BoeBrandIcon />
            <div>
              <div className="boe-sidebar-brand-name">Showroom QR</div>
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

        {/* Module nav — Showroom QR links only */}
        <div className="boe-sidebar-section">
          <NavItem
            label="My Inquiries"
            icon={<ClipboardList size={15} strokeWidth={1.8} />}
            active={pathname === '/showroom-admin'}
            onClick={() => navTo('/showroom-admin')}
          />
          <NavItem
            label="My QR Code"
            icon={<QrCode size={15} strokeWidth={1.8} />}
            active={pathname === '/showroom-admin/qr'}
            onClick={() => navTo('/showroom-admin/qr')}
          />
          {isAdmin && (
            <NavItem
              label="Product Master"
              icon={<Package size={15} strokeWidth={1.8} />}
              active={pathname.startsWith('/showroom-admin/products')}
              onClick={() => navTo('/showroom-admin/products')}
            />
          )}
        </div>

        {/* Bottom: profile + account settings + view as + sign out */}
        <ViewModeSidebarSection
          profile={profile}
          onSignOut={onSignOut}
          accountSettingsHref="/account?returnTo=/showroom-admin"
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
          {/* Top-right home icon — same pattern as other modules */}
          <div className="boe-header-actions">
            <button
              onClick={() => router.push('/modules')}
              title="BOE OS Home"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 32, height: 32, borderRadius: '8px',
                background: 'rgba(0,0,0,0.05)',
                border: '1px solid rgba(0,0,0,0.10)',
                color: '#6B7384',
                cursor: 'pointer',
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
