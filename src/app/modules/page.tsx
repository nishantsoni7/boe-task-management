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
import { Image as ImageIcon } from 'lucide-react'
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

  // ONE LIST, BOTH PLACEMENTS. The gate above is the only authorization
  // decision; buildQuickActions turns the flags into the definitions that the
  // desktop sidebar and the small-screen page both render, so a second action
  // is an entry in QuickActions.tsx and no layout work here. An unauthorized
  // viewer gets an empty list and therefore no section in either place.
  const quickActions = buildQuickActions({ canQuickAddExpense })

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
    ...(canOpenModule('orders') ? [{
      key: 'orders',
      title: 'Order Management',
      description: 'Track confirmed orders from request through production and dispatch.',
      href: '/orders',
      icon: <OrdersIcon />,
      notificationCount: orderCount.count,
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

  // Warm the routes behind the cards that are actually on screen, so the click
  // does not begin with a chunk download. `modules` contains ONLY authorized
  // entries — an unauthorized destination is never in this list and so is never
  // prefetched. Runs after the gate for the same reason the counts do.
  // Read off the CANONICAL array rather than the rendered one. The set of
  // destinations is identical either way — the personal order is a permutation —
  // but the canonical array's sequence does not change while somebody drags a
  // card, so rearranging the grid no longer re-runs this effect on every move.
  const moduleHrefs = canonicalModules.map(mod => mod.href).join('|')
  useEffect(() => {
    if (!permsReady) return
    for (const href of moduleHrefs.split('|').filter(Boolean)) router.prefetch(href)
  }, [permsReady, moduleHrefs, router])

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
          title="Modules"
          subtitle="Select a module to continue"
          onSignOut={handleSignOut}
          quickActions={quickActions}
          // ONE CONTENT COLUMN. The header and the grid share a 1180px column,
          // centred in whatever the sidebar leaves, so the title, Edit order
          // and the cards line up on the same two edges instead of the cards
          // stretching across a 1920px screen. Three ~383px cards fill it.
          contentMaxWidth={1180}
          // The reorder control now travels with the heading it belongs to.
          // Unchanged in behaviour: same reducer, same handlers, same props —
          // only its position on the screen is different.
          headerActions={canEditOrder ? (
            <ModuleOrderBar
              editing={editingOrder}
              saving={orderEdit.saving}
              error={orderEdit.error}
              dirty={orderIsDirty}
              onEdit={() => dispatchOrderEdit({ type: 'open', order: moduleOrderKeys(modules) })}
              onSave={handleSaveOrder}
              onCancel={() => dispatchOrderEdit({ type: 'cancel' })}
              onReset={() => dispatchOrderEdit({ type: 'reset', canonical: canonicalKeys })}
            />
          ) : null}
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

          {/* NO SECOND HEADING HERE. The page's title, its supporting line and
              the Edit order control are all in the one header above, passed to
              BoeOsLayout. The grid is the first thing in the body, so there is
              no heading block, no divider and no reserved space left behind —
              the header's own bottom border is the only rule on the screen.

              `.launcher` is the size container the column count is measured
              against — the width the grid actually gets, not the window. Each
              module is its own card: icon above name, left-aligned on a
              desktop, centred on a phone.

              Edit mode is the same grid of the same cards, loosened: each card
              turns dashed and gains a handle in its empty top-right corner. */}
          <div className={styles.launcher}>
            <div className={styles.grid}>
              {modules.map((mod, index) => (
                <ModuleCard
                  key={mod.key}
                  mod={mod}
                  // NO NAVIGATION WHILE REARRANGING. Passing null rather than a
                  // handler that checks a flag: in edit mode the card is not a
                  // button, has no tabIndex and has no click handler to fire, so
                  // there is nothing for a stray tap at the end of a drag to
                  // trigger.
                  onClick={editingOrder ? null : () => router.push(mod.href)}
                  dragging={orderEdit.dragging === mod.key}
                  handle={editingOrder ? (
                    <ModuleDragHandle
                      moduleKey={mod.key}
                      title={mod.title}
                      position={index + 1}
                      total={modules.length}
                      disabled={orderEdit.saving}
                      onMove={(key, delta) => dispatchOrderEdit({ type: 'move', key, delta })}
                      onPointerDown={beginPointerDrag}
                    />
                  ) : null}
                />
              ))}
            </div>
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

// THE WHOLE CARD IS THE BUTTON, and in normal mode that is exactly what it still
// is: one onClick, role="button", tabIndex 0 and Enter — unchanged.
//
// IN EDIT MODE IT IS NOT A BUTTON AT ALL. `onClick` arrives as null, and with it
// go the role, the tabIndex and the Enter handler: a card being dragged is not a
// link, and the surest way to stop a drag ending in a navigation is for there to
// be no handler to fire and nothing focusable to press Enter on. The handle
// becomes the card's only control.
//
// NOTHING ON IT IS INLINE ANY MORE. The border, shadow, lift and icon tint used
// to be style attributes because each depended on the module's own accent
// colour, which forced `!important` onto the focus state and a hover flag into
// React state. Every card now shares one neutral palette, so every state —
// rest, hover, focus, pressed, editing, held — is a stylesheet rule, and
// :hover, :focus-visible and :active behave identically on every card.
function ModuleCard({ mod, onClick, dragging = false, handle = null }: {
  mod: ModuleDef
  /** null in edit mode: the card does not navigate. */
  onClick: (() => void) | null
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

  return (
    <div
      // What the pointer drag hit-tests against. The only thing on the card that
      // names the module, and read by nothing else.
      data-module-key={mod.key}
      {...press}
      className={`${styles.card}${editing ? ` ${styles.cardEditing}` : ''}${dragging ? ` ${styles.cardDragging}` : ''}`}
    >
      {handle}

      {/* ── Icon block with notification badge ──
          The badge stays positioned against THIS wrapper, not the card, so it
          rides with the icon at every width — including the phone layout, where
          the icon centres itself and takes the badge with it. */}
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

      {/* ── Name ──
          The last thing on the card. THERE IS NO ARROW: the diagonal mark that
          sat in every card's corner was thirteen copies of one faint glyph
          saying what the whole page already says. What tells somebody a card
          is the one they are about to open is its state — the fill and the ink
          icon on hover, focus and press — and that costs the name no width. */}
      <div className={styles.titleWrap}>
        <div className={styles.title}>
          {mod.title}
        </div>
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
