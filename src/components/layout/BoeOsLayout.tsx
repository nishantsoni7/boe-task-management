'use client'

import { useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Home, Settings, LogOut, X } from 'lucide-react'
import { BoeBrandIcon } from './BoeBrandIcon'
import type { UserProfile } from '@/lib/types'
import { initials } from '@/lib/ui'

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
            active={pathname === '/dashboard'}
            onClick={() => navTo('/dashboard')}
          />
          <OsNavItem
            label="Account Settings"
            icon={<Settings size={15} strokeWidth={1.8} />}
            active={pathname === '/settings'}
            onClick={() => navTo('/settings')}
          />
        </div>

        {/* Bottom: user info + sign out */}
        {profile && (
          <div style={{
            marginTop: 'auto',
            borderTop: '1px solid rgba(0,0,0,0.07)',
            padding: '10px 10px 8px',
          }}>
            {/* User row */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '8px 10px 6px',
            }}>
              <div style={{
                width: 30, height: 30, borderRadius: '8px',
                background: '#1A2035',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '11px', fontWeight: 700, color: '#E8A030',
                flexShrink: 0, letterSpacing: '0.02em',
              }}>
                {initials(profile.full_name)}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{
                  fontSize: '12.5px', fontWeight: 600, color: '#111318',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {profile.full_name}
                </div>
                <div style={{ fontSize: '10.5px', color: '#8C94A6', textTransform: 'capitalize' }}>
                  {profile.role}{profile.team ? ` · ${profile.team}` : ''}
                </div>
              </div>
            </div>

            {/* Sign out */}
            <button
              onClick={onSignOut}
              className="boe-nav-item"
              style={{ color: '#8C94A6', fontSize: '12.5px', gap: '8px', marginTop: '2px' }}
            >
              <LogOut size={14} strokeWidth={1.8} />
              Sign out
            </button>
          </div>
        )}
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
      <span style={{ color: active ? '#E8A030' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
        {icon}
      </span>
      {label}
    </button>
  )
}
