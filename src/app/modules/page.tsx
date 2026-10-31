'use client'

import { useEffect, useState, useMemo, useReducer } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { LoadingScreen } from '@/components/ui/atoms'
import { Toast, useToast } from '@/components/ui/toast'
import { BoeOsLayout } from '@/components/layout/BoeOsLayout'
import DailyQuoteLoader from '@/components/DailyQuoteLoader'
import { resolveModuleAccess } from '@/lib/moduleAccess'
import {
  usePermissionContext,
  PERMISSION_STALE_MS,
  PERMISSION_GC_MS,
} from '@/hooks/queries/usePermissionContext'
import { useUnreadCountState } from '@/hooks/queries/useUnreadNotifications'
import { canAccessManagementModule } from '@/lib/permissions/moduleVisibility'
import { deriveCustomerReviewCapabilities } from '@/lib/permissions/customerReviewOutreach'
import { deriveFinanceCapabilities } from '@/lib/permissions/finance'
import { useDisplaySubject } from '@/hooks/queries/useDisplaySubject'
import { buildQuickActions, QuickActionList } from '@/components/layout/QuickActions'
import { exhibitionsQuery, readCachedExhibitions } from '@/lib/exhibitionLeads/queries'
import { intakeState, showQuickLink } from '@/lib/exhibitionLeads/intake'
import { Armchair, ArrowUpRight, ChevronRight, ContactRound, Factory, Image as ImageIcon, Megaphone, Tag, TrendingUp } from 'lucide-react'
import {
  TaskIcon, BoxIcon, CalIcon, AssetIcon, MembersIcon, ControlCenterIcon, PerformanceIcon, FinanceIcon,
  OrdersIcon, ReviewOutreachIcon, MeetingsIcon, ShowroomIcon,
} from '@/components/modules/ModuleIcons'
import {
  IDLE_MODULE_ORDER_EDIT,
  moduleOrderEditReducer,
  moduleOrderEquals,
  moduleCardPressProps,
  moduleOrderKeys,
  visibleModuleOrder,
} from '@/lib/modules/moduleOrder'
import {
  useModuleOrder,
  useModuleOrderCache,
  saveModuleOrder,
} from '@/hooks/queries/useModuleOrder'
import {
  ModuleOrderBar,
  ModuleDragHandle,
  useModuleReorderPointer,
} from './ModuleOrderControls'
import { useMyAnnouncements } from '@/hooks/queries/useAnnouncements'
import { AnnouncementBell } from '@/components/announcements/AnnouncementBell'
import { participatesInPayroll } from '@/lib/payroll/participation'
import { AttentionPanel, AttentionStrip, type AttentionSources } from './AttentionPanel'
import styles from './modules.module.css'

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
  icon: React.ReactNode
  // undefined = not resolved YET → the footer line stays empty, because the
  //             card is now shown before its count has arrived and printing
  //             "No notifications" there would be asserting something we do
  //             not know. null = there is no count API for this module at all
  //             → "No notifications", as before. 0 = confirmed zero, >0 = badge.
  notificationCount?: number | null
}

