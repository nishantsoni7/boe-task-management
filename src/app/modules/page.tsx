'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { LoadingScreen } from '@/components/ui/atoms'
import { BoeOsLayout } from '@/components/layout/BoeOsLayout'
import DailyQuoteLoader from '@/components/DailyQuoteLoader'
import { useViewAs } from '@/hooks/useViewAs'
import { resolveModuleAccess } from '@/lib/moduleAccess'
import {
  usePermissionContext,
  PERMISSION_STALE_MS,
  PERMISSION_GC_MS,
} from '@/hooks/queries/usePermissionContext'
import { useUnreadCountState } from '@/hooks/queries/useUnreadNotifications'
import { canAccessManagementModule } from '@/lib/permissions/moduleVisibility'
import { deriveCustomerReviewCapabilities } from '@/lib/permissions/customerReviewOutreach'

// ── Module definition ─────────────────────────────────────────────────────────

// THERE IS NO STATUS OR VISIBILITY PILL ON A LAUNCHER CARD. Deliberately.
//
// This card list is now exactly "the modules you can open" — a card exists if
// and only if the parent gate passed. That makes every label the card used to
// carry either redundant or wrong:
//
//   Live / Admin Only / Sales Only / Custom / Hidden
//       came from app_modules.visibility_type, which no longer decides entry
//       for any engine-gated module. `Live` read as "available to everyone" on
//       a card only visible to a `view` holder, and a module whose row said
//       `hidden` would have rendered a card labelled Hidden.
//
//   Active / Foundation / Planned
//       described how finished the FEATURE is. Sitting in the same pill slot,
//       next to a per-employee list, it read as a statement about access.
//
// A module the employee cannot open has no card at all, so there is nothing
// left for a visibility badge to say.
type ModuleDef = {
  key: string
  title: string
  description: string
  href: string
  accent: string
  icon: React.ReactNode
  // undefined = not resolved YET → the footer line stays empty, because the
  //             card is now shown before its count has arrived and printing
  //             "No notifications" there would be asserting something we do
  //             not know. null = there is no count API for this module at all
  //             → "No notifications", as before. 0 = confirmed zero, >0 = badge.
  notificationCount?: number | null
}

// ── Page ─────────────────────────────────────────────────────────────────────

// ── Visibility resolvers ─────────────────────────────────────────────────────
//
// TWO of them, and which one a module uses is the whole point of this screen.
//
//   canOpenModule   THE PARENT GATE. Effective `view` from the permission
//                   engine, via the same canAccessManagementModule the route
//                   guards call (src/components/layout/ModuleGuard.tsx). Used
//                   by every module in ENGINE_GATED_MODULE_KEYS. A card and a
//                   URL therefore cannot disagree: both ask one function.
//
//   canSeeModule    app_modules.visibility_type. Now used ONLY for the
//                   Attendance/Payroll self-service card, which is what that
//                   table legitimately still governs — see
//                   SELF_SERVICE_MODULE_KEYS in src/lib/moduleAccess.ts.
//
// Before this change every module except Orders and Meetings used the second
// one. Access Control writes employee_permission_overrides and never writes
// app_modules, so unticking "Module access" for an employee stored a decision
// the launcher did not read: the card stayed, and so did the route.

type ModVisRow = {
  visibility_type: string
  allowed_department: string[] | null
  allowed_user_ids: string[] | null
}

function canSeeModule(
  key: string,
  modVis: Record<string, ModVisRow>,
  effectiveProfile: UserProfile | null,
  fallback: boolean,
): boolean {
  return resolveModuleAccess(key, modVis[key], effectiveProfile, fallback)
}

/**
 * Sample Tracking's unread count, which lives in its own table behind its own
 * endpoint (`/api/samples/notifications`) and is not part of the shared
 * `notifications` feed. Task, Finance and Orders now come from the one canonical
 * count query instead — see the hooks in the component below.
 */
