'use client'

import { useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import {
  LayoutDashboard, Users, PlusCircle, ClipboardList, CheckSquare,
  Settings, ChevronRight, LogOut, Briefcase,
} from 'lucide-react'
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

        {/* Brand header */}
        <div className="boe-sidebar-brand">
          <div className="boe-sidebar-brand-icon">
            <Briefcase size={15} color="#E8A030" strokeWidth={2} />
          </div>
          <div>
            <div className="boe-sidebar-brand-name">BOE</div>
            <div className="boe-sidebar-brand-sub">Task Management</div>
          </div>
        </div>

        {/* Top-level nav */}
        <div className="boe-sidebar-section">
          <NavLeaf
            label="Dashboard"
            icon={<LayoutDashboard size={15} strokeWidth={1.8} />}
            active={pathname === '/dashboard'}
            onClick={() => navTo('/dashboard')}
          />
          <NavLeaf
            label="Members"
            icon={<Users size={15} strokeWidth={1.8} />}
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
            icon={<PlusCircle size={15} strokeWidth={1.8} />}
            active={pathname === '/tasks/create-self' || pathname === '/tasks/create'}
          />
          <NavGroup>
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
          </NavGroup>

          {/* My Tasks */}
          <NavParent
            label="My Tasks"
            icon={<ClipboardList size={15} strokeWidth={1.8} />}
            active={pathname === '/tasks/my' || pathname === '/tasks/my/completed'}
            count={taskCounts ? (taskCounts.myInProgress ?? 0) + (taskCounts.myCompleted ?? 0) : undefined}
          />
          <NavGroup>
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
          </NavGroup>

          {/* Assigned By Me */}
          <NavParent
            label="Assigned By Me"
            icon={<CheckSquare size={15} strokeWidth={1.8} />}
            active={pathname === '/tasks/assigned-by-me' || pathname === '/tasks/assigned-by-me/completed'}
            count={taskCounts?.assignedByMeInProgress}
          />
          <NavGroup>
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
          </NavGroup>
        </div>

        {/* Admin section */}
        {isAdmin && (
          <div className="boe-sidebar-section" style={{ borderTop: '1px solid rgba(0,0,0,0.07)', paddingTop: '4px' }}>
            <div className="boe-sidebar-label">Admin</div>

            <NavParent
              label="Settings"
              icon={<Settings size={15} strokeWidth={1.8} />}
              active={pathname.startsWith('/settings') || pathname === '/admin/members'}
            />
            <NavGroup>
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
            </NavGroup>
          </div>
        )}

        {/* Profile + sign out — pushed to bottom */}
        {profile && (
          <div style={{
            marginTop: 'auto',
            borderTop: '1px solid rgba(0,0,0,0.07)',
            padding: '10px 10px 4px',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '8px 10px 6px',
            }}>
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
              <div style={{ minWidth: 0 }}>
                <div style={{
                  fontSize: '12.5px', fontWeight: 600, color: '#111318',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {profile.full_name}
                </div>
                <div style={{
                  fontSize: '10.5px', color: '#8C94A6',
                  textTransform: 'capitalize',
                }}>
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
// Non-clickable parent label — visually groups child items.
type NavParentProps = { label: string; active: boolean; count?: number; icon?: React.ReactNode }

function NavParent({ label, active, count, icon }: NavParentProps) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '7px 10px',
      borderRadius: '7px',
      fontSize: '13px',
      fontWeight: 500,
      color: active ? '#111318' : '#3D4455',
      userSelect: 'none',
      background: active ? 'rgba(0,0,0,0.04)' : 'transparent',
      marginBottom: '1px',
    }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ color: active ? '#E8A030' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
          {icon}
        </span>
        {label}
        {count != null && count > 0 && (
          <span style={{
            fontSize: '10px', fontWeight: 600,
            color: '#8C94A6', background: 'rgba(0,0,0,0.07)',
            borderRadius: '999px', padding: '1px 6px',
            lineHeight: '15px',
          }}>{count}</span>
        )}
      </span>
      <ChevronRight size={12} strokeWidth={2} style={{ opacity: 0.4, transform: 'rotate(90deg)' }} />
    </div>
  )
}

// ─── NavLeaf ──────────────────────────────────────────────────────────────────
// Top-level clickable nav item with no children.
type NavLeafProps = { label: string; active: boolean; onClick: () => void; icon?: React.ReactNode }

function NavLeaf({ label, active, onClick, icon }: NavLeafProps) {
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

// ─── NavGroup ─────────────────────────────────────────────────────────────────
// Container for child nav items — adds left-border visual guide.
function NavGroup({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      marginLeft: '18px',
      marginBottom: '4px',
      paddingLeft: '10px',
      borderLeft: '1px solid rgba(0,0,0,0.08)',
    }}>
      {children}
    </div>
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
        fontSize: '12.5px',
        fontWeight: active ? 500 : 400,
        color: active ? '#111318' : '#707A92',
        padding: '5px 8px',
        marginBottom: '1px',
      }}
    >
      <span style={{ flex: 1 }}>{label}</span>
      {count != null && count > 0 && (
        <span style={{
          fontSize: '10px', fontWeight: 600,
          color: '#8C94A6', background: 'rgba(0,0,0,0.07)',
          borderRadius: '999px', padding: '1px 6px',
          lineHeight: '15px', marginLeft: 'auto',
        }}>{count}</span>
      )}
    </button>
  )
}