// ── The essentials ───────────────────────────────────────────────────────────
//
// The three modules most people open most days, featured as a larger row above
// the rest. A PRESENTATION GROUPING AND NOTHING ELSE: a key here only decides
// which section an authorized card is drawn in. A person who cannot open one of
// these simply has no card for it, in either section. The row's sequence follows
// the rendered order, so Edit order still arranges it.
const ESSENTIAL_MODULE_KEYS: readonly string[] = ['tasks', 'orders', 'finance']

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
  // The AUTHENTICATED ACTOR. `userId` is the session check below and the key the
  // notification counts are tagged with; `profile` is the account menu at the
  // foot of the sidebar, which must keep naming the real signed-in person even
  // while they preview somebody else.
  const { userId, profile } = usePermissionContext()

  // WHOSE LAUNCHER IS THIS? Outside View As the subject is the signed-in user
  // and nothing below changes. While previewing, every card decision reads the
  // viewed employee's own role and effective permissions — resolved server-side
  // by /api/view-as/subject, which decides from the session whether this caller
  // may preview at all. See src/hooks/queries/useDisplaySubject.ts.
  const {
    ready: permsReady,
    subjectRole,
    subjectProfile,
    subjectPermissionsByModule: subjectPermissions,
    // True only while previewing somebody else. A personal card order belongs to
    // the signed-in account, and while previewing we can neither read the viewed
    // employee's order (RLS answers with no rows, correctly) nor apply our own to
    // their screen without lying about it — so the preview shows the canonical
    // order and offers no Edit order at all. What View As is for is WHICH cards
    // they see, and that is unchanged.
    viewMode,
  } = useDisplaySubject()

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

  // ── THIS PERSON'S CARD ORDER ────────────────────────────────────────────────
  //
  // Keyed by the SIGNED-IN user and read from public.user_module_order, whose RLS
  // answers for exactly one account. null = they have never saved one, which is
  // the ordinary case and means the canonical order below.
  //
  // IT SORTS; IT NEVER ADMITS. The array further down is built by canOpenModule
  // first and this list is applied to the result, so a stored key naming a module
  // this person may not open selects no card. See src/lib/modules/moduleOrder.ts.
  const { data: savedOrder = null, isLoading: orderLoading } = useModuleOrder(userId)
  const cacheModuleOrder = useModuleOrderCache()
  const [orderEdit, dispatchOrderEdit] = useReducer(
    moduleOrderEditReducer,
    IDLE_MODULE_ORDER_EDIT,
  )
  const { toast, show: showToast, dismiss: dismissToast } = useToast()

  useEffect(() => {
    if (permsReady && userId === null) router.push('/login')
  }, [permsReady, userId, router])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  // In View Mode use the viewed user's profile for card visibility; fall back to actual profile.
  // The subject's own profile — the viewed employee while previewing, the
  // signed-in user otherwise. Used by the app_modules visibility rule, which is
  // profile-shaped rather than permission-shaped.
  const effectiveProfile = subjectProfile

  // THE PARENT GATE. `view` on the module, or admin. Nothing else opens a
  // module: a leftover `dispatch` or `manage` grant with view = false is a
  // dormant permission, not an entry ticket.
  //
  // ASKED OF THE DISPLAY SUBJECT, which outside View As is the signed-in user
  // and is unchanged. While previewing it is the viewed employee, so the card
  // grid is the one THEY would see — an admin's Finance card must not appear on
  // a screen labelled "Viewing as Dhruv" when Dhruv has no Finance. This is a
  // DISPLAY decision; entering any of these routes is still authorized against
  // the real caller by that route's own guard and by RLS.
  const canOpenModule = (moduleKey: string): boolean =>
    canAccessManagementModule({
      role: subjectRole,
      moduleKey,
      // The resolver returns no rows at all for an inactive or unregistered
      // module, so the `view` test inside fails on its own.
      isModuleActive: true,
      permissions: subjectPermissions.get(moduleKey) ?? [],
    })

  // THE ONE MODULE canOpenModule CANNOT ANSWER FOR.
  //
  // Review Workflow Test registers `use` and `verify` and no `view` at all
  // (src/lib/permissions/modules.ts), because it has no read-only audience — a
  // holder sees the unbooked pool and their own tests and nobody else's.
  // canAccessManagementModule asks strictly for `view`, and asking it here
  // would hide the card from every single person who actually holds the module.
  //
  // This is NOT a weaker gate. It reads the same resolver output, for the same
  // signed-in user, through the module's own capability derivation — the same
  // function src/app/customer-reviews/layout.tsx branches on — so the card and
  // the route still cannot disagree.
  const canOpenCustomerReviews =
    permsReady &&
    deriveCustomerReviewCapabilities(
      subjectRole,
      subjectPermissions.get('customer_review_requests') ?? [],
    ).canAccessModule

  // ── QUICK ADD EXPENSE ──
  //
  // The launcher is where somebody lands after signing in on a phone, so it is
  // where the one action that has to be instant belongs: recording an expense
  // they have just paid for, without opening Finance and finding a list first.
  //
  // GATED ON THE SAME TWO FACTS THE ROUTE AND THE DATABASE USE — Finance entry
  // and finance.create — through deriveFinanceCapabilities, the module's own
  // derivation. Somebody who may open Finance but may not record anything is not
  // offered a form that would be refused, and somebody without Finance sees
  // neither this nor the Finance card. It grants nothing: ModuleGuard decides
  // the route and RLS decides the write.
  const financeCaps = deriveFinanceCapabilities(
    subjectRole,
    subjectPermissions.get('finance') ?? [],
  )
  const canQuickAddExpense = permsReady && financeCaps.canCreatePaymentRecord

  // Attendance request is for the SIGNED-IN person's own request, so it reads the
  // real profile, not the display subject, and is off while previewing somebody
  // else (a request sent then would be the admin's, not the viewed employee's).
  // It is not module access — see QuickActionGates.
  //
  // AND ONLY FOR SOMEBODY WHOSE ATTENDANCE IS TRACKED. `users.payroll_active` is
  // the one switch for "takes part in Attendance & Payroll" (see
  // src/lib/payroll/participation.ts); a member switched out of it — an owner,
  // a non-salaried account — has no attendance for a request to excuse, so the
  // button is not offered. The request route itself is unchanged.
  //
  // READ HERE, NOT FROM `profile`. The shared profile (usePermissionContext)
  // selects a fixed column list without payroll_active, so the field was
  // always missing there and a missing value means "included" — the button
  // never went away. This is one primary-key read of the signed-in row, which
  // `authenticated` may select (20260813000000). Until it lands the button is
  // held back rather than flashed; if it fails the button is offered, as it was
  // before this rule existed.
  const participationRead = useQuery({
    queryKey: ['payroll-participation', userId],
    enabled: !!userId && !viewMode,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('users')
        .select('payroll_active, is_deleted')
        .eq('id', userId!)
        .single()
      if (error) throw error
      return data as { payroll_active: boolean | null; is_deleted: boolean | null }
    },
    staleTime: PERMISSION_STALE_MS,
    gcTime: PERMISSION_GC_MS,
  })
  const takesPartInPayroll = participationRead.data
    ? participatesInPayroll(participationRead.data)
    : participationRead.isError
  const canRequestAttendance = !viewMode && !!userId && !!profile && profile.is_active !== false
    && takesPartInPayroll

  // PENDING APPROVALS: attendance requests waiting for a decision, decided from
  // here. Deciding is admin-only (the route checks the real caller's role), so
  // this reads the SIGNED-IN profile, never the display subject, and is off
  // while previewing somebody else. See ./PendingApprovals.tsx.
  const showPendingApprovals = !viewMode && !!userId && profile?.role === 'admin'

  // ONE LIST, BOTH PLACEMENTS. The gate above is the only authorization
  // decision; buildQuickActions turns the flags into the definitions that the
  // desktop sidebar and the small-screen page both render, so a second action
  // is an entry in QuickActions.tsx and no layout work here. An unauthorized
  // viewer gets an empty list and therefore no section in either place.
  // Exhibition Leads: the form is one tap from the first screen, on a phone and
  // in the desktop sidebar, gated by the same parent gate as its launcher card.
  //
  // AND ONLY WHILE AN EXHIBITION IS OPEN. Admin closes an exhibition from
  // Exhibition Leads → Exhibitions when the fair is over; once none is open the
  // link is gone for everybody, and re-opening one brings it back. The answer is
  // read from the exhibitions table, so it changes without a deploy. The list
  // kept on the device from the last visit answers at once; a failed read keeps
  // the link rather than taking it away (see showQuickLink).
  const canOpenExhibitionLeads = canOpenModule('exhibition_leads')
  const exhibitionsRead = useQuery({
    ...exhibitionsQuery(supabase),
    enabled: permsReady && canOpenExhibitionLeads,
    initialData: () => readCachedExhibitions()?.data,
    initialDataUpdatedAt: () => readCachedExhibitions()?.at,
  })
  const canAddExhibitionLead = canOpenExhibitionLeads
    && showQuickLink(intakeState(exhibitionsRead.data), exhibitionsRead.isError)
  const quickActions = buildQuickActions({ canQuickAddExpense, canRequestAttendance, canAddExhibitionLead })

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

  // Where the Performance card goes: the management landing for whoever holds
  // Team Performance, their own report for everyone else.
  //
  // Derived from the capability, not from `users.role`. The role version sent
  // every manager to /performance/team and therefore offered a manager no route
  // to their own report at all — one of the two ways a Manager silently lost
  // Personal Performance (the other was the View As gate on /performance). The
  // destination is unchanged for everyone who holds Team Performance today,
  // because 20261109000000 grants view_team at role level to exactly the admins
  // and managers this test used to name.
  //
  // AND THE DESTINATION IS ALWAYS THE PERSONAL REPORT. Personal Performance and
  // Team Performance are not alternatives — a manager needs both — so a card
  // that chose between them was the second half of the same defect: routing a
  // Team Performance holder to /performance/team left them with no route to
  // their own score, month, history or EOD, which is exactly what "Dhruv cannot
  // reach his own Performance" meant. Everybody lands on their own report
  // because everybody is first an individual employee, and the Team View link
  // the personal page already renders for a `view_team` holder is the way
  // across. /performance/team keeps its own "← My Report" link back.
  const performanceHref = '/performance'

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
    icon: <CalIcon />,
    // The two experiences are told apart by the description above and by where
    // the card goes, not by a pill. This is still the one card whose visibility
    // comes from app_modules, and it is unchanged by the parent-gate work.
    notificationCount: null,
  } : null

  // THE CANONICAL ORDER, and the complete answer to "what may this person open".
  //
  // Renamed from `modules` when the personal order arrived, and that is the only
  // change to it: every gate, destination, description, icon and count
  // below is exactly what it was. This array is the application's DEFAULT order
  // and the fallback for everybody who has saved nothing, so nothing sorts,
  // splices or otherwise mutates it — `visibleModuleOrder` returns a new array.
  const canonicalModules: ModuleDef[] = [
    ...(canOpenModule('task_management') ? [{
      key: 'tasks',
      title: 'Task Management',
      description: 'Create, assign, and track tasks across your team.',
      href: '/dashboard',
      icon: <TaskIcon />,
      notificationCount: taskCount.count,
    }] : []),
    // Order Management sits beside Task Management so the default Essentials
    // row reads Task, Order, Finance. Its gate, route and count are unchanged;
    // only its place in the default sequence moved.
    ...(canOpenModule('orders') ? [{
      key: 'orders',
      title: 'Order Management',
      description: 'Track confirmed orders from request through production and dispatch.',
      href: '/orders',
      icon: <OrdersIcon />,
      notificationCount: orderCount.count,
    }] : []),
    ...(canOpenModule('sample_tracking') ? [{
      key: 'samples',
      title: 'Sample Tracking',
      description: 'Request sample catalogs, track dispatch and returns, follow up on overdue items.',
      href: '/samples',
      icon: <BoxIcon />,
      notificationCount: counts.sample,
    }] : []),
    ...(attendancePayroll ? [attendancePayroll] : []),
    ...(canOpenModule('showroom_qr') ? [{
      key: 'showroom',
      title: 'Showroom QR',
      description: 'QR-based showroom inquiries and quotations.',
      href: '/showroom-admin',
      icon: <ShowroomIcon />,
      notificationCount: null,
    }] : []),
    ...(canOpenModule('assets_access') ? [{
      key: 'assets',
      title: 'Assets & Access',
      description: 'View your assigned devices and access records, or manage the company inventory.',
      href: '/assets-access',
      icon: <AssetIcon />,
      notificationCount: null,
    }] : []),
    ...(canOpenModule('employee_records') ? [{
      key: 'members',
      title: 'Employee Records',
      description: 'Add, edit and retire employee accounts — department, designation, level, status and access.',
      // Straight to where employee administration now lives. /admin/members
      // still works and redirects here; the card skips the hop.
      href: '/admin/control-center/people',
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
      icon: <PerformanceIcon />,
      notificationCount: null,
    }] : []),
    ...(canOpenModule('finance') ? [{
      key: 'finance',
      title: 'Finance',
      description: 'Payment confirmations, order advances, and finance approvals.',
      href: '/finance',
      icon: <FinanceIcon />,
      notificationCount: financeCount.count,
    }] : []),
    ...(canOpenModule('meetings') ? [{
      key: 'meetings',
      title: 'Meetings',
      description: 'Run New Order and Repair Order reviews, record SKU updates, and track follow-ups.',
      href: '/meetings',
      icon: <MeetingsIcon />,
      notificationCount: null,
    }] : []),
    ...(canOpenCustomerReviews ? [{
      key: 'customer_reviews',
      title: 'Review Workflow',
      description: 'Draft reviews for customers to use. The candidate chooses the WhatsApp recipient. Nothing is posted publicly, and BOE does not send the message automatically.',
      href: '/customer-reviews',
      icon: <ReviewOutreachIcon />,
      notificationCount: null,
    }] : []),
    ...(canOpenModule('image_editor') ? [{
      key: 'image_editor',
      title: 'Image Editor',
      // The registered module description, verbatim — permission_modules and
      // app_modules both carry this sentence, and a card that paraphrased it
      // would drift from what Control Center shows an administrator.
      description: 'Turn factory furniture photographs into catalogue studio images.',
      href: '/image-editor',
      icon: <ImageIcon size={26} strokeWidth={1.8} />,
      // A generated master is stored for its owner alone, and nothing about a
      // private seven-day history is a company-wide count worth badging.
      notificationCount: null,
    }] : []),
    ...(canOpenModule('exhibition_leads') ? [{
      key: 'exhibition_leads',
      title: 'Exhibition Leads',
      // The registered module description, verbatim.
      description: 'Capture visitors at an exhibition and follow them up afterwards.',
      href: '/exhibition-leads/add',
      icon: <ContactRound size={26} strokeWidth={1.8} />,
      notificationCount: null,
    }] : []),
    ...(canOpenModule('vendors') ? [{
      key: 'vendors',
      title: 'Vendors',
      // The registered module description, verbatim.
      description: 'Outsourcing vendor base and a log of every vendor visit, with photographs and location.',
      href: '/vendors',
      icon: <Factory size={26} strokeWidth={1.8} />,
      notificationCount: null,
    }] : []),
    ...(canOpenModule('inventory') ? [{
      key: 'inventory',
      title: 'Inventory',
      // The registered module description, verbatim.
      description: 'Furniture stock for sale: stage, condition, availability and booking requests.',
      href: '/inventory',
      icon: <Armchair size={26} strokeWidth={1.8} />,
      notificationCount: null,
    }] : []),
    // Sales, Marketing and Pricing open a Coming soon page for now. The tile is an ordinary tile: it says so
    // when opened, not with a status pill here (see the note above ModuleDef).
    ...(canOpenModule('sales') ? [{
      key: 'sales',
      title: 'Sales',
      // The registered module description, verbatim.
      description: 'Sales module. Coming soon.',
      href: '/sales',
      icon: <TrendingUp size={26} strokeWidth={1.8} />,
      notificationCount: null,
    }] : []),
    ...(canOpenModule('marketing') ? [{
      key: 'marketing',
      title: 'Marketing',
      // The registered module description, verbatim.
      description: 'Marketing module. Coming soon.',
      href: '/marketing',
      icon: <Megaphone size={26} strokeWidth={1.8} />,
      notificationCount: null,
    }] : []),
    ...(canOpenModule('pricing') ? [{
      key: 'pricing',
      title: 'Pricing',
      // The registered module description, verbatim.
      description: 'Pricing module. Coming soon.',
      href: '/pricing',
      icon: <Tag size={26} strokeWidth={1.8} />,
      notificationCount: null,
    }] : []),
    ...(effectiveProfile?.role === 'admin' ? [{
      key: 'control_center',
      title: 'Admin Control Center',
      description: 'Control modules, departments, and user department access.',
      href: '/admin/control-center',
      icon: <ControlCenterIcon />,
      notificationCount: null,
    }] : []),
  ]

  // ── The cards as THIS person arranged them ──────────────────────────────────
  //
  // A PERMUTATION OF THE ARRAY ABOVE AND NOTHING ELSE. Every entry rendered came
  // out of `canonicalModules`, so the gate above remains the only thing that
  // decides what is on screen; the saved order decides nothing but sequence, and
  // a key it names that is not up there contributes no card.
  //
  // While previewing somebody else the saved order is ignored (see `viewMode`
  // above): that screen is about which cards the viewed employee has.
  const canonicalKeys = moduleOrderKeys(canonicalModules)
  const modules = visibleModuleOrder(
    canonicalModules,
    viewMode ? null : savedOrder,
    orderEdit.working,
  )

  // ── Edit order ──────────────────────────────────────────────────────────────
  //
  // Offered to a signed-in person looking at their own launcher, and only when
  // there is more than one card to arrange.
  const canEditOrder = !viewMode && !!userId && canonicalModules.length > 1
  const editingOrder = orderEdit.working !== null

  // ── Two sections, one list ──────────────────────────────────────────────────
  //
  // Both are FILTERS OF `modules`, so each keeps the rendered order and together
  // they hold every authorized card exactly once.
  const isEssential = (key: string) => ESSENTIAL_MODULE_KEYS.includes(key)
  const essentialModules = modules.filter(mod => isEssential(mod.key))
  const moreModules = modules.filter(mod => !isEssential(mod.key))

  // EDIT ORDER ARRANGES THE WHOLE LIST, exactly as it did before the sections.
  // While arranging, every card is drawn in one grid in its stored position, so
  // any card can move to any place and every move is visible. Outside edit mode
  // the sections are filters of that same list, so the relative order set here
  // is the order each section shows.

  // ── Announcements ───────────────────────────────────────────────────────────
  //
  // The SIGNED-IN person's own, as the database decides them (named recipient,
  // live today in India). Not while previewing somebody else: acknowledging
  // there would record the admin's own read, so the preview shows neither the
  // For you panel's announcement nor the bell. Never blocks the launcher — the
  // announcement appears when the list lands.
  const showAnnouncements = !viewMode && !!userId
  const { data: myAnnouncements = [] } = useMyAnnouncements(userId, showAnnouncements)
  const showBell = showAnnouncements && !editingOrder

  // What the For you panel and its phone strip read. Every gate is the page's
  // own, passed in as data. The newest announcement is the first row of the
  // list above (my_announcements() decides access and order); the panel shows
  // it while it is unread.
  const attentionSources: AttentionSources = {
    userId,
    financeAllowed: mayOpenFinance,
    ordersAllowed: mayOpenOrders,
    showAttendance: showPendingApprovals,
    latestAnnouncement: showAnnouncements ? myAnnouncements[0] ?? null : null,
  }

  // Whether Save has anything to write: the working arrangement against what is
  // stored, resolved through the same function the grid renders with, so "no
  // change" means the same thing to the button as it does to the screen.
  const orderIsDirty =
    editingOrder &&
    !moduleOrderEquals(
      moduleOrderKeys(modules),
      moduleOrderKeys(visibleModuleOrder(canonicalModules, savedOrder, null)),
    )

  const beginPointerDrag = useModuleReorderPointer({
    enabled: editingOrder && !orderEdit.saving,
    onMoveToSlotOf: (key, targetKey) => dispatchOrderEdit({ type: 'moveToSlotOf', key, targetKey }),
    onDragStart: key => dispatchOrderEdit({ type: 'dragStart', key }),
    onDragEnd: () => dispatchOrderEdit({ type: 'dragEnd' }),
  })

  const handleSaveOrder = async () => {
    if (!userId || !orderEdit.working) return
    // The keys of the cards AS RENDERED, not the raw working list: a key whose
    // card has disappeared while edit mode was open (a permission revoked in
    // another tab) is dropped rather than stored back.
    const keys = moduleOrderKeys(modules)

    dispatchOrderEdit({ type: 'saveStart' })
    const result = await saveModuleOrder(userId, keys)

    if (!result.ok) {
      // NOTHING IS DISCARDED. Edit mode stays open on the same arrangement, the
      // message sits under the buttons, and Save is still there to press.
      dispatchOrderEdit({
        type: 'saveFailed',
        message: `Could not save your card order. ${result.message} — your arrangement is still here; try Save again.`,
      })
      return
    }

    // Written before leaving edit mode, so the grid outside it renders the order
    // that was just stored rather than briefly falling back to the old one.
    cacheModuleOrder(userId, keys)
    dispatchOrderEdit({ type: 'saveSucceeded' })
    showToast('Module order saved', 'success')
  }

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

  // Warm a module's route when the person shows intent to open it (pointer over
  // the card, keyboard focus, or the start of a touch) — NOT for every card on
  // mount. Warming all of them at load fetched the page of every other module,
  // and with each page comes its stylesheet: the browser preloaded CSS files
  // this page never applies and logged "preloaded but not used within a few
  // seconds" (Control Center, Inventory, Exhibition Leads), while the burst of
  // requests competed with the launcher's own data. Intent keeps the click fast
  // and the console clean. Only authorized destinations have a card, so an
  // unauthorized route is still never warmed.
  const warmModule = (href: string) => { router.prefetch(href) }

  // One tile. `position` is its 1-based place in the whole list; in edit mode
  // the handle announces it out of `modules.length`, as it did before the
  // sections.
  const renderCard = (
    mod: ModuleDef,
    variant: 'essential' | 'compact',
    position: number,
  ) => (
    <ModuleCard
      key={mod.key}
      mod={mod}
      variant={variant}
      // NO NAVIGATION WHILE REARRANGING. Passing null rather than a handler
      // that checks a flag: in edit mode the card is not a button, has no
      // tabIndex and has no click handler to fire, so there is nothing for a
      // stray tap at the end of a drag to trigger.
      onClick={editingOrder ? null : () => router.push(mod.href)}
      onIntent={editingOrder ? undefined : () => warmModule(mod.href)}
      dragging={orderEdit.dragging === mod.key}
      handle={editingOrder ? (
        <ModuleDragHandle
          moduleKey={mod.key}
          title={mod.title}
          position={position}
          total={modules.length}
          disabled={orderEdit.saving}
          onMove={(key, delta) => dispatchOrderEdit({ type: 'move', key, delta })}
          onPointerDown={beginPointerDrag}
        />
      ) : null}
    />
  )

  // The gate, and only the gate. app_modules is included because the
  // Attendance & Payroll card's visibility comes from it, so rendering before
  // it lands could omit a card the employee is entitled to.
  //
  // And the saved order, for the same class of reason: it does not decide WHICH
  // cards exist, but rendering before it lands would draw the launcher in
  // canonical order and then visibly reshuffle it under the cursor. It is one
  // primary-key lookup on a two-column table, issued in parallel with the two
  // above, and `isLoading` — not `isPending` — so a signed-out visitor, whose
  // query never runs, is not held here forever.
  const loading = !permsReady || modVisPending || orderLoading

  return (
    <DailyQuoteLoader>
      {loading ? <LoadingScreen /> : (
        <BoeOsLayout
          profile={profile}
          // THE PAGE NAMES ITSELF ONCE, HERE. This header used to read "BOE
          // Operating System" over today's date, and the body opened with a
          // second heading block — an eyebrow, a repeat of the page's name, a
          // supporting line and a divider. Two headers, one screen, and the
          // top one said what the sidebar was already saying.
          //
          // The product name stays in the sidebar brand, where it belongs and
          // where it still is. The date went with it: nothing on a launcher
          // depends on knowing what day it is, and it was competing with the
          // one thing this header is for.
          // The supporting line moved into the welcome panel below, where it
          // is said once, beside the headline it supports.
          title="Modules"
          onSignOut={handleSignOut}
          quickActions={quickActions}
          // ONE CONTENT COLUMN. The header and the launcher share a 1400px
          // column, centred in whatever the sidebar leaves, so the title,
          // Edit order and the tiles line up on the same two edges. Wide
          // enough for three Essentials and five compact tiles across, and
          // narrow enough that a 1920 screen keeps real margins either side.
          contentMaxWidth={1400}
          // The reorder control now travels with the heading it belongs to.
          // Unchanged in behaviour: same reducer, same handlers, same props —
          // only its position on the screen is different. The announcements
          // bell sits first in the same slot, so it is at the top of the page
          // at every width; it is hidden while arranging cards.
          headerActions={showBell || canEditOrder ? (<>{showBell && <AnnouncementBell announcements={myAnnouncements} />}
            {canEditOrder && <ModuleOrderBar
              editing={editingOrder}
              saving={orderEdit.saving}
              error={orderEdit.error}
              dirty={orderIsDirty}
              onEdit={() => dispatchOrderEdit({ type: 'open', order: moduleOrderKeys(modules) })}
              onSave={handleSaveOrder}
              onCancel={() => dispatchOrderEdit({ type: 'cancel' })}
              onReset={() => dispatchOrderEdit({ type: 'reset', canonical: canonicalKeys })}
            />}
          </>) : null}
        >
          {/* ── Quick actions, small screens only ──
              Above the Modules heading because its whole reason for existing is
              that it must be reachable in one tap from the first screen after
              sign-in. Above 767px the permanent sidebar carries this same list
              and CSS hides the copy below, so it is on screen exactly once at
              every width.

              NOT WHILE ARRANGING. In edit mode the first phone screen belongs to
              Save, Cancel and the cards being moved; the action returns the
              moment edit mode closes. */}
          {!editingOrder && <QuickActionList actions={quickActions} variant="page" />}

          {/* Narrow screens only: "N waiting on you", jumping to the For you
              panel, which falls below the tiles there. */}
          {!editingOrder && <AttentionStrip {...attentionSources} />}

          {/* The modules on the left, "For you" on the right (a new
              announcement, a PI returned to you, cash handed to you, cash not with the company,
              leave and late arrival). Beside the tiles rather than above them
              so nothing pushes the modules down; on a phone it falls below
              them. */}
          <div className={styles.launcherShell}>
          {/* ── The launcher ──
              `.launcher` is the size container every column count below is
              measured against — the width the launcher actually gets, not the
              window — and it scopes this page's typeface.

              Two parts: the Essentials row and a compact grid for everything
              else. The tiles always start at the top: the latest announcement
              is in the For you panel.

              Edit mode shows every module in one grid, as before the
              sections: each tile turns dashed and gains a handle. */}
          <div className={styles.launcher}>
            {!editingOrder && essentialModules.length > 0 && (
              <section className={styles.section} aria-labelledby="modules-essentials-heading">
                <h2 id="modules-essentials-heading" className={styles.sectionTitle}>Your essentials</h2>
                <div className={styles.essentialsGrid}>
                  {essentialModules.map((mod, index) => renderCard(mod, 'essential', index + 1))}
                </div>
              </section>
            )}

            {!editingOrder && moreModules.length > 0 && (
              <section className={styles.section} aria-labelledby="modules-more-heading">
                <h2 id="modules-more-heading" className={styles.sectionTitle}>
                  {essentialModules.length > 0 ? 'All modules' : 'Your modules'}
                </h2>
                <div className={styles.grid}>
                  {moreModules.map((mod, index) =>
                    renderCard(mod, 'compact', essentialModules.length + index + 1))}
                </div>
              </section>
            )}

            {/* ── Arranging: the whole list, as before the sections ──
                One grid, every card in its stored place, so any card can move
                to any position — the control is exactly what it was. The note
                says how the sections read the result, so nothing is silent. */}
            {editingOrder && (
              <section className={styles.section} aria-labelledby="modules-arrange-heading">
                <h2 id="modules-arrange-heading" className={styles.sectionTitle}>Arrange your modules</h2>
                {essentialModules.length > 0 && (
                  <p className={styles.arrangeNote}>
                    Task Management, Order Management and Finance stay in Your essentials. Their order
                    there, and the order of every other module, follows this list.
                  </p>
                )}
                <div className={styles.grid}>
                  {modules.map((mod, index) => renderCard(mod, 'compact', index + 1))}
                </div>
              </section>
            )}
          </div>

          {/* Not while arranging: that screen belongs to Save, Cancel and the
              cards. Every gate is the page's own, passed in as data: a null
              count means the person cannot open that module. */}
          {!editingOrder && <AttentionPanel {...attentionSources} />}
          </div>

          {/* The save confirmation. The launcher's existing toast, in the place
              every other one in the app appears. */}
          <Toast toast={toast} onDismiss={dismissToast} />
        </BoeOsLayout>
      )}
    </DailyQuoteLoader>
  )
}