type ModuleCounts = {
  sample?: number | null
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function BoeOsHomePage() {
  // ── Notification counts, tagged with the user they belong to ────────────────
  //
  // A missing field = not resolved yet → the footer line stays empty. null = the
  // request failed → "No notifications", the pre-existing rule. A number is a
  // real count.
  //
  // They are stored together WITH the user id they were fetched for, rather than
  // as four loose values, so that signing in as somebody else cannot show the
  // previous user's numbers. The derivation below discards them in the same
  // render the identity changes — not one effect later — so there is no frame in
  // which the wrong person's counts are on screen.
  const [countState, setCountState] =
    useState<{ userId: string | null; counts: ModuleCounts }>({ userId: null, counts: {} })

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { viewAsUserId, viewAsProfile } = useViewAs()

  // ── PHASE 1: who are you, and what may you open ─────────────────────────────
  //
  // THE PARENT GATE for every engine-gated module, resolved for the SIGNED-IN
  // user in one round trip, and now shared with ModuleGuard and DashboardLayout
  // through one cache entry instead of each resolving it again. View As is a
  // preview of somebody else's screen and never lends or removes authority, so
  // the gate below still always reads the real caller.
  //
  // A failed profile read leaves role null and canAccessManagementModule denies
  // — fail-closed for non-admins, while an admin still short-circuits on role
  // alone and so is unaffected by a permissions RPC failure. Both behaviours are
  // preserved inside usePermissionContext.
  const {
    ready: permsReady,
    userId,
    profile,
    role: signedInRole,
    permissionsByModule: permsByModule,
  } = usePermissionContext()

  // Counts belong to the user they were fetched for. If the signed-in user has
  // changed, the previous user's numbers are discarded in this very render —
  // the cards fall back to the unresolved (empty) footer line rather than
  // briefly showing somebody else's totals while the new requests are in
  // flight. This is a derivation, not a reset, so there is no intermediate
  // state and no extra render.
  const counts: ModuleCounts = countState.userId === userId ? countState.counts : {}

  // Still needed, but only for the Attendance/Payroll self-service card — the
  // one module family app_modules legitimately still governs. Keyed by the
  // signed-in user because RLS decides which rows this caller may read.
  const { data: modVis = {}, isPending: modVisPending } = useQuery<Record<string, ModVisRow>>({
    queryKey: ['app-modules-visibility', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data } = await supabase
        .from('app_modules')
        .select('module_key, visibility_type, allowed_department, allowed_user_ids')
        .order('sort_order')
      const vis: Record<string, ModVisRow> = {}
      for (const m of data ?? []) vis[m.module_key] = m
      return vis
    },
    staleTime: PERMISSION_STALE_MS,
    gcTime: PERMISSION_GC_MS,
  })

  useEffect(() => {
    if (permsReady && userId === null) router.push('/login')
  }, [permsReady, userId, router])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  // In View Mode use the viewed user's profile for card visibility; fall back to actual profile.
  const effectiveProfile = (viewAsUserId && viewAsProfile) ? viewAsProfile : profile

  // THE PARENT GATE. `view` on the module, or admin. Nothing else opens a
  // module: a leftover `dispatch` or `manage` grant with view = false is a
  // dormant permission, not an entry ticket.
  const canOpenModule = (moduleKey: string): boolean =>
    canAccessManagementModule({
      role: signedInRole,
      moduleKey,
      // The resolver returns no rows at all for an inactive or unregistered
      // module, so the `view` test inside fails on its own.
      isModuleActive: true,
      permissions: permsByModule.get(moduleKey) ?? [],
    })

  // THE ONE MODULE canOpenModule CANNOT ANSWER FOR.
  //
  // Customer Review Outreach registers `use` and `verify` and no `view` at all
  // (src/lib/permissions/modules.ts), because it has no read-only audience — a
  // holder sees their own outreach and nobody else's. canAccessManagementModule
  // asks strictly for `view`, and asking it here would hide the card from every
  // single person who actually holds the module.
  //
  // This is NOT a weaker gate. It reads the same resolver output, for the same
  // signed-in user, through the module's own capability derivation — the same
  // function src/app/customer-reviews/layout.tsx branches on — so the card and
  // the route still cannot disagree.
  const canOpenCustomerReviews =
    permsReady &&
    deriveCustomerReviewCapabilities(
      signedInRole,
      permsByModule.get('customer_review_requests') ?? [],
    ).canAccessModule

  // Fallback used when app_modules DB data is unavailable. Now reached only by
  // the Attendance/Payroll self-service card — every other module resolves
  // through canOpenModule and has no app_modules fallback to fall back TO.
  const isAdminFallback = effectiveProfile?.role === 'admin'

  // Whether the Attendance & Payroll card points at the management module or at
  // the employee's own record. Only admins manage; see
  // SELF_SERVICE_MODULE_KEYS in src/lib/moduleAccess.ts.
  const isModuleAdmin = isAdminFallback

  // The Showroom team-name fallback is gone with it. It existed so that Sales
  // and Showroom staff kept the card when app_modules was unreachable; entry is
  // now an explicit `showroom_qr:view` grant, and inferring authority from a
  // free-text team name is exactly the implicit rule this work removes.

  // Management lands on Team Performance, everyone else on their own report.
  const performanceHref =
    (effectiveProfile?.role === 'admin' || effectiveProfile?.role === 'manager')
      ? '/performance/team'
      : '/performance'

  // ── Attendance & Payroll — one card for what used to be two ────────────────
  //
  // Attendance is where payroll's input comes from, so from the launcher they
  // are one destination. They remain two `app_modules` rows, two visibility
  // settings and two route guards; nothing about who may see what changed here.
  //
  // VISIBILITY is the union of the two rows: whoever could previously open an
  // Attendance card OR a Payroll card gets the combined one. Anything narrower
  // would silently revoke access somebody has today. Whoever could open neither
  // still gets nothing, and `hidden` on both still hides it.
  const canSeeAttendance = canSeeModule('attendance', modVis, effectiveProfile, isAdminFallback)
  const canSeePayroll    = canSeeModule('payroll',    modVis, effectiveProfile, isAdminFallback)

  // DESTINATION follows what the person can actually open. Admins get the
  // management surface; everyone else gets their own record, starting at
  // attendance. The `/my-payroll` branch is for the one asymmetric case — an
  // employee granted Payroll while Attendance is hidden — who would otherwise
  // land on a module they were not given.
  //
  // Neither branch is an authorisation: /my-attendance and /my-payroll are
  // served by APIs that derive the employee from the bearer token, and the
  // admin routes are behind AttendanceGuard / PayrollGuard.

  // ONE QUERY KEY PER CATEGORY, shared with the desktop sidebar and the mobile
  // bottom nav.
  //
  // This card used to run its own `fetch` into local state — a third copy of a
  // number two other surfaces already had, with no cache behind it. So the
  // launcher paid for a fresh round trip on every visit and a hard refresh had
  // nothing to show at all. Reading the shared hook means the value is seeded
  // from the persisted last-known count in the first render, revalidated in the
  // background, and reused by whichever nav mounts next without a second
  // request.
  //
  // The authorization gate is UNCHANGED and is declared here rather than below
  // because a card needs the number: `enabled` is the same `mayOpen…` test the
  // fetch was guarded by, so a module this employee cannot open still issues no
  // request.
  const mayOpenTask    = permsReady && canOpenModule('task_management')
  const mayOpenSample  = permsReady && canOpenModule('sample_tracking')
  const mayOpenFinance = permsReady && canOpenModule('finance')
  const mayOpenOrders  = permsReady && canOpenModule('orders')

  const taskCount    = useUnreadCountState('task',    mayOpenTask)
  const financeCount = useUnreadCountState('finance', mayOpenFinance)
  const orderCount   = useUnreadCountState('order',   mayOpenOrders)

  const attendancePayrollHref = isModuleAdmin
    ? '/payroll'
    : (canSeeAttendance ? '/my-attendance' : '/my-payroll')

  const attendancePayroll: ModuleDef | null = (canSeeAttendance || canSeePayroll) ? {
    key: 'attendance_payroll',
    title: 'Attendance & Payroll',
    description: isModuleAdmin
      ? 'Import attendance, review the month, run payroll, and manage salary settings.'
      : 'View your own attendance, payslips, and the issues you have raised.',
    href: attendancePayrollHref,
    accent: '#0F766E',
    icon: <CalIcon />,
    // The two experiences are told apart by the description above and by where
    // the card goes, not by a pill. This is still the one card whose visibility
    // comes from app_modules, and it is unchanged by the parent-gate work.
    notificationCount: null,
  } : null

  const modules: ModuleDef[] = [
    ...(canOpenModule('task_management') ? [{
      key: 'tasks',
      title: 'Task Management',
      description: 'Create, assign, and track tasks across your team.',
      href: '/dashboard',
      accent: '#1A2035',
      icon: <TaskIcon />,
      notificationCount: taskCount.count,
    }] : []),
    ...(canOpenModule('sample_tracking') ? [{
      key: 'samples',
      title: 'Sample Tracking',
      description: 'Request sample catalogs, track dispatch and returns, follow up on overdue items.',
      href: '/samples',
      accent: '#B45309',
      icon: <BoxIcon />,
      notificationCount: counts.sample,
    }] : []),
    ...(attendancePayroll ? [attendancePayroll] : []),
    ...(canOpenModule('showroom_qr') ? [{
      key: 'showroom',
      title: 'Showroom QR',
      description: 'QR-based showroom inquiries and quotations.',
      href: '/showroom-admin',
      accent: '#7C3AED',
      icon: <ShowroomIcon />,
      notificationCount: null,
    }] : []),
    ...(canOpenModule('assets_access') ? [{
      key: 'assets',
      title: 'Assets & Access',
      description: 'View your assigned devices and access records, or manage the company inventory.',
      href: '/assets-access',
      accent: '#4B5563',
      icon: <AssetIcon />,
      notificationCount: null,
    }] : []),
    ...(canOpenModule('employee_records') ? [{
      key: 'members',
      title: 'Employee Records',
      description: 'View and manage employee profiles, roles, and team assignments.',
      href: '/admin/members',
      accent: '#1E40AF',
      icon: <MembersIcon />,
      notificationCount: null,
    }] : []),
    // Gated by the existing `performance` row in app_modules (live, sort 80).
    // Destination follows the effective profile so View As lands on the viewed
    // user's own page; the team route is still authorized server-side against
    // the real caller, so this grants nothing on its own.
    ...(canOpenModule('performance') ? [{
      key: 'performance',
      title: 'Performance Management',
      description: 'Review personal performance, EOD discipline, team execution, and employees requiring attention.',
      href: performanceHref,
      accent: '#0369A1',
      icon: <PerformanceIcon />,
      notificationCount: null,
    }] : []),
    ...(canOpenModule('finance') ? [{
      key: 'finance',
      title: 'Finance',
      description: 'Payment confirmations, order advances, and finance approvals.',
      href: '/finance',
      accent: '#065F46',
      icon: <FinanceIcon />,
      notificationCount: financeCount.count,
    }] : []),
    ...(canOpenModule('meetings') ? [{
      key: 'meetings',
      title: 'Meetings',
      description: 'Run New Order and Repair Order reviews, record SKU updates, and track follow-ups.',
      href: '/meetings',
      accent: '#7C2D12',
      icon: <MeetingsIcon />,
      notificationCount: null,
    }] : []),
    ...(canOpenCustomerReviews ? [{
      key: 'customer_reviews',
      title: 'Customer Review Outreach',
      description: 'Invite genuine customers to leave an honest review, and track what happened.',
      href: '/customer-reviews',
      accent: '#0E7490',
      icon: <ReviewOutreachIcon />,
      notificationCount: null,
    }] : []),
    ...(canOpenModule('orders') ? [{
      key: 'orders',
      title: 'Order Management',
      description: 'Track confirmed orders from request through production and dispatch.',
      href: '/orders',
      accent: '#DC1F2E',
      icon: <OrdersIcon />,
      notificationCount: orderCount.count,
    }] : []),
    ...(effectiveProfile?.role === 'admin' ? [{
      key: 'control_center',
      title: 'Admin Control Center',
      description: 'Control modules, departments, and user department access.',
      href: '/admin/control-center',
      accent: '#6B21A8',
      icon: <ControlCenterIcon />,
      notificationCount: null,
    }] : []),
  ]

  // ── PHASE 2: counts, only for the modules this person may open ──────────────
  //
  // These no longer gate the screen. The cards are the answer to "what may I
  // open", and that answer is complete the moment the gate resolves; a badge is
  // ambient information about one of them. Blocking the whole launcher on four
  // notification endpoints — each of which re-authenticates server-side before
  // it counts anything — meant the slowest of them decided when anyone could
  // click anything.
  //
  // The authorization rule is UNCHANGED: a module the employee cannot open
  // still issues no request, so the deferral did not turn a skipped fetch into
  // a fetch whose answer is discarded. Each count is stored on arrival rather
  // than awaited together, so one slow endpoint no longer holds the other three.

  useEffect(() => {
    if (!permsReady || !userId) return
    // Guards against a response for the PREVIOUS user landing after the switch:
    // cleanup runs before the next effect, so that run's `active` is already
    // false and its `store` calls become no-ops.
    let active = true

    // Each count is written on arrival, tagged with the user it belongs to, so
    // one slow endpoint no longer holds up the other three. Keep null if the
    // request failed so the card reads "No notifications" rather than showing a
    // wrong number — the pre-existing rule, unchanged.
    const store = (field: keyof ModuleCounts, value: number | null) => {
      if (!active) return
      setCountState(prev => ({
        userId,
        // Discard anything belonging to a different user rather than merging
        // this field into their object.
        counts: { ...(prev.userId === userId ? prev.counts : {}), [field]: value },
      }))
    }

    // A module this employee cannot open issues NO request — unchanged — and
    // stores nothing either: its card is not rendered, so there is no footer
    // line for a value to appear on.
    const load = (allowed: boolean, url: string, field: keyof ModuleCounts) => {
      if (!allowed) return
      fetch(url)
        .then(r => (r.ok ? r.json() : null))
        .then((json: { unreadCount?: number } | null) =>
          store(field, json != null ? (json.unreadCount ?? 0) : null))
        .catch(() => store(field, null))
    }

    // Sample Tracking only. Its unread count lives in `sample_notifications`
    // behind its own endpoint, so it has no shared query key to read; Task,
    // Finance and Orders are served by useUnreadCountState above.
    load(mayOpenSample, '/api/samples/notifications?count=1', 'sample')

    return () => { active = false }
  }, [permsReady, userId, mayOpenSample])

  // Warm the routes behind the cards that are actually on screen, so the click
  // does not begin with a chunk download. `modules` contains ONLY authorized
  // entries — an unauthorized destination is never in this list and so is never
  // prefetched. Runs after the gate for the same reason the counts do.
  const moduleHrefs = modules.map(mod => mod.href).join('|')
  useEffect(() => {
    if (!permsReady) return
    for (const href of moduleHrefs.split('|').filter(Boolean)) router.prefetch(href)
  }, [permsReady, moduleHrefs, router])

  // The gate, and only the gate. app_modules is included because the
  // Attendance & Payroll card's visibility comes from it, so rendering before
  // it lands could omit a card the employee is entitled to.
  const loading = !permsReady || modVisPending

  return (
    <DailyQuoteLoader>
      {loading ? <LoadingScreen /> : (
        <BoeOsLayout
          profile={profile}
          title="BOE Operating System"
          subtitle={new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
          onSignOut={handleSignOut}
        >
          {/* Section label */}
          <div style={{
            fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em',
            color: '#8C94A6', textTransform: 'uppercase', marginBottom: '16px',
          }}>
            Modules
          </div>

          {/* Responsive app-launcher grid */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: '20px',
          }}>
            {modules.map(mod => (
              <ModuleCard
                key={mod.key}
                mod={mod}
                onClick={() => router.push(mod.href)}
              />
            ))}
          </div>
        </BoeOsLayout>
      )}
    </DailyQuoteLoader>
  )
}

