'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import {
  LayoutDashboard, PlusCircle, ClipboardList, CheckSquare,
  Settings, ChevronRight, LogOut, Briefcase, ShieldCheck, TrendingUp,
  Eye, X, ChevronDown, Users, Home,
} from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { initials } from '@/lib/ui'
import { useViewAs } from '@/hooks/useViewAs'
import { createClient } from '@/lib/supabase/client'

// ─── DashboardLayout ──────────────────────────────────────────────────────────

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
  const [sidebarOpen, setSidebarOpen]   = useState(false)
  const [members,     setMembers]       = useState<UserProfile[]>([])
  const [switcherOpen, setSwitcherOpen] = useState(false)

  const router   = useRouter()
  const pathname = usePathname()
  const supabase = useMemo(() => createClient(), [])

  const { viewAsUserId, viewAsProfile, enterViewMode, exitViewMode } = useViewAs()

  const isRealAdmin = profile?.role === 'admin'
  const inViewMode  = !!viewAsUserId

  // Sidebar nav reflects the viewed user's role when in view mode
  const navProfile       = viewAsProfile ?? profile
  const isAdmin          = navProfile?.role === 'admin'
  const isAdminOrManager = isAdmin || navProfile?.role === 'manager'

  // Fetch members once for the switcher (admin only)
  useEffect(() => {
    if (!isRealAdmin) return
    supabase
      .from('users')
      .select('id, full_name, email, phone, role, team, position, is_active, created_at')
      .eq('is_active', true)
      .order('full_name')
      .then((res: { data: UserProfile[] | null }) => {
        if (res.data) setMembers(res.data)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRealAdmin])

  const navTo = (path: string) => {
    router.push(path)
    setSidebarOpen(false)
  }

  const handleEnterViewMode = (member: UserProfile) => {
    enterViewMode(member.id, member)
    setSwitcherOpen(false)
    router.push('/dashboard')
  }

  const handleExitViewMode = () => {
    exitViewMode()
    router.push('/dashboard')
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
            active={pathname === '/tasks/my' || pathname === '/tasks/my/completed'}
            count={taskCounts ? (taskCounts.myInProgress ?? 0) + (taskCounts.myCompleted ?? 0) : undefined}
          >
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
          </CollapsibleNav>

          {/* 4. Assigned By Me */}
          <CollapsibleNav
            label="Assigned By Me"
            icon={<CheckSquare size={15} strokeWidth={1.8} />}
            active={pathname === '/tasks/assigned-by-me' || pathname === '/tasks/assigned-by-me/completed'}
            count={taskCounts?.assignedByMeInProgress}
          >
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

          {/* 7 & 8. Settings + Super Admin — admin only, hidden in view mode */}
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

        {/* ── Bottom profile / account section ── */}
        {profile && (
          <div style={{
            marginTop: 'auto',
            borderTop: '1px solid rgba(0,0,0,0.07)',
            padding: '10px 10px 6px',
          }}>

            {inViewMode ? (
              /* ── View mode active ── */
              <div style={{ padding: '8px 10px 6px' }}>
                <div style={{
                  fontSize: '10px', fontWeight: 700, color: '#D97706',
                  textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px',
                }}>
                  Viewing As
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: '7px',
                    background: '#FEF3C7',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '11px', fontWeight: 700, color: '#D97706', flexShrink: 0,
                  }}>
                    {initials(viewAsProfile?.full_name ?? '')}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '12.5px', fontWeight: 600, color: '#111318', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {viewAsProfile?.full_name}
                    </div>
                    <div style={{ fontSize: '10.5px', color: '#D97706', textTransform: 'capitalize' }}>
                      {viewAsProfile?.role} · {viewAsProfile?.team}
                    </div>
                  </div>
                </div>
                <button
                  onClick={handleExitViewMode}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    gap: '6px', fontSize: '12px', fontWeight: 600,
                    color: '#92400E', background: '#FEF3C7',
                    border: '1px solid #FDE68A', borderRadius: '7px',
                    padding: '6px 10px', cursor: 'pointer',
                  }}
                >
                  <X size={12} strokeWidth={2.5} />
                  Exit View Mode
                </button>
              </div>
            ) : (
              /* ── Normal mode ── */
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px 6px' }}>
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
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: '12.5px', fontWeight: 600, color: '#111318', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {profile.full_name}
                    </div>
                    <div style={{ fontSize: '10.5px', color: '#8C94A6', textTransform: 'capitalize' }}>
                      {profile.role} · {profile.team}
                    </div>
                  </div>
                </div>

                {/* Switch User button — admin only */}
                {isRealAdmin && members.length > 0 && (
                  <div style={{ position: 'relative', margin: '4px 0 6px' }}>
                    <button
                      onClick={() => setSwitcherOpen(o => !o)}
                      style={{
                        width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        fontSize: '12px', fontWeight: 500,
                        color: '#3D4455', background: 'rgba(0,0,0,0.04)',
                        border: '1px solid rgba(0,0,0,0.08)', borderRadius: '7px',
                        padding: '6px 10px', cursor: 'pointer',
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <Users size={13} strokeWidth={1.8} />
                        Switch User
                      </span>
                      <ChevronDown size={12} strokeWidth={2} style={{ transform: switcherOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
                    </button>

                    {switcherOpen && (
                      <>
                        {/* Click-away backdrop */}
                        <div
                          style={{ position: 'fixed', inset: 0, zIndex: 49 }}
                          onClick={() => setSwitcherOpen(false)}
                        />
                        <div style={{
                          position: 'absolute', bottom: 'calc(100% + 4px)', left: 0, right: 0,
                          background: '#fff',
                          border: '1px solid #E5E7EB',
                          borderRadius: '10px',
                          boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                          zIndex: 50,
                          maxHeight: '260px',
                          overflowY: 'auto',
                          padding: '6px',
                        }}>
                          <div style={{ fontSize: '10px', fontWeight: 700, color: '#8C94A6', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '4px 8px 6px' }}>
                            View as member
                          </div>
                          {members
                            .filter(m => m.id !== profile.id)
                            .map(member => (
                              <button
                                key={member.id}
                                onClick={() => handleEnterViewMode(member)}
                                style={{
                                  width: '100%', display: 'flex', alignItems: 'center', gap: '8px',
                                  padding: '7px 8px', borderRadius: '7px',
                                  background: 'none', border: 'none', cursor: 'pointer',
                                  textAlign: 'left', transition: 'background 0.1s',
                                }}
                                onMouseEnter={e => (e.currentTarget.style.background = '#F9FAFB')}
                                onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                              >
                                <div style={{
                                  width: 26, height: 26, borderRadius: '6px',
                                  background: '#1A2035',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  fontSize: '10px', fontWeight: 700, color: '#E8A030', flexShrink: 0,
                                }}>
                                  {initials(member.full_name)}
                                </div>
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontSize: '12.5px', fontWeight: 500, color: '#111318', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {member.full_name}
                                  </div>
                                  <div style={{ fontSize: '10.5px', color: '#8C94A6', textTransform: 'capitalize' }}>
                                    {member.role}
                                  </div>
                                </div>
                              </button>
                            ))}
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Account settings link — visible to non-admins only (admins use sidebar nav) */}
                {!isRealAdmin && (
                  <button
                    className="boe-nav-item"
                    onClick={() => navTo('/settings')}
                    style={{ color: '#8C94A6', fontSize: '12.5px', gap: '8px' }}
                  >
                    <Settings size={14} strokeWidth={1.8} />
                    Account Settings
                  </button>
                )}

                <button
                  onClick={onSignOut}
                  className="boe-nav-item"
                  style={{ color: '#8C94A6', fontSize: '12.5px', gap: '8px' }}
                >
                  <LogOut size={14} strokeWidth={1.8} />
                  Sign out
                </button>
              </>
            )}
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

          {/* ── Admin View Mode amber banner ── */}
          {inViewMode && viewAsProfile && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              flexWrap: 'wrap', gap: '8px',
              padding: '12px 20px',
              background: '#FFFBEB',
              border: '1.5px solid #FCD34D',
              borderRadius: '10px',
              marginBottom: '20px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <Eye size={16} color="#D97706" strokeWidth={2.2} style={{ flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: '#78350F', letterSpacing: '-0.01em' }}>
                    ADMIN VIEW MODE — Viewing as <strong>{viewAsProfile.full_name}</strong>
                  </div>
                  <div style={{ fontSize: '11.5px', color: '#92400E', marginTop: '1px' }}>
                    You are observing this user&apos;s workspace. All actions are disabled.
                  </div>
                </div>
                <span style={{
                  fontSize: '10px', fontWeight: 700,
                  color: '#B45309', background: '#FEF3C7',
                  borderRadius: '4px', padding: '2px 8px',
                  border: '1px solid #FDE68A',
                  whiteSpace: 'nowrap',
                }}>
                  READ ONLY
                </span>
              </div>
              <button
                onClick={handleExitViewMode}
                style={{
                  display: 'flex', alignItems: 'center', gap: '5px',
                  fontSize: '12px', fontWeight: 600,
                  color: '#92400E', background: '#FEF3C7',
                  border: '1px solid #FDE68A', borderRadius: '6px',
                  padding: '6px 14px', cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                <X size={12} strokeWidth={2.5} />
                Exit View Mode
              </button>
            </div>
          )}

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