// ── ModuleCard ────────────────────────────────────────────────────────────────

// THE WHOLE TILE IS THE BUTTON: one onClick, role="button", tabIndex 0, Enter
// and Space — from moduleCardPressProps, as before. Nothing inside it is a
// control of its own, so the number, the icon, the name, the arrow and the
// empty space around them all open the module.
//
// IN EDIT MODE IT IS NOT A BUTTON AT ALL. `onClick` arrives as null, and with it
// go the role, the tabIndex and the key handler; the handle becomes the tile's
// only control, and the arrow — a promise to open something — is not drawn.
//
// TWO SIZES, ONE COMPONENT. `essential` is the larger row tile of the three
// featured modules; `compact` is the smaller tile of the grid beneath. Every
// state — rest, hover, focus, pressed, editing, held — is a stylesheet rule.
function ModuleCard({ mod, variant, onClick, onIntent, dragging = false, handle = null }: {
  mod: ModuleDef
  variant: 'essential' | 'compact'
  /** null in edit mode: the card does not navigate. */
  onClick: (() => void) | null
  /** Pointer over, focus or touch start: warm the route behind this card. */
  onIntent?: () => void
  /** This card is the one currently held by a pointer. */
  dragging?: boolean
  /** The drag handle, in edit mode only. */
  handle?: React.ReactNode
}) {
  const hasNotif = (mod.notificationCount ?? 0) > 0
  const count    = mod.notificationCount
  const editing  = onClick === null

  // Whether this card is a button, and what pressing it does. Null in edit mode
  // means every one of these is undefined — no handler, no role, no tabIndex, no
  // Enter — so a drag has nothing to end in. See moduleCardPressProps.
  const press = moduleCardPressProps(onClick)

  const className = [
    styles.card,
    variant === 'essential' ? styles.cardEssential : styles.cardCompact,
    // No tinted fill for unread notifications: the badge on the icon says it.
    editing ? styles.cardEditing : '',
    dragging ? styles.cardDragging : '',
  ].filter(Boolean).join(' ')

  return (
    <div
      // What the pointer drag hit-tests against. The only thing on the card that
      // names the module, and read by nothing else.
      data-module-key={mod.key}
      {...press}
      onPointerEnter={onIntent}
      onFocus={onIntent}
      onTouchStart={onIntent}
      className={className}
    >
      {handle}

      <div className={styles.cardBody}>
        {/* ── Icon block with notification badge ──
            The badge is positioned against THIS wrapper, not the tile, so it
            stays on the icon at every width and in both tile sizes. */}
        <div className={styles.iconWrap}>
          <div className={styles.iconBox}>
            {mod.icon}
          </div>
          {hasNotif && (
            <div className={styles.badge}>
              {count! > 99 ? '99+' : count}
            </div>
          )}
        </div>

        {/* ── Name ── the only text on a tile, never clamped. */}
        <div className={styles.titleWrap}>
          <div className={styles.title}>
            {mod.title}
          </div>
        </div>

        {/* Essentials only, and decoration only: aria-hidden, no pointer
            events, and not drawn while the tile does not navigate. */}
        {variant === 'essential' && !editing && (
          <ArrowUpRight className={styles.cardArrow} aria-hidden="true" focusable="false" />
        )}

        {/* Compact tiles on a phone only (CSS shows it below 480px): the list
            row's cue that it opens something. Decoration, like the arrow. */}
        {variant === 'compact' && !editing && (
          <ChevronRight className={styles.cardChevron} aria-hidden="true" focusable="false" />
        )}
      </div>
    </div>
  )
}

// ── Icons ──
// Drawn once in src/components/modules/ModuleIcons.tsx, shared with the Control Center Access screens.
