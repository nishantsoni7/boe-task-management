'use client'

import { useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import type { UserProfile } from '@/lib/types'
import { colors, font } from '@/lib/tokens'
import { initials } from '@/lib/ui'

// ─── DashboardLayout ──────────────────────────────────────────────────────────
// Shell: fixed 220px sidebar + main-content (margin-left: 220px).
// Matches reference HTML structure exactly — no persistent right panel.
// Each page owns its own internal layout grid (dashboard-grid, manager-layout, etc.)

type DashboardLayoutProps = {
  profile: UserProfile | null
  title: string
  subtitle?: string
  actions?: React.ReactNode
  onSignOut: () => void
  children: React.ReactNode
}

export function DashboardLayout({
  profile,
  title,
  subtitle,
  actions,
  onSignOut,
  children,
}: DashboardLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const router   = useRouter()
  const pathname = usePathname()

  const isAdmin   = profile?.role === 'admin'
  const isManager = profile?.role === 'admin' || profile?.role === 'manager'

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

        {/* Primary nav */}
        <div className="boe-sidebar-section">
          <div className="boe-sidebar-label">Tasks</div>
          <NavDot
            label="My Tasks"
            dotColor={colors.blue}
            active={pathname === '/tasks/my'}
            onClick={() => navTo('/tasks/my')}
          />
          <NavDot
            label="Assigned To Me"
            dotColor={colors.amber}
            active={pathname === '/tasks/assigned-to-me'}
            onClick={() => navTo('/tasks/assigned-to-me')}
          />
        </div>

        {/* Main nav group */}
        <div className="boe-sidebar-section">
          <div className="boe-sidebar-label">Main</div>
          <NavDot
            label="Dashboard"
            dotColor={colors.secondary}
            active={pathname === '/dashboard'}
            onClick={() => navTo('/dashboard')}
          />
          {isManager && (
            <NavDot
              label="Manager View"
              dotColor={colors.amber}
              active={pathname === '/manager'}
              onClick={() => navTo('/manager')}
            />
          )}
          {isAdmin && (
            <NavDot
              label="Members"
              dotColor={colors.muted}
              active={pathname === '/admin/members'}
              onClick={() => navTo('/admin/members')}
            />
          )}
          {isAdmin && (
            <>
              <NavDot
                label="Settings"
                dotColor={colors.muted}
                active={pathname === '/settings'}
                onClick={() => navTo('/settings')}
              />
              {pathname.startsWith('/settings') && (
                <div style={{ paddingLeft: '20px' }}>
                  <button
                    className={`boe-nav-item${pathname.startsWith('/settings/roles') ? ' active' : ''}`}
                    onClick={() => navTo('/settings/roles')}
                    style={{ fontSize: '12px' }}
                  >
                    <span className="boe-nav-dot" style={{ background: colors.muted }} />
                    Roles
                  </button>
                  <button
                    className={`boe-nav-item${pathname.startsWith('/settings/positions') ? ' active' : ''}`}
                    onClick={() => navTo('/settings/positions')}
                    style={{ fontSize: '12px' }}
                  >
                    <span className="boe-nav-dot" style={{ background: colors.muted }} />
                    Positions
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Quick actions */}
        <div className="boe-sidebar-section">
          <div className="boe-sidebar-label">Quick</div>
          <button
            className={`boe-nav-item${pathname === '/tasks/create' ? ' active' : ''}`}
            onClick={() => navTo('/tasks/create')}
          >
            + New Task
          </button>
        </div>

        {/* Profile + sign out — pushed to bottom */}
        {profile && (
          <div style={{
            marginTop: 'auto',
            borderTop: '1px solid rgba(255,255,255,0.045)',
            padding: '10px 8px',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '6px 8px', marginBottom: '2px',
            }}>
              <div style={{
                width: 24, height: 24, borderRadius: '50%',
                background: '#2A3040',
                border: `1px solid ${colors.border}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '10px', fontWeight: 700,
                color: colors.secondary, flexShrink: 0,
              }}>
                {initials(profile.full_name)}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{
                  fontSize: '12px', fontWeight: 500, color: colors.primary,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {profile.full_name}
                </div>
                <div style={{
                  fontSize: '10px', color: colors.tertiary,
                  textTransform: 'capitalize',
                }}>
                  {profile.role} · {profile.team}
                </div>
              </div>
            </div>
            <button
              onClick={onSignOut}
              className="boe-nav-item"
              style={{ color: colors.muted, fontSize: '12px' }}
            >
              Sign out
            </button>
          </div>
        )}

      </aside>

      {/* Main content area */}
      <div className="boe-main-content">

        {/* Page header — sticky */}
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
          {actions && (
            <div className="boe-header-actions">{actions}</div>
          )}
        </div>

        {/* Page body — pages render their layout grids here */}
        <div className="boe-page-body">
          {children}
        </div>

      </div>
    </div>
  )
}

// ─── NavDot ───────────────────────────────────────────────────────────────────
// Sidebar nav item with colored dot — matches reference HTML .nav-item structure.
type NavDotProps = {
  label: string
  dotColor: string
  active: boolean
  onClick: () => void
  badge?: number
  badgeAmber?: boolean
}

function NavDot({ label, dotColor, active, onClick, badge, badgeAmber }: NavDotProps) {
  return (
    <button
      className={`boe-nav-item${active ? ' active' : ''}`}
      onClick={onClick}
    >
      <span className="boe-nav-dot" style={{ background: dotColor }} />
      {label}
      {badge !== undefined && badge > 0 && (
        <span className={`boe-nav-badge${badgeAmber ? ' amber' : ''}`}>{badge}</span>
      )}
    </button>
  )
}