'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import {
  LayoutDashboard, PlusCircle, ClipboardList, CheckSquare,
  Settings, ChevronRight, Briefcase, ShieldCheck, TrendingUp,
  Home, Bell, RefreshCw,
} from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { useViewAs } from '@/hooks/useViewAs'
import { createClient } from '@/lib/supabase/client'
import { useRefresh } from '@/contexts/RefreshContext'
import { ViewModeBanner, ViewModeSidebarSection } from './AdminViewModeControls'

// ─── DashboardLayout ──────────────────────────────────────────────────────────

type DashboardLayoutProps = {
  profile: UserProfile | null
  title: React.ReactNode
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
  const [sidebarOpen,  setSidebarOpen]  = useState(false)
  const [navCounts,    setNavCounts]    = useState({ myActive: 0, assignedByMeActive: 0 })
  const [unreadNotifs, setUnreadNotifs] = useState(0)
  const [refreshing,   setRefreshing]   = useState(false)

  const router   = useRouter()
  const pathname = usePathname()
  const supabase = useMemo(() => createClient(), [])

  const { triggerRefresh } = useRefresh()

  const handleRefresh = useCallback(() => {
    if (refreshing) return
    setRefreshing(true)
    triggerRefresh()
    router.refresh()
    setTimeout(() => setRefreshing(false), 1000)
  }, [refreshing, triggerRefresh, router])

  // Auto-refresh when the tab/app becomes visible again
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') handleRefresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { viewAsUserId, viewAsProfile } = useViewAs()

  const inViewMode  = !!viewAsUserId

  // Sidebar nav reflects the viewed user's role when in view mode
  const navProfile       = viewAsProfile ?? profile
  const isAdmin          = navProfile?.role === 'admin'
  const isAdminOrManager = isAdmin || navProfile?.role === 'manager'

  // Fetch sidebar task counts for the logged-in user (or viewed user in view mode)
  useEffect(() => {
    supabase.auth.getUser().then(({ data }: { data: { user: { id: string } | null } }) => {
      const user = data.user
      if (!user) return
      const uid: string = viewAsUserId ?? user.id
      Promise.all([
        supabase
          .from('tasks')
          .select('id', { count: 'exact', head: true })
          .eq('assigned_to', uid)
          .neq('status', 'completed'),
        supabase
          .from('tasks')
          .select('id', { count: 'exact', head: true })
          .eq('created_by', uid)
          .neq('assigned_to', uid)
          .neq('status', 'completed'),
      ]).then(([myRes, abmRes]) => {
        setNavCounts({
          myActive:             myRes.count  ?? 0,
          assignedByMeActive:   abmRes.count ?? 0,
        })
      })
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewAsUserId])

  // Unread notification badge — scoped to the logged-in user via the service-role
  // API route (independent of view mode). Refreshes on navigation so it clears
  // after visiting /notifications and marking items read.
  useEffect(() => {
    let cancelled = false
    fetch('/api/notifications?count=1')
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (!cancelled && data) setUnreadNotifs(data.unreadCount ?? 0) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [pathname])

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
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="boe-sidebar-brand-name">BOE</div>
            <div className="boe-sidebar-brand-sub">Task Management</div>
          </div>
          <button
            onClick={() => navTo('/')}
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

        {/* Main nav */}
        <div className="boe-sidebar-section">
          {/* 1. Dashboard */}
          <NavLeaf
            label="Dashboard"
            icon={<LayoutDashboard size={15} strokeWidth={1.8} />}
            active={pathname === '/dashboard'}
            onClick={() => navTo('/dashboard')}
          />

          {/* 2. New Task — hidden in view mode (read-only) */}
          {!inViewMode && (
            <CollapsibleNav
              label="New Task"
              icon={<PlusCircle size={15} strokeWidth={1.8} />}
              active={pathname === '/tasks/create-self' || pathname === '/tasks/create'}
            >
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
            </CollapsibleNav>
          )}

          {/* 3. My Tasks */}
          <CollapsibleNav
            label="My Tasks"
            icon={<ClipboardList size={15} strokeWidth={1.8} />}
            active={pathname === '/tasks/my' || pathname === '/tasks/my/completed' || pathname === '/tasks/cancelled'}
            count={navCounts.myActive || undefined}
          >
            <NavChild
              label="In Progress"
              active={pathname === '/tasks/my'}
              onClick={() => navTo('/tasks/my')}
              count={navCounts.myActive || undefined}
            />
            <NavChild
              label="Completed"
              active={pathname === '/tasks/my/completed'}
              onClick={() => navTo('/tasks/my/completed')}
            />
            <NavChild
              label="Cancelled"
              active={pathname === '/tasks/cancelled'}
              onClick={() => navTo('/tasks/cancelled')}
            />
          </CollapsibleNav>

          {/* 4. Assigned By Me */}
          <CollapsibleNav
            label="Assigned By Me"
            icon={<CheckSquare size={15} strokeWidth={1.8} />}
            active={pathname === '/tasks/assigned-by-me' || pathname === '/tasks/assigned-by-me/completed' || pathname === '/tasks/assigned-by-me/cancelled'}
            count={navCounts.assignedByMeActive || undefined}
          >
            <NavChild
              label="In Progress"
              active={pathname === '/tasks/assigned-by-me'}
              onClick={() => navTo('/tasks/assigned-by-me')}
              count={navCounts.assignedByMeActive || undefined}
            />
            <NavChild
              label="Completed"
              active={pathname === '/tasks/assigned-by-me/completed'}
              onClick={() => navTo('/tasks/assigned-by-me/completed')}
            />
            <NavChild
              label="Cancelled"
              active={pathname === '/tasks/assigned-by-me/cancelled'}
              onClick={() => navTo('/tasks/assigned-by-me/cancelled')}
            />
          </CollapsibleNav>

          {/* 5. Performance */}
          {isAdminOrManager ? (
            <CollapsibleNav
              label="Performance"
              icon={<TrendingUp size={15} strokeWidth={1.8} />}
              active={pathname.startsWith('/performance')}
            >
              <NavChild
                label="My Performance"
                active={pathname === '/performance'}
                onClick={() => navTo('/performance')}
              />
              <NavChild
                label="Team Performance"
                active={pathname === '/performance/team'}
                onClick={() => navTo('/performance/team')}
              />
            </CollapsibleNav>
          ) : (
            <NavLeaf
              label="Performance"
              icon={<TrendingUp size={15} strokeWidth={1.8} />}
              active={pathname.startsWith('/performance')}
              onClick={() => navTo('/performance')}
            />
          )}

          {/* 6. Settings + Super Admin — admin only, hidden in view mode */}
          {isAdmin && !inViewMode && (
            <>
              <CollapsibleNav
                label="Settings"
                icon={<Settings size={15} strokeWidth={1.8} />}
                active={pathname.startsWith('/settings') || pathname === '/admin/members'}
              >
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
                <NavChild
                  label="My Account"
                  active={pathname === '/settings'}
                  onClick={() => navTo('/settings')}
                />
              </CollapsibleNav>

              <NavLeaf
                label="Super Admin"
                icon={<ShieldCheck size={15} strokeWidth={1.8} />}
                active={pathname === '/super-admin'}
                onClick={() => navTo('/super-admin')}
              />
            </>
          )}
        </div>

        {/* ── Notification alert block ── */}
        {unreadNotifs > 0 && (
          <div style={{ padding: '0 10px 14px' }}>
            <button
              onClick={() => navTo('/notifications')}
              className="boe-notif-alert"
            >
              <div className="boe-notif-alert-bell">
                <Bell size={24} strokeWidth={1.8} color="#E8A030" />
              </div>
              <div style={{
                fontSize: '28px', fontWeight: 800, color: '#111318', lineHeight: 1,
              }}>
                {unreadNotifs > 99 ? '99+' : unreadNotifs}
              </div>
              <div style={{ fontSize: '11.5px', fontWeight: 600, color: '#3D4455' }}>
                unread {unreadNotifs === 1 ? 'notification' : 'notifications'}
              </div>
              <div style={{
                fontSize: '10px', fontWeight: 600, color: '#E8A030',
                letterSpacing: '0.05em', textTransform: 'uppercase',
              }}>
                Tap to review →
              </div>
            </button>
          </div>
        )}

        {/* ── Bottom profile / account section ── */}
        <ViewModeSidebarSection
          profile={profile}
          onSignOut={onSignOut}
          showSettingsLink
          onSettingsClick={() => navTo('/settings')}
        />

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
          <div className="boe-header-actions">
            {actions}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              title="Refresh"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 32, height: 32, borderRadius: '8px',
                background: refreshing ? 'rgba(232,160,48,0.15)' : 'rgba(0,0,0,0.05)',
                border: '1px solid rgba(0,0,0,0.10)',
                color: refreshing ? '#E8A030' : '#6B7384',
                cursor: refreshing ? 'default' : 'pointer',
                flexShrink: 0, transition: 'background 0.15s, color 0.15s',
              }}
              onMouseEnter={e => { if (!refreshing) { e.currentTarget.style.background = 'rgba(232,160,48,0.12)'; e.currentTarget.style.color = '#E8A030' } }}
              onMouseLeave={e => { if (!refreshing) { e.currentTarget.style.background = 'rgba(0,0,0,0.05)'; e.currentTarget.style.color = '#6B7384' } }}
            >
              <RefreshCw
                size={14}
                strokeWidth={2}
                style={refreshing ? { animation: 'boe-spin 0.7s linear infinite' } : undefined}
              />
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

// ─── CollapsibleNav ───────────────────────────────────────────────────────────
type CollapsibleNavProps = {
  label: string
  active: boolean
  count?: number
  icon?: React.ReactNode
  children: React.ReactNode
}

function CollapsibleNav({ label, active, count, icon, children }: CollapsibleNavProps) {
  const [open, setOpen] = useState(active)

  return (
    <>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          width: '100%',
          padding: '7px 10px', borderRadius: '7px',
          fontSize: '13px', fontWeight: 500,
          color: active ? '#111318' : '#3D4455',
          background: active ? 'rgba(0,0,0,0.04)' : 'transparent',
          border: 'none', cursor: 'pointer',
          marginBottom: '1px',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ color: active ? '#E8A030' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
            {icon}
          </span>
          {label}
          {count != null && count > 0 && (
            <span style={{
              fontSize: '10px', fontWeight: 600, color: '#8C94A6',
              background: 'rgba(0,0,0,0.07)', borderRadius: '999px', padding: '1px 6px', lineHeight: '15px',
            }}>{count}</span>
          )}
        </span>
        <ChevronRight size={12} strokeWidth={2} style={{ opacity: 0.4, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
      </button>
      {open && <NavGroup>{children}</NavGroup>}
    </>
  )
}

// ─── NavLeaf ──────────────────────────────────────────────────────────────────
type NavLeafProps = { label: string; active: boolean; onClick: () => void; icon?: React.ReactNode; badge?: number }

function NavLeaf({ label, active, onClick, icon, badge }: NavLeafProps) {
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
      {badge != null && badge > 0 && (
        <span style={{
          marginLeft: 'auto',
          fontSize: '10px', fontWeight: 700, color: '#ffffff',
          background: '#D94F4F', borderRadius: '999px',
          padding: '1px 6px', lineHeight: '15px', minWidth: '17px', textAlign: 'center',
        }}>
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  )
}

// ─── NavGroup ─────────────────────────────────────────────────────────────────
function NavGroup({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ marginLeft: '18px', marginBottom: '4px', paddingLeft: '10px', borderLeft: '1px solid rgba(0,0,0,0.08)' }}>
      {children}
    </div>
  )
}

// ─── NavChild ─────────────────────────────────────────────────────────────────
type NavChildProps = { label: string; active: boolean; onClick: () => void; count?: number }

function NavChild({ label, active, onClick, count }: NavChildProps) {
  return (
    <button
      className={`boe-nav-item${active ? ' active' : ''}`}
      onClick={onClick}
      style={{ fontSize: '12.5px', fontWeight: active ? 500 : 400, color: active ? '#111318' : '#707A92', padding: '5px 8px', marginBottom: '1px' }}
    >
      <span style={{ flex: 1 }}>{label}</span>
      {count != null && count > 0 && (
        <span style={{
          fontSize: '10px', fontWeight: 600, color: '#8C94A6',
          background: 'rgba(0,0,0,0.07)', borderRadius: '999px',
          padding: '1px 6px', lineHeight: '15px', marginLeft: 'auto',
        }}>{count}</span>
      )}
    </button>
  )
}
