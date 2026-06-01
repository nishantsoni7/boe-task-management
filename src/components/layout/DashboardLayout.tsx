'use client'

import { useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { initials } from '@/lib/ui'

// ─── DashboardLayout ──────────────────────────────────────────────────────────
// Shell: fixed 220px sidebar + main-content (margin-left: 220px).
// Each page owns its own internal layout grid.

type TaskCounts = {
  myInProgress?: number
  myCompleted?: number
  assignedByMeInProgress?: number
}

type DashboardLayoutProps = {
  profile: UserProfile | null
  title: string
  subtitle?: string
  actions?: React.ReactNode
  onSignOut: () => void
  children: React.ReactNode
  taskCounts?: TaskCounts
}

export function DashboardLayout({
  profile,
  title,
  subtitle,
  actions,
  onSignOut,
  children,
  taskCounts,
}: DashboardLayoutProps) {
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

        {/* Top-level nav */}
        <div className="boe-sidebar-section">
          <NavLeaf
            label="Dashboard"
            active={pathname === '/dashboard'}
            onClick={() => navTo('/dashboard')}
          />
          <NavLeaf
            label="Members"
            active={pathname === '/admin/members'}
            onClick={() => navTo('/admin/members')}
          />
        </div>

        {/* Tasks section */}
        <div className="boe-sidebar-section">
          <div className="boe-sidebar-label">Tasks</div>

          {/* New Task */}
          <NavParent
            label="New Task"
            active={pathname === '/tasks/create-self' || pathname === '/tasks/create'}
          />
          <div style={{ paddingLeft: '12px', marginBottom: '4px' }}>
            <NavChild
              label="Self Task"
              active={pathname === '/tasks/create-self'}
              onClick={() => navTo('/tasks/create-self')}
            />
            <NavChild
              label="Delegate Task"
              active={pathname === '/tasks/create'}
              onClick={() => navTo('/tasks/create')}
            />
          </div>

          {/* My Tasks */}
          <NavParent
            label="My Tasks"
            active={pathname === '/tasks/my' || pathname === '/tasks/my/completed'}
            count={taskCounts ? (taskCounts.myInProgress ?? 0) + (taskCounts.myCompleted ?? 0) : undefined}
          />
          <div style={{ paddingLeft: '12px', marginBottom: '4px' }}>
            <NavChild
              label="In Progress"
              active={pathname === '/tasks/my'}
              onClick={() => navTo('/tasks/my')}
              count={taskCounts?.myInProgress}
            />
            <NavChild
              label="Completed"
              active={pathname === '/tasks/my/completed'}
              onClick={() => navTo('/tasks/my/completed')}
              count={taskCounts?.myCompleted}
            />
          </div>

          {/* Assigned By Me */}
          <NavParent
            label="Assigned By Me"
            active={pathname === '/tasks/assigned-by-me' || pathname === '/tasks/assigned-by-me/completed'}
            count={taskCounts?.assignedByMeInProgress}
          />
          <div style={{ paddingLeft: '12px', marginBottom: '4px' }}>
            <NavChild
              label="In Progress"
              active={pathname === '/tasks/assigned-by-me'}
              onClick={() => navTo('/tasks/assigned-by-me')}
              count={taskCounts?.assignedByMeInProgress}
            />
            <NavChild
              label="Completed"
              active={pathname === '/tasks/assigned-by-me/completed'}
              onClick={() => navTo('/tasks/assigned-by-me/completed')}
            />
          </div>
        </div>

        {/* Admin section */}
        {isAdmin && (
          <div className="boe-sidebar-section" style={{ marginTop: '8px', paddingTop: '6px', borderTop: '1px solid rgba(0,0,0,0.07)' }}>
            <div className="boe-sidebar-label">Admin</div>

            {/* Settings */}
            <NavParent
              label="Settings"
              active={pathname.startsWith('/settings') || pathname === '/admin/members'}
            />
            <div style={{ paddingLeft: '12px', marginBottom: '4px' }}>
              <NavChild
                label="Members"
                active={pathname === '/admin/members'}
                onClick={() => navTo('/admin/members')}
              />
              <NavChild
                label="Roles"
                active={pathname.startsWith('/settings/roles')}
                onClick={() => navTo('/settings/roles')}
              />
              <NavChild
                label="Positions"
                active={pathname.startsWith('/settings/positions')}
                onClick={() => navTo('/settings/positions')}
              />
            </div>
          </div>
        )}

        {/* Profile + sign out — pushed to bottom */}
        {profile && (
          <div style={{
            marginTop: 'auto',
            borderTop: '1px solid rgba(0,0,0,0.08)',
            padding: '12px 8px 20px',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '6px 8px', marginBottom: '4px',
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

        {/* Page body */}
        <div className="boe-page-body">
          {children}
        </div>

      </div>
    </div>
  )
}

// ─── NavParent ────────────────────────────────────────────────────────────────
// Non-clickable parent label with chevron — visually groups child items.
type NavParentProps = { label: string; active: boolean; count?: number }

function NavParent({ label, active, count }: NavParentProps) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 10px 6px',
      borderRadius: '5px',
      fontSize: '13px',
      fontWeight: 600,
      color: active ? '#111318' : '#2D3748',
      letterSpacing: '0.01em',
      userSelect: 'none',
      background: active ? 'rgba(0,0,0,0.04)' : 'transparent',
    }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        {label}
        {count != null && count > 0 && (
          <span style={{
            fontSize: '10px', fontWeight: 700,
            color: '#6B7280', background: '#F3F4F6',
            borderRadius: '999px', padding: '1px 6px',
            lineHeight: '14px',
          }}>{count}</span>
        )}
      </span>
      <span style={{
        fontSize: '11px',
        opacity: 0.55,
        lineHeight: 1,
        marginLeft: '4px',
        color: '#6B7280',
      }}>▾</span>
    </div>
  )
}

// ─── NavLeaf ──────────────────────────────────────────────────────────────────
// Top-level clickable nav item with no children.
type NavLeafProps = { label: string; active: boolean; onClick: () => void }

function NavLeaf({ label, active, onClick }: NavLeafProps) {
  return (
    <button
      className={`boe-nav-item${active ? ' active' : ''}`}
      onClick={onClick}
      style={{ fontWeight: active ? 600 : 400, marginBottom: '2px' }}
    >
      {label}
    </button>
  )
}

// ─── NavChild ─────────────────────────────────────────────────────────────────
// Indented child nav item — sits beneath a NavParent.
type NavChildProps = { label: string; active: boolean; onClick: () => void; count?: number }

function NavChild({ label, active, onClick, count }: NavChildProps) {
  return (
    <button
      className={`boe-nav-item${active ? ' active' : ''}`}
      onClick={onClick}
      style={{
        fontSize: '12px',
        fontWeight: active ? 500 : 400,
        color: active ? '#111318' : '#6B7280',
        paddingLeft: '18px',
        marginBottom: '1px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
      }}
    >
      <span>{label}</span>
      {count != null && count > 0 && (
        <span style={{
          fontSize: '10px', fontWeight: 600,
          color: '#9CA3AF', background: '#F3F4F6',
          borderRadius: '999px', padding: '1px 6px',
          lineHeight: '14px', marginRight: '4px',
        }}>{count}</span>
      )}
    </button>
  )
}
