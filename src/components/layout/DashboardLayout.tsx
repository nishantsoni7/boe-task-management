'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import {
  LayoutDashboard, PlusCircle, ClipboardList, CheckSquare,
  ChevronRight,
  Home, Bell, RefreshCw, FileText, Plus,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import type { UserProfile } from '@/lib/types'
import { isValidUUID } from '@/lib/ui'
import { useViewAs } from '@/hooks/useViewAs'
import { BoeBrandIcon } from './BoeBrandIcon'
import { createClient } from '@/lib/supabase/client'
import { useRefresh } from '@/contexts/RefreshContext'
import { ViewModeBanner, ViewModeSidebarSection } from './AdminViewModeControls'
import { MobileBottomNav } from './MobileBottomNav'
import { NotificationsNavItem } from './NotificationsNavItem'
import { useUnreadNotifications } from '@/hooks/queries/useUnreadNotifications'
import { useRecordAppOpen } from '@/hooks/useRecordAppOpen'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { useDisplaySubject } from '@/hooks/queries/useDisplaySubject'
import { deriveQuotationCapabilities, NO_QUOTATION_CAPABILITIES } from '@/lib/permissions/quotations'

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
  const [refreshing,   setRefreshing]   = useState(false)

  const router   = useRouter()
  const pathname = usePathname()
  const supabase = useMemo(() => createClient(), [])

  // Notification count — shared hook so every module reads one source of truth
  // (query key ['notifications', 'count']). TanStack Query deduplicates concurrent
  // fetches (Strict Mode safe); notification mutations (mark read/delete) in
  // notifications/page.tsx invalidate the same key.
  const unreadNotifs = useUnreadNotifications()

  const { triggerRefresh, triggerManualRefresh } = useRefresh()

  // THE BUTTON. Bumps the manual counter as well as the shared one, so a
  // consumer that must re-read only on an explicit press can tell this apart
  // from the tab-visibility path below. Every existing `refreshKey` consumer
  // still sees this press exactly as it did before.
  const handleRefresh = useCallback(() => {
    if (refreshing) return
    setRefreshing(true)
    triggerManualRefresh()
    setTimeout(() => setRefreshing(false), 1000)
  }, [refreshing, triggerManualRefresh])

  // TAB VISIBILITY. Deliberately a different call: the shared counter only,
  // never the manual one. Returning to a tab is not a request for anything, so
  // it must not reach consumers that opted out of automatic re-reads — the
  // dashboard's cached task list in particular. Behaviour for every page that
  // reads `refreshKey` (/tasks/my, NotificationsView) is unchanged, spinner
  // included.
  const handleVisibilityRefresh = useCallback(() => {
    if (refreshing) return
    setRefreshing(true)
    triggerRefresh()
    setTimeout(() => setRefreshing(false), 1000)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerRefresh])

  // Auto-refresh when the tab/app becomes visible again
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') handleVisibilityRefresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { viewAsUserId } = useViewAs()

  const inViewMode  = !!viewAsUserId

  // System Adoption: record that Task Management was opened. Fires at most once
  // per browser session, ignores non-Task-Management routes, and cannot delay or
  // fail this render. The server attributes it to the real signed-in user, so this
  // is safe to run while View As is active — the admin is the one browsing.
  useRecordAppOpen(!!profile)

  // NO ROLE-DERIVED SIDEBAR ENTRIES REMAIN. The admin-only Settings group and
  // the role-derived Team Performance entry both left this sidebar — the first
  // to the Control Center, the second to the launcher card Performance already
  // has. What is left is task navigation plus the quotation entries, and those
  // are decided by the permission engine (quotationCaps below), not by a role.
  //
  // The real logged-in user, plus their role and effective permissions, from the
  // one session-scoped resolution shared with ModuleGuard and /modules.
  //
  // This replaces a per-mount auth.getUser(), which was a NETWORK call to the
  // auth server on every navigation. The property that call was there to
  // guarantee — that a same-tab account switch cannot serve a stale identity —
  // is now held by the auth listener in Providers.tsx, which drops the client
  // cache when the signed-in identity actually changes or the user signs out.
  // Ordinary token refreshes, and repeated SIGNED_IN events for the same person,
  // no longer throw the cache away — which is the whole gain.
  const { userId: authUserId } = usePermissionContext()

  // WHOSE NAVIGATION IS THIS? The DISPLAY SUBJECT's — the signed-in user
  // normally, the viewed employee while previewing. See
  // src/hooks/queries/useDisplaySubject.ts for the identity model.
  const {
    ready: subjectReady,
    subjectUserId,
    subjectRole,
    subjectPermissionsByModule: subjectPermissions,
  } = useDisplaySubject()

  // Getting back to the launcher should not begin with a chunk download.
  useEffect(() => { router.prefetch('/modules') }, [router])

  // Effective user for nav counts: the viewed user in View As mode, otherwise
  // the real logged-in user. Used as the query key so counts are cached per
  // effective user instead of colliding across different logged-in users.
  const effectiveNavUserId = subjectUserId ?? authUserId

  // Sidebar task counts for the effective user. Cached by effectiveNavUserId via
  // React Query so remounting on navigation reuses fresh-enough data instead of
  // refetching every time. Skip when the id is not a real UUID (e.g. seed/test
  // placeholder), and wait until an id is resolved before fetching at all.
  const { data: navCounts = { myActive: 0, assignedByMeActive: 0, quotationActive: 0 } } = useQuery({
    queryKey: ['nav-counts', effectiveNavUserId],
    queryFn: async () => {
      const uid = effectiveNavUserId
      if (!uid || !isValidUUID(uid)) {
        return { myActive: 0, assignedByMeActive: 0, quotationActive: 0 }
      }
      const [myRes, abmRes, qrRes] = await Promise.all([
        supabase
          .from('tasks')
          .select('id', { count: 'exact', head: true })
          .eq('assigned_to', uid)
          .in('status', ['pending', 'started', 'working'])
          .neq('task_type', 'quotation_request'),
        supabase
          .from('tasks')
          .select('id', { count: 'exact', head: true })
          .eq('created_by', uid)
          .neq('assigned_to', uid)
          .neq('status', 'completed')
          .neq('status', 'cancelled'),
        supabase
          .from('tasks')
          .select('id', { count: 'exact', head: true })
          .eq('assigned_to', uid)
          .eq('task_type', 'quotation_request')
          .neq('status', 'completed')
          .neq('status', 'cancelled'),
      ])
      return {
        myActive:           myRes.count  ?? 0,
        assignedByMeActive: abmRes.count ?? 0,
        quotationActive:    qrRes.count  ?? 0,
      }
    },
    enabled: effectiveNavUserId != null,
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
  })

  // Quotation permissions for the DISPLAY SUBJECT — the same person the counts
  // above belong to, so "View As" shows the navigation that employee would
  // actually get.
  //
  // WHAT THIS REPLACES. A local query that read `users.role` for an arbitrary id
  // and called getEffectivePermissions(<that id>) straight from the browser. It
  // produced the right answer, but it put "may this person preview that person"
  // in the client — the resolver RPC is SECURITY DEFINER and takes any user id,
  // so nothing but this component's own `enabled` flag stood between an
  // authenticated employee and somebody else's permission tree. The subject is
  // now resolved by /api/view-as/subject, which decides from the session.
  //
  // Outside View As the subject IS the signed-in user and this costs no request
  // at all: useDisplaySubject hands back the session-scoped context that
  // ModuleGuard and /modules already share.
  //
  // Still defaults to NO capabilities while unresolved, so the quotation items
  // stay hidden until the answer is known. Hiding is not the enforcement
  // boundary — the two routes gate themselves — but a nav item that flashes on
  // before a permission resolves is still a leak of what exists.
  const quotationCaps = subjectReady
    ? deriveQuotationCapabilities(subjectRole, subjectPermissions.get('task_management') ?? [])
    : NO_QUOTATION_CAPABILITIES

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
          <BoeBrandIcon />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="boe-sidebar-brand-name">BOE</div>
            <div className="boe-sidebar-brand-sub">Task Management</div>
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

        {/* Main nav */}
        <div className="boe-sidebar-section">
          {/* 1. Dashboard */}
          <NavLeaf
            label="Dashboard"
            icon={<LayoutDashboard size={15} strokeWidth={1.8} />}
            active={pathname === '/dashboard'}
            onClick={() => navTo('/dashboard')}
          />

          {/* 2. New Quotation Request — hidden in view mode (read-only).
              What is left of the old "New Task" group. Self Task and Delegate
              Task are header actions on every Task Management screen, so the
              group held one child; a group of one is just an item. The route
              and its gate are unchanged — raising a request is a quotation
              operation, manage rather than view. */}
          {!inViewMode && quotationCaps.canManageQuotations && (
            <NavLeaf
              label="New Quotation Request"
              icon={<PlusCircle size={15} strokeWidth={1.8} />}
              active={pathname === '/tasks/quotation-requests/new'}
              onClick={() => navTo('/tasks/quotation-requests/new')}
            />
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

          {/* 4b. Quotation Requests — the register itself, gated on view.
              The badge count goes with it: an employee who may not open the
              register must not learn how many requests are in it either. */}
          {quotationCaps.canViewQuotations && (
            <NavLeaf
              label="Quotation Requests"
              icon={<FileText size={15} strokeWidth={1.8} />}
              active={pathname === '/tasks/quotation-requests'}
              onClick={() => navTo('/tasks/quotation-requests')}
              badge={navCounts.quotationActive || undefined}
            />
          )}

          {/* TASK MANAGEMENT HOLDS TASK WORK, AND NOTHING ELSE.
              Two groups used to live here and no longer do.

              PERFORMANCE was a second front door into a module that already has
              its own: Performance Management is a card on the BOE launcher,
              gated by the `performance` permission engine entry. Reaching it
              through the Task Management sidebar made this module look like the
              way into another one, and the "Team Performance" child duplicated
              the launcher's own management landing. Nothing about the module,
              its scoring, its routes or its permissions changed — only this
              sidebar stopped being a second route in. Mobile matches: see
              MobileBottomNav.

              SETTINGS + SUPER ADMIN were administration. Members is now Control
              Center › People › Employees (which also absorbed the department
              editing the Control Center did separately), Positions is Control
              Center › People › Designations, Super Admin is Control Center ›
              System › Task Records, and My Account is the user menu at the
              bottom of this sidebar. Every one of those routes still exists and
              is still authorized exactly as it was. */}

          {/* Permanent Notifications entry — always visible, badge only when unread */}
          <NotificationsNavItem onNavigate={() => setSidebarOpen(false)} />
        </div>

        {/* ── Notification alert block ── */}
        {unreadNotifs > 0 && (
          <div style={{ padding: '0 10px 14px' }}>
            <button
              onClick={() => navTo('/notifications')}
              className="boe-notif-alert"
            >
              <div className="boe-notif-alert-bell">
                <Bell size={24} strokeWidth={1.8} color="#DC1F2E" />
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
                fontSize: '10px', fontWeight: 600, color: '#DC1F2E',
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
          accountSettingsHref="/account?returnTo=/dashboard"
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

            {/* Task creation, on every Task Management screen.
                They render here rather than page by page, so walking from the
                dashboard into My Tasks or a task's detail never costs the
                creation controls. Both are plain navigations to the EXISTING
                creation routes — this component holds no task logic.
                Hidden while impersonating, exactly like the sidebar group they
                replace: View As is read-only. */}
            {!inViewMode && (
              <>
                <button
                  type="button"
                  className="boe-record-action"
                  style={{ minHeight: 38 }}
                  onClick={() => router.push('/tasks/create-self')}
                >
                  <Plus size={14} strokeWidth={2.2} />
                  Self Task
                </button>
                <button
                  type="button"
                  className="boe-record-action boe-record-action--primary"
                  style={{ minHeight: 38 }}
                  onClick={() => router.push('/tasks/create')}
                >
                  <Plus size={14} strokeWidth={2.2} />
                  Delegate Task
                </button>
              </>
            )}

            <button
              onClick={handleRefresh}
              disabled={refreshing}
              title="Refresh"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 32, height: 32, borderRadius: '8px',
                background: refreshing ? 'rgba(220,31,46,0.08)' : 'rgba(0,0,0,0.05)',
                border: '1px solid rgba(0,0,0,0.10)',
                color: refreshing ? '#DC1F2E' : '#6B7384',
                cursor: refreshing ? 'default' : 'pointer',
                flexShrink: 0, transition: 'background 0.15s, color 0.15s',
              }}
              onMouseEnter={e => { if (!refreshing) { e.currentTarget.style.background = 'rgba(220,31,46,0.08)'; e.currentTarget.style.color = '#DC1F2E' } }}
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

      {/* Mobile-only bottom navigation — hidden on desktop via CSS */}
      <MobileBottomNav
        showNotifications
        notificationsHref="/notifications"
        unreadNotifs={unreadNotifs}
        navCounts={navCounts}
        onSignOut={onSignOut}
      />

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
          <span style={{ color: active ? '#DC1F2E' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
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
      <span style={{ color: active ? '#DC1F2E' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
        {icon}
      </span>
      {label}
      {badge != null && badge > 0 && (
        <span style={{
          marginLeft: 'auto',
          fontSize: '10px', fontWeight: 600, color: '#8C94A6',
          background: 'rgba(0,0,0,0.07)', borderRadius: '999px',
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