// ── ModuleCard ────────────────────────────────────────────────────────────────

function ModuleCard({ mod, onClick }: { mod: ModuleDef; onClick: () => void }) {
  const [hovered, setHovered] = useState(false)

  const hasNotif = (mod.notificationCount ?? 0) > 0
  const count    = mod.notificationCount

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onClick()}
      style={{
        background: '#fff',
        border: `1.5px solid ${hovered ? mod.accent : '#E8EBF0'}`,
        borderRadius: '16px',
        padding: '24px 22px 20px',
        cursor: 'pointer',
        transition: 'border-color 0.15s, box-shadow 0.15s, transform 0.15s',
        boxShadow: hovered
          ? `0 8px 24px rgba(0,0,0,0.10), 0 2px 6px rgba(0,0,0,0.06)`
          : '0 1px 4px rgba(0,0,0,0.05)',
        transform: hovered ? 'translateY(-2px)' : 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        minHeight: '200px',
      }}
    >
      {/* ── Icon block with notification badge ── */}
      <div style={{ position: 'relative', alignSelf: 'flex-start' }}>
        <div style={{
          width: 56, height: 56, borderRadius: '14px',
          background: `${mod.accent}12`,
          border: `1.5px solid ${mod.accent}22`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: mod.accent,
          transition: 'background 0.15s',
          ...(hovered ? { background: `${mod.accent}1E` } : {}),
        }}>
          {mod.icon}
        </div>
        {hasNotif && (
          <div style={{
            position: 'absolute', top: '-5px', right: '-5px',
            background: '#D94F4F', color: '#fff',
            fontSize: '9px', fontWeight: 800,
            borderRadius: '999px',
            minWidth: '18px', height: '18px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 4px',
            border: '2px solid #fff',
            boxShadow: '0 1px 3px rgba(0,0,0,0.18)',
            letterSpacing: '0.01em',
          }}>
            {count! > 99 ? '99+' : count}
          </div>
        )}
      </div>

      {/* ── Name + description ── */}
      <div style={{ flex: 1 }}>
        <div style={{
          fontSize: '15px', fontWeight: 700, color: '#111318',
          letterSpacing: '-0.02em', marginBottom: '5px', lineHeight: 1.2,
        }}>
          {mod.title}
        </div>
        <div style={{
          fontSize: '12px', color: '#6B7384', lineHeight: 1.5,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {mod.description}
        </div>
      </div>

      {/* ── Footer: notification line + open ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingTop: '12px',
        borderTop: '1px solid #F3F4F6',
        gap: '8px',
      }}>
        {/* Left: notification signal. The status pill that used to sit here is
            gone — see the note on ModuleDef. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          {/* An unresolved count (undefined) renders a compact placeholder, not
              "No notifications": the card is on screen before its badge is
              known, and printing a zero-state we have not confirmed would be
              stating something false for as long as the request is in flight.
              With the persisted last-known count seeding the query, this state
              is now reached only on a first-ever visit or after a sign-out. A
              resolved null still reads "No notifications", as it always did:
              that is a module with no count API rather than one still being
              counted, and a resolved ZERO reads the same way. */}
          {count === undefined ? (
            /* Nothing known yet: no persisted count and no response. A tinted
               bar on a box of exactly the text's height, so the footer — and
               therefore the card — is the height it will be once the number
               lands and nothing moves under the cursor. Announced as busy
               rather than read out as an empty region. */
            <span
              role="status"
              aria-busy="true"
              aria-label="Loading notification count"
              style={{
                display: 'inline-block',
                width: '84px', height: '11px',
                borderRadius: '4px',
                background: 'rgba(0,0,0,0.06)',
                verticalAlign: 'middle',
              }}
            />
          ) : (
            <span style={{
              fontSize: '11px',
              color: hasNotif ? '#D94F4F' : '#B0B8C8',
              fontWeight: hasNotif ? 600 : 400,
              whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {count == null
                ? 'No notifications'
                : hasNotif
                  ? `${count} ${count === 1 ? 'notification' : 'notifications'}`
                  : 'No notifications'}
            </span>
          )}
        </div>

        {/* Right: Open */}
        <span style={{
          fontSize: '12px', fontWeight: 600,
          color: hovered ? mod.accent : '#A0A9BE',
          display: 'flex', alignItems: 'center', gap: '3px',
          transition: 'color 0.15s',
          flexShrink: 0,
        }}>
          Open
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: hovered ? 'translateX(2px)' : 'none', transition: 'transform 0.15s' }}>
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
        </span>
      </div>
    </div>
  )
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function TaskIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  )
}

function BoxIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.29 7 12 12 20.71 7" /><line x1="12" y1="22" x2="12" y2="12" />
    </svg>
  )
}

// Attendance & Payroll. The calendar stands for the month, which is the unit
// both halves of the module work in — a month of punches, and the payroll run
// computed from it. (The separate banknote icon went with the separate card.)
function CalIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  )
}

function AssetIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
      <path d="M7 8h.01M11 8h4M7 12h.01M11 12h4" />
    </svg>
  )
}

function MembersIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  )
}

function ControlCenterIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07M8.46 8.46a5 5 0 0 0 0 7.07" />
    </svg>
  )
}

function PerformanceIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" />
    </svg>
  )
}

function FinanceIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  )
}

function OrdersIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <line x1="9" y1="12" x2="15" y2="12" /><line x1="9" y1="16" x2="13" y2="16" />
    </svg>
  )
}

function ReviewOutreachIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
      <path d="M9.5 11.5h5M9.5 14h3" />
    </svg>
  )
}

function MeetingsIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="16" y1="2" x2="16" y2="6" />
      <path d="M8 13h5M8 17h8" />
    </svg>
  )
}

function ShowroomIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h2v2h-2zM18 14h3M14 18h2M18 18h3M14 21h5" />
    </svg>
  )
}
