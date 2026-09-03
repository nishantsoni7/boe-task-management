'use client'

import React, { useEffect, useState, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, User, CalendarDays, ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { Task } from '@/lib/types'
import { isOverdue, getAssignedByDisplay, isValidUUID, taskStatusLabel } from '@/lib/ui'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { TaskDetailPanel } from '@/components/ui/TaskDetailPanel'
import { Toast, useToast } from '@/components/ui/toast'
import { useViewAs } from '@/hooks/useViewAs'
import { useProfile } from '@/hooks/queries/useProfile'
import { useActiveUsers } from '@/hooks/queries/useMyTasks'
import { useTopTasks, type TopTasksData } from '@/hooks/queries/useTopTasks'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { useRefresh } from '@/contexts/RefreshContext'

const TASK_COLUMNS = [
  'id', 'title', 'note', 'status', 'priority', 'type',
  'is_urgent', 'due_date', 'acknowledged_at',
  'created_at', 'last_update_at', 'blocker_reason',
  'waiting_on_type', 'waiting_on_user_id', 'waiting_on_text',
  'assigned_to', 'created_by', 'delegated_by', 'team',
  'task_type', 'customer_name', 'contact_number', 'company_name', 'city_project',
].join(', ')

// ── Urgency scoring — used to rank Needs Acknowledgement / Quotation Requests /
// Overdue Tasks by operational risk instead of creation time ────────────────
function daysSince(iso: string | null): number {
  if (!iso) return 0
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000))
}

function priorityWeight(priority: string | null): number {
  if (priority === 'high') return 0
  if (priority === 'medium') return 1
  return 2
}

// Tier 0 = overdue, 1 = blocked, 2 = everything else — overdue/blocked always
// outrank priority, since a stale low-priority task is a bigger risk than a
// fresh high-priority one.
function urgencyTier(task: Task): number {
  if (isOverdue(task.due_date, task.status)) return 0
  if (task.status === 'blocked') return 1
  return 2
}

function compareByUrgency(a: Task, b: Task): number {
  const tierDiff = urgencyTier(a) - urgencyTier(b)
  if (tierDiff !== 0) return tierDiff
  const waitDiff = daysSince(b.created_at) - daysSince(a.created_at) // longer-waiting first
  if (waitDiff !== 0) return waitDiff
  return priorityWeight(a.priority) - priorityWeight(b.priority)
}

// Pill colours — reused verbatim from PriorityChip/StatusChip below so the
// row-level badges match the rest of the app's badge language exactly.
const PRIORITY_PILL: Record<string, { color: string; bg: string }> = {
  high:   { color: '#991B1B', bg: '#FEF2F2' },
  medium: { color: '#92400E', bg: '#FFFBEB' },
  low:    { color: '#374151', bg: '#F3F4F6' },
}
const BLOCKED_PILL = { color: '#991B1B', bg: '#FEF2F2' }

// ── The dashboard's own data, as ONE cache entry ─────────────────────────────
//
// Task rows and the creator names derived from them are two round trips that
// cannot be parallelised — the second query's `in` list comes out of the first
// query's rows — so they are cached together. One entry means a warm reopen
// costs zero requests rather than one, and it is impossible to end up with rows
// from one fetch and names from another.
type DashboardTaskData = {
  tasks: Task[]
  assignerNames: Record<string, string>
}

// Stable empty fallbacks. An unresolved query must not hand every memo, filter
// and child component a brand-new [] / {} on each render.
const NO_TASKS: Task[] = []
const NO_ASSIGNER_NAMES: Record<string, string> = {}

export default function DashboardPage() {
  const [escalationsNowMs]   = useState(() => Date.now())
  const [selectedTask,       setSelectedTask]       = useState<Task | null>(null)
  const [escalationTasks,    setEscalationTasks]    = useState<Task[]>([])
  const [previewList,        setPreviewList]        = useState<{ title: string; items: Task[] } | null>(null)
  const [escalationPreview,  setEscalationPreview]  = useState(false)
  const [acknowledgingIds,   setAcknowledgingIds]   = useState<Set<string>>(new Set())
  const [isMobile,           setIsMobile]           = useState(false)

  const router      = useRouter()
  const supabase    = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()
  const { viewAsUserId, viewAsProfile, exitViewMode } = useViewAs()
  const { manualRefreshKey } = useRefresh()

  // ── WHO, resolved before the first render instead of one await later ───────
  //
  // This page used to open with `await supabase.auth.getSession()` inside an
  // effect, purely to learn its own user id. ModuleGuard — the layout directly
  // above this page — has already resolved that id through usePermissionContext
  // and holds it in the query cache, so asking for it here is free and, more to
  // the point, ANSWERED SYNCHRONOUSLY ON THE FIRST RENDER. That is what lets the
  // task query below be keyed and read from cache in render 1; behind an await
  // there is necessarily a render with no key, no data and therefore a spinner.
  //
  // The session check that came with it is not lost: ModuleGuard already sends a
  // caller with no session to /login and does not render this page at all.
  const { ready: permsReady, userId: signedInUserId } = usePermissionContext()

  // Unchanged semantics: `loggedInId` is the real signed-in user (profile, Top 3,
  // top-tasks invalidation), `currentUserId` is the EFFECTIVE one — the viewed
  // user under View As — and a non-UUID placeholder resolves to '' exactly as the
  // old `isValidUUID` bail-out did.
  const loggedInId      = signedInUserId ?? ''
  const effectiveUserId = viewAsUserId ?? signedInUserId
  const currentUserId   = isValidUUID(effectiveUserId) ? effectiveUserId : ''

  // ── The page's primary data ───────────────────────────────────────────────
  //
  // KEY. `['tasks', 'assigned-to', <effective uid>, 'dashboard-active']`. The
  // first three segments are the key family every task mutation in the app
  // already invalidates (tasks/[id], tasks/my, tasks/assigned-by-me, and the
  // acknowledge below), and invalidateQueries matches by PREFIX — so this entry
  // is invalidated by all of them without one mutation site changing.
  //
  // IDENTITY. The uid is in the key, so View As and the administrator address
  // separate entries and neither can render the other's rows. A genuine identity
  // change or sign-out is handled a level up, by the auth listener in
  // Providers.tsx, which clears the whole cache.
  //
  // FAIL CLOSED. Until the identity resolves the query is disabled, has no data,
  // and the loading gate below holds the screen — it never renders an empty
  // dashboard as though the answer were "you have no tasks".
  const dashboardTasksKey = useMemo(
    () => ['tasks', 'assigned-to', currentUserId, 'dashboard-active'] as const,
    [currentUserId],
  )

  const dashboardTasks = useQuery<DashboardTaskData>({
    queryKey: dashboardTasksKey,
    enabled: permsReady && isValidUUID(currentUserId),
    queryFn: async (): Promise<DashboardTaskData> => {
      const uid = currentUserId

      // ── A FAILED READ MUST REJECT, NOT RESOLVE EMPTY ────────────────────────
      //
      // supabase-js returns { data: null, error } and does not throw, so an
      // ignored `error` reads exactly like "this person has no tasks". That was
      // survivable while nothing was cached — the next mount simply tried again.
      // It is not survivable now: a resolved empty result would be STORED as the
      // answer for the full staleTime, and React Query's configured retry would
      // never engage because nothing failed.
      //
      // Rejecting gets all three properties: no empty success is cached, the one
      // configured retry runs, and a failure during a BACKGROUND refetch leaves
      // the last good rows on screen untouched.
      //
      // The error object is thrown as-is for React Query to hold; it is never
      // logged or rendered, so nothing it carries reaches the console or the UI.
      // What the user sees on a first-load failure is unchanged by this commit.
      const { data: taskData, error: tasksError } = await supabase
        .from('tasks')
        .select(TASK_COLUMNS)
        .eq('assigned_to', uid)
        .not('status', 'eq', 'completed')
        .neq('status', 'cancelled')
        .order('created_at', { ascending: false })

      if (tasksError) throw tasksError

      const rows = (taskData as unknown as Task[] | null) ?? NO_TASKS

      // Creator names for tasks somebody else delegated. Still skipped entirely
      // when there are none — a self-only list needs no lookup and issues no
      // request — and still the same two-column projection.
      const creatorIds = [...new Set(
        rows.filter(t => t.created_by !== uid).map(t => t.created_by)
      )]
      if (creatorIds.length === 0) return { tasks: rows, assignerNames: NO_ASSIGNER_NAMES }

      const { data: creators, error: creatorsError } = await supabase
        .from('users')
        .select('id, full_name')
        .in('id', creatorIds)

      // Same rule for the dependent half. Caching rows whose "Delegated by"
      // names are missing would store a half-answer as though it were the whole
      // one, and hold it for the staleTime; the two are one cache entry
      // precisely so they cannot disagree.
      if (creatorsError) throw creatorsError

      const assignerNames: Record<string, string> = {}
      for (const u of (creators ?? []) as { id: string; full_name: string }[]) {
        assignerNames[u.id] = u.full_name
      }
      return { tasks: rows, assignerNames }
    },
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  })

  const tasks         = dashboardTasks.data?.tasks         ?? NO_TASKS
  const assignerNames = dashboardTasks.data?.assignerNames ?? NO_ASSIGNER_NAMES

  // ── Cached queries ────────────────────────────────────────────────────────
  const { data: profile = null } = useProfile(loggedInId)
  // Active users cached across pages — admin/manager roles need this for team view
  const { data: activeUsers = [] } = useActiveUsers()
  const teamUsers = activeUsers
  const { data: top3Data } = useTopTasks(loggedInId || null)
  const top3Tasks = top3Data?.tasks ?? []
  const [reorderingFocus, setReorderingFocus] = useState(false)
  const { toast, show: showToast, dismiss: dismissToast } = useToast()

  // ── REORDERING THE TOP 3, ON THE STORAGE THAT ALREADY EXISTS ───────────────
  //
  // user_top_tasks already carries display_order, and useTopTasks already reads
  // in that order — so a swap is two integers changing places, not a new
  // concept. No migration, no second store, no localStorage.
  //
  // WHY DELETE-THEN-INSERT AND NOT UPDATE. The table's row-level security grants
  // SELECT, INSERT and DELETE to the owner and nothing else; its only ALL-command
  // policy is RESTRICTIVE (the task_management module gate), and a restrictive
  // policy narrows access, it never grants it. There is therefore no permissive
  // UPDATE policy and an UPDATE is refused. Both verbs used here are the ones
  // the pin and unpin buttons on /tasks/my have always used, under the same
  // owner check — so this widens nobody's authority: a person can reorder their
  // own focus list and no one else's.
  //
  // It writes ONLY display_order values that already existed, swapped between
  // two rows, so the set of pinned tasks is identical before and after. Nothing
  // touches the tasks table, which is what keeps this out of task activity
  // history and out of the notification path.
  const handleReorderFocus = async (index: number, direction: -1 | 1) => {
    const target = index + direction
    // View As is read-only, and the pins on screen belong to the real signed-in
    // user in any case — the same rule handlePin follows on /tasks/my.
    if (!loggedInId || viewAsUserId || reorderingFocus) return
    if (index < 0 || target < 0 || index >= top3Tasks.length || target >= top3Tasks.length) return

    const moved = top3Tasks[index]
    const other = top3Tasks[target]
    if (!moved || !other) return

    setReorderingFocus(true)
    const queryKey = ['top-tasks', loggedInId]
    const previous = queryClient.getQueryData<TopTasksData>(queryKey)

    const nextTasks = [...top3Tasks]
    nextTasks[index] = other
    nextTasks[target] = moved

    // Immediate feedback: the cards swap and renumber before the round trip.
    queryClient.setQueryData<TopTasksData>(queryKey, current =>
      current ? { ...current, tasks: nextTasks } : current)

    const fail = (message: string) => {
      if (previous) queryClient.setQueryData(queryKey, previous)
      queryClient.invalidateQueries({ queryKey })
      showToast(message, 'error')
      setReorderingFocus(false)
    }

    try {
      const { data: pins, error: readError } = await supabase
        .from('user_top_tasks')
        .select('task_id, display_order')
        .eq('user_id', loggedInId)
        .order('display_order', { ascending: true })

      if (readError || !pins) { fail('Could not reorder focus tasks'); return }
      const rows = pins as { task_id: string; display_order: number }[]

      // The sequence to store: the cards as they now read, then any pin whose
      // task the dashboard filters out (submitted for approval, say), kept
      // behind them in the order it already had.
      const visible = nextTasks.map(t => t.id)
      const hidden  = rows.map(r => r.task_id).filter(id => !visible.includes(id))
      const desired = [...visible, ...hidden]

      // WHY THIS RENUMBERS 1..N INSTEAD OF TRADING TWO VALUES. Pinning numbers a
      // row from the count of pins, so an unpin followed by a re-pin can hand
      // out a number that is already taken — live data really does contain two
      // rows sharing a display_order, and equal numbers carry no order at all.
      // Writing a clean sequence is what makes the three positions unique, and
      // it repairs such a collision the first time someone reorders.
      //
      // Only rows whose number actually changes are rewritten, and the set of
      // pinned task_ids is identical before and after: no pin is created or
      // dropped here.
      const currentOrder = new Map(rows.map(r => [r.task_id, r.display_order]))
      const changed = desired
        .map((id, i) => ({ task_id: id, display_order: i + 1 }))
        .filter(r => currentOrder.get(r.task_id) !== r.display_order)

      if (changed.length === 0) { setReorderingFocus(false); return }

      const { error: deleteError } = await supabase
        .from('user_top_tasks')
        .delete()
        .eq('user_id', loggedInId)
        .in('task_id', changed.map(r => r.task_id))

      // Nothing has been removed yet, so the stored order is still the old one.
      if (deleteError) { fail('Could not reorder focus tasks'); return }

      const { error: insertError } = await supabase
        .from('user_top_tasks')
        .insert(changed.map(r => ({
          user_id: loggedInId, task_id: r.task_id, display_order: r.display_order,
        })))

      if (insertError) {
        // Those rows are gone and the new ones did not land. Put the originals
        // back, so a failed reorder never costs the user a focus task.
        await supabase
          .from('user_top_tasks')
          .insert(changed.map(r => ({
            user_id: loggedInId,
            task_id: r.task_id,
            display_order: currentOrder.get(r.task_id) ?? 1,
          })))
        fail('Could not reorder focus tasks')
        return
      }

      // Re-read rather than trust the optimistic swap, so the cards can never
      // sit on an order the database does not hold.
      queryClient.invalidateQueries({ queryKey })
      setReorderingFocus(false)
    } catch {
      fail('Could not reorder focus tasks')
    }
  }

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // ── EXPLICIT MANUAL REFRESH ONLY. NOT TAB VISIBILITY. ──────────────────────
  //
  // `manualRefreshKey` is bumped by the header Refresh button and by nothing
  // else. The undifferentiated `refreshKey` is deliberately NOT read here: it is
  // also bumped by DashboardLayout's visibilitychange handler, so subscribing to
  // it would refetch this list every time the user glanced at another tab and
  // came back — automatic focus refresh, which this screen does not have and
  // must not acquire. Returning to a tab is not a request for anything.
  //
  // The ref is seeded with the CURRENT key, so the effect's mandatory first run
  // — on mount — finds no change and returns. Without it, every mount would
  // fire a second task query on top of the one useQuery just made.
  //
  // refetch() ignores staleTime (a press must be a real refresh), keeps the
  // existing rows on screen while it runs, and is deduplicated by React Query if
  // several presses land together.
  const refetchDashboardTasks = dashboardTasks.refetch
  const lastManualRefreshKey = useRef(manualRefreshKey)
  useEffect(() => {
    if (lastManualRefreshKey.current === manualRefreshKey) return
    lastManualRefreshKey.current = manualRefreshKey
    void refetchDashboardTasks()
  }, [manualRefreshKey, refetchDashboardTasks])

  // Warm the two routes this page leads to most often. These ran at the end of
  // the old load effect; with the load now frequently instant there is nothing
  // left to run "after", so they run on mount. Same two routes, unchanged.
  useEffect(() => {
    router.prefetch('/tasks/my')
    router.prefetch('/notifications')
  }, [router])

  // ── Escalations: fetched only when the drawer is actually opened ────────────
  //
  // This is the heaviest query on the page — every non-completed task in the
  // company, all 24 columns, no limit — and it used to run during the initial
  // load of every admin's dashboard, blocking the whole screen, to populate a
  // drawer that is closed when the page arrives. It now runs when, and only
  // when, escalationPreview turns true. What the drawer shows once opened is
  // unchanged.
  useEffect(() => {
    if (!escalationPreview) return
    // Same admin condition the init effect applied, and the same one
    // adminEscalations re-applies before rendering anything.
    if ((viewAsProfile ?? profile)?.role !== 'admin') return
    // Already loaded for this session — the drawer reopens without refetching.
    if (escalationTasks.length > 0) return

    let active = true
    supabase
      .from('tasks')
      .select(TASK_COLUMNS)
      .not('status', 'eq', 'completed')
      .then(({ data: eTasks }: { data: unknown[] | null }) => {
        if (active && eTasks) setEscalationTasks(eTasks as unknown as Task[])
      })
    return () => { active = false }
  }, [escalationPreview, profile, viewAsProfile, escalationTasks.length, supabase])

  // Guard view-as against non-admins
  useEffect(() => {
    if (viewAsUserId && profile && profile.role !== 'admin') {
      exitViewMode()
      router.push('/dashboard')
    }
  }, [viewAsUserId, profile]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const handleAcknowledge = async (task: Task) => {
    if (task.assigned_to !== currentUserId) return
    if (task.created_by === currentUserId) return
    if (acknowledgingIds.has(task.id)) return
    setAcknowledgingIds(prev => new Set(prev).add(task.id))
    const now = new Date().toISOString()
    const oldStatus = task.status
    const { error } = await supabase.from('tasks').update({ acknowledged_at: now, status: 'working', last_update_at: now }).eq('id', task.id)
    if (error) {
      alert('Failed to acknowledge task. Please try again.')
      setAcknowledgingIds(prev => { const next = new Set(prev); next.delete(task.id); return next })
      return
    }
    await supabase.from('task_activity_log').insert([
      { task_id: task.id, actor_id: currentUserId, action: 'acknowledged', note: null },
      { task_id: task.id, actor_id: currentUserId, action: 'status_changed', from_status: oldStatus, to_status: 'working', note: null },
    ])
    if (task.created_by && task.created_by !== currentUserId) {
      fetch('/api/notify-status-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id, taskTitle: task.title, createdBy: task.created_by, action: 'acknowledged', actorName: profile?.full_name }),
      }).then(res => {
        if (!res.ok) res.json().then(d => console.error('[dashboard/acknowledge] notification failed:', d))
      }).catch(err => console.error('[dashboard/acknowledge] notification fetch error:', err))
    }
    const patch = { acknowledged_at: now, status: 'working' as const, last_update_at: now }
    setSelectedTask(prev => prev && prev.id === task.id ? { ...prev, ...patch } : prev)
    // Write through to the cache entry the page now reads from. Nothing is
    // rolled back on failure because nothing is written before success — the
    // error branch above returns before reaching here, exactly as it did when
    // this was a setTasks call. The whole {tasks, assignerNames} shape is
    // preserved and only the acknowledged row is replaced.
    queryClient.setQueryData<DashboardTaskData>(dashboardTasksKey, prev =>
      prev
        ? { ...prev, tasks: prev.tasks.map(t => t.id === task.id ? { ...t, ...patch } : t) }
        : prev
    )
    setAcknowledgingIds(prev => { const next = new Set(prev); next.delete(task.id); return next })
    queryClient.invalidateQueries({ queryKey: ['tasks', 'assigned-to', currentUserId] })
    queryClient.invalidateQueries({ queryKey: ['top-tasks', loggedInId] })
  }

  const userMap = useMemo(
    () => Object.fromEntries(teamUsers.map(u => [u.id, u.full_name])),
    [teamUsers]
  )

  const now = new Date()

  const unacknowledgedForMe = tasks
    .filter(t => !t.acknowledged_at && t.created_by !== currentUserId && t.task_type !== 'quotation_request')
    .sort(compareByUrgency)
  const quotationTasks = tasks.filter(t => t.task_type === 'quotation_request').sort(compareByUrgency)
  const mergedUserMap   = { ...assignerNames, ...userMap }

  const adminEscalations = useMemo(() => {
    if ((viewAsProfile ?? profile)?.role !== 'admin') return []
    const result: { task: Task; owner: string; days: number; reason: string }[] = []
    // Day-granularity thresholds (>5/>7 days) — a mount-frozen snapshot is
    // indistinguishable from live and keeps this memo from recomputing every render.
    const nowMs = escalationsNowMs
    const ms = 24 * 60 * 60 * 1000
    for (const t of escalationTasks) {
      const ref  = new Date(t.last_update_at ?? t.created_at)
      const days = Math.floor((nowMs - ref.getTime()) / ms)
      const owner = userMap[t.assigned_to] ?? t.assigned_to.slice(0, 8)
      if (t.status === 'blocked' && days > 5) {
        result.push({ task: t, owner, days, reason: 'Blocked' })
      } else if (t.status === 'waiting' && days > 5) {
        result.push({ task: t, owner, days, reason: 'Waiting' })
      } else if (['working', 'pending', 'started'].includes(t.status) && days > 7) {
        result.push({ task: t, owner, days, reason: 'Stale' })
      }
    }
    result.sort((a, b) => b.days - a.days)
    return result
  }, [escalationTasks, userMap, profile, viewAsProfile, escalationsNowMs])

  useEffect(() => {
    const syncSelectedTask = () => {
      if (!selectedTask) return
      const inTasks = tasks.find(t => t.id === selectedTask.id)
      if (inTasks) {
        if (inTasks !== selectedTask) setSelectedTask(inTasks)
        return
      }
      const inEscalations = escalationTasks.find(t => t.id === selectedTask.id)
      if (!inEscalations) setSelectedTask(null)
    }
    syncSelectedTask()
  }, [tasks, escalationTasks, selectedTask])

  // THE LOADING GATE, AND WHAT IT DELIBERATELY NO LONGER COVERS.
  //
  // `isPending` is true only while there is NO data for this key — a genuinely
  // first load. It is false during every background refetch, stale revalidation,
  // manual refresh and focus refresh, so valid rows are never replaced by a
  // spinner and a warm reopen paints real content on its first render.
  //
  // The uid test keeps the two "no answer yet" cases apart. Unresolved identity
  // holds the screen (fail closed). A resolved but non-UUID placeholder id
  // disables the query for good, and renders the dashboard empty — which is what
  // the old `if (!isValidUUID(uid)) { setLoading(false); return }` did.
  const loading = !permsReady || (isValidUUID(currentUserId) && dashboardTasks.isPending)
  if (loading) return <LoadingScreen />

  const overdueTasks   = tasks.filter(t => isOverdue(t.due_date, t.status)).sort(compareByUrgency)
  const waitingTasks   = tasks.filter(t => t.status === 'waiting')
  const isAdmin        = (viewAsProfile ?? profile)?.role === 'admin'

  const todayStart     = new Date(now); todayStart.setHours(0, 0, 0, 0)
  const dueTodayTasks  = tasks.filter(t => {
    if (!t.due_date) return false
    const d = new Date(t.due_date); d.setHours(0, 0, 0, 0)
    return d.getTime() === todayStart.getTime()
  })

  return (
    <>
      <DashboardLayout
        profile={profile}
        title="Dashboard"
        subtitle={new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
        onSignOut={handleLogout}
      >
        {/* ── Today's Focus — full-width hero panel ── */}
        <TodaysFocusPanel
          tasks={top3Tasks}
          onSelectTask={setSelectedTask}
          isMobile={isMobile}
          onGoToMyTasks={() => router.push('/tasks/my')}
          userMap={mergedUserMap}
          canReorder={!viewAsUserId}
          reordering={reorderingFocus}
          onReorder={handleReorderFocus}
        />

        {/* ── Needs Your Attention ── */}
        <section style={{ marginBottom: isMobile ? '18px' : '22px' }}>
          <SectionHeading title="Needs Your Attention" isMobile={isMobile} />
          {/* align-items: start is what lets an empty acknowledgement card stay
              short instead of stretching to the quotation card's height. */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',
            gap: isMobile ? '10px' : '12px',
            alignItems: 'start',
          }}>
            <UnacknowledgedPanel
              tasks={unacknowledgedForMe}
              userMap={mergedUserMap}
              now={now}
              isMobile={isMobile}
              currentUserId={currentUserId}
              acknowledgingIds={acknowledgingIds}
              onAcknowledge={handleAcknowledge}
              onPreview={task => setSelectedTask(task)}
              onViewAll={() => setPreviewList({ title: 'Unacknowledged Tasks', items: unacknowledgedForMe })}
            />
            {isAdmin ? (
              <QuotationPanel
                tasks={quotationTasks}
                userMap={mergedUserMap}
                isMobile={isMobile}
                onOpen={task => router.push(`/tasks/${task.id}`)}
                onViewAll={() => router.push('/tasks/quotation-requests')}
              />
            ) : (
              <OverdueTasksPanel
                tasks={overdueTasks}
                userMap={mergedUserMap}
                now={now}
                isMobile={isMobile}
                onSelectTask={task => setSelectedTask(task)}
                onViewAll={() => setPreviewList({ title: 'Overdue Tasks', items: overdueTasks })}
              />
            )}
          </div>
        </section>

        {/* ── Operational counters ── */}
        <OperationalStatusPanel
          overdueTasks={overdueTasks}
          waitingTasks={waitingTasks}
          dueTodayTasks={dueTodayTasks}
          onShowList={setPreviewList}
          isMobile={isMobile}
        />
      </DashboardLayout>

      {previewList && !selectedTask && (
        <TaskListDrawer
          title={previewList.title}
          items={previewList.items}
          isMobile={isMobile}
          userMap={mergedUserMap}
          onClose={() => setPreviewList(null)}
          onSelectTask={task => { setPreviewList(null); setSelectedTask(task) }}
        />
      )}

      {escalationPreview && !selectedTask && (
        <EscalationListDrawer
          items={adminEscalations}
          isMobile={isMobile}
          onClose={() => setEscalationPreview(false)}
          onSelectTask={task => { setEscalationPreview(false); setSelectedTask(task) }}
        />
      )}

      <Toast toast={toast} onDismiss={dismissToast} />

      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          userMap={userMap}
          onClose={() => setSelectedTask(null)}
          onOpenFullPage={() => { setSelectedTask(null); router.push(`/tasks/${selectedTask.id}`) }}
          currentUserId={currentUserId}
          onAcknowledge={
            !viewAsUserId &&
            !selectedTask.acknowledged_at &&
            selectedTask.assigned_to === currentUserId &&
            selectedTask.created_by !== currentUserId &&
            selectedTask.status !== 'completed'
              ? () => handleAcknowledge(selectedTask)
              : undefined
          }
        />
      )}
    </>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ChevronRightIcon({ color = '#9CA3AF' }: { color?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.35, flexShrink: 0 }}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

// ── Shared row metadata line — priority/waiting/blocked render as compact
// pills (reusing the exact StatusChip/PriorityChip colour tokens below),
// due-date and ownership render as plain text joined by "·". Reused by both
// Needs Acknowledgement and Quotation Requests rows so the two widgets speak
// the same visual language ── ────────────────────────────────────────────

type MetaSegment = { text: string; color: string; bg?: string; pill?: boolean; icon?: React.ReactNode }

// `gap` defaults to the original 6px spacing (Quotation Requests rows rely on
// this default and pass no icons, so their output is unchanged). Needs
// Acknowledgement rows pass a wider gap + per-segment icons instead of the
// "·" separator — a "·" is only ever shown between two plain segments that
// neither carry an icon, so icon-bearing rows never render one.
function MetaLine({ segments, gap = '6px' }: { segments: MetaSegment[]; gap?: string }) {
  if (segments.length === 0) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: gap, rowGap: '3px', fontSize: '12px', fontWeight: 400, color: '#6B7280', lineHeight: 1.4 }}>
      {segments.map((seg, i) => {
        const needsDot = !seg.pill && !seg.icon && i > 0 && !segments[i - 1].pill && !segments[i - 1].icon
        return seg.pill ? (
          <span key={i} style={{
            display: 'inline-flex', alignItems: 'center',
            fontSize: '11px', fontWeight: 500, color: seg.color,
            background: seg.bg ?? '#F3F4F6',
            borderRadius: '5px', padding: '1.5px 6px', lineHeight: 1.5,
          }}>
            {seg.text}
          </span>
        ) : (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            {needsDot && <span style={{ color: '#D1D5DB' }}>·</span>}
            {seg.icon}
            <span style={{ color: seg.color }}>{seg.text}</span>
          </span>
        )
      })}
    </div>
  )
}

// ── Section heading ───────────────────────────────────────────────────────────
// ONE heading treatment for every dashboard band. The page itself is the
// background: a section is a heading plus its cards, never a tinted card that
// holds more cards. That is what keeps "Top 3 Focus" and "Needs Your Attention"
// reading as the same level of thing.
function SectionHeading({
  title, hint, actionLabel, onAction, isMobile,
}: {
  title: string
  hint?: string
  actionLabel?: string
  onAction?: () => void
  isMobile: boolean
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
      gap: '12px', marginBottom: '10px',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', minWidth: 0 }}>
        <h2 style={{
          margin: 0,
          fontSize: isMobile ? '15px' : '16px',
          fontWeight: 700, color: '#111318',
          letterSpacing: '-0.015em', lineHeight: 1.2,
        }}>
          {title}
        </h2>
        {/* The hint is the first thing to go when the line is short — it is
            context, never the heading itself. */}
        {hint && !isMobile && (
          <span style={{ fontSize: '12px', color: '#9CA3AF', whiteSpace: 'nowrap' }}>
            {hint}
          </span>
        )}
      </div>
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          style={{
            fontSize: '12px', fontWeight: 500, color: '#6B7280',
            background: 'transparent', border: 'none', padding: '2px 0',
            cursor: 'pointer', whiteSpace: 'nowrap', transition: 'color 0.12s',
            flexShrink: 0,
          }}
          onMouseEnter={e => { e.currentTarget.style.color = '#111318' }}
          onMouseLeave={e => { e.currentTarget.style.color = '#6B7280' }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  )
}

// ── Focus reorder control ────────────────────────────────────────────────────
// Two small chevrons at the foot of a focus card, and deliberately nothing more:
// the card's job is the task, and this has to stay quieter than the title, the
// due date and the chips. Left/right while the cards sit in a row, up/down once
// they stack, because that is the direction the card actually travels.
//
// The card itself is a button that opens the task, so every handler here stops
// the event: a click on a chevron must never also open the detail panel.
function FocusReorderButton({
  label, icon, disabled, size, onActivate,
}: {
  label: string
  icon: React.ReactNode
  disabled: boolean
  /** Bigger on a touch screen, where 24px is a small thing to hit. */
  size: number
  onActivate: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={e => { e.stopPropagation(); onActivate() }}
      onKeyDown={e => { e.stopPropagation() }}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: size + 'px', height: size + 'px', borderRadius: '6px',
        border: 'none', background: 'transparent',
        color: disabled ? '#DDE1E9' : '#B0BAC8',
        cursor: disabled ? 'default' : 'pointer',
        padding: 0, flexShrink: 0,
        transition: 'background 0.12s, color 0.12s',
      }}
      onMouseEnter={e => {
        if (disabled) return
        e.currentTarget.style.background = '#F1F2F5'
        e.currentTarget.style.color = '#6B7280'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.color = disabled ? '#DDE1E9' : '#B0BAC8'
      }}
    >
      {icon}
    </button>
  )
}

// ── Focus rank badge ─────────────────────────────────────────────────────────
// The 1/2/3 ranking, given room to breathe instead of a circled glyph wedged
// into the title's top-right corner.
function RankBadge({ index, muted = false }: { index: number; muted?: boolean }) {
  return (
    <span style={{
      display: 'inline-block', flexShrink: 0,
      width: '20px', height: '20px', borderRadius: '6px',
      background: muted ? '#F4F5F7' : '#F1F2F5',
      color: muted ? '#C4C9D4' : '#8C94A6',
      fontSize: '11px', fontWeight: 600,
      lineHeight: '20px', textAlign: 'center',
      marginTop: '1px',
    }}>
      {index + 1}
    </span>
  )
}

// ── Today's Focus panel ───────────────────────────────────────────────────────

function TodaysFocusPanel({
  tasks,
  onSelectTask,
  isMobile,
  onGoToMyTasks,
  userMap,
  canReorder,
  reordering,
  onReorder,
}: {
  tasks: Task[]
  onSelectTask: (task: Task) => void
  isMobile: boolean
  onGoToMyTasks: () => void
  userMap: Record<string, string>
  canReorder: boolean
  reordering: boolean
  onReorder: (index: number, direction: -1 | 1) => void
}) {
  return (
    <section style={{ marginBottom: isMobile ? '18px' : '22px' }}>
      <SectionHeading
        title="Top 3 Focus"
        hint={tasks.length === 0
          ? 'Pin up to three tasks to keep in focus.'
          : `${tasks.length} of 3 slots active`}
        actionLabel="My Tasks →"
        onAction={onGoToMyTasks}
        isMobile={isMobile}
      />

      {/* Three equal columns, three equal-height cards. The grid stretches its
          items by default, so a short task and a long one still line up. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)',
        gap: isMobile ? '10px' : '12px',
      }}>
        {[0, 1, 2].map(idx => {
          const task = tasks[idx]

          /* ── Empty slot ── */
          if (!task) {
            return (
              <div
                key={`empty-${idx}`}
                onClick={onGoToMyTasks}
                role="button"
                tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && onGoToMyTasks()}
                style={{
                  background: '#FBFBFC',
                  border: '1px dashed #DDE1E9',
                  borderRadius: '12px',
                  padding: isMobile ? '13px 14px' : '14px 16px',
                  display: 'flex', flexDirection: 'column', gap: '5px',
                  minHeight: isMobile ? 'auto' : '116px',
                  cursor: 'pointer',
                  transition: 'background 0.15s, border-color 0.15s',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = '#F7F8FA'
                  e.currentTarget.style.borderColor = '#C9CFDA'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = '#FBFBFC'
                  e.currentTarget.style.borderColor = '#DDE1E9'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '9px' }}>
                  <RankBadge index={idx} muted />
                  <div style={{ fontSize: '13px', fontWeight: 500, color: '#A8B2BF', lineHeight: 1.35 }}>
                    Focus slot available
                  </div>
                </div>
                <div style={{ fontSize: '12px', color: '#C4C9D4', lineHeight: 1.35, marginLeft: '29px' }}>
                  Open My Tasks to add one.
                </div>
              </div>
            )
          }

          /* ── Filled slot ── */
          const dueDate = task.due_date ? new Date(task.due_date) : null
          const dueDateStr = dueDate
            ? dueDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
            : null
          const priorityLabel = task.priority
            ? task.priority.charAt(0).toUpperCase() + task.priority.slice(1)
            : null
          const priorityLower = task.priority?.toLowerCase() ?? ''
          const statusLabel = task.status ? taskStatusLabel(task.status) : null
          const assignerDisplay = getAssignedByDisplay(task, userMap)
          const isSelf = assignerDisplay === 'Self'

          // Subtle priority colour — text only, no background change
          const priorityColor = priorityLower === 'high'
            ? '#C0432B'
            : priorityLower === 'medium'
              ? '#92700A'
              : '#7B8494'

          const chipStyle: React.CSSProperties = {
            fontSize: '10.5px',
            background: '#F8F9FB',
            border: '1px solid #E6E8EC',
            borderRadius: '999px',
            padding: '1.5px 8px',
            lineHeight: 1.5,
            fontWeight: 500,
            whiteSpace: 'nowrap',
          }

          return (
            <div
              key={task.id}
              onClick={() => onSelectTask(task)}
              role="button"
              tabIndex={0}
              onKeyDown={e => e.key === 'Enter' && onSelectTask(task)}
              style={{
                background: '#ffffff',
                border: '1px solid #E7E9EE',
                borderRadius: '12px',
                padding: isMobile ? '13px 14px' : '14px 16px',
                display: 'flex', flexDirection: 'column', gap: '10px',
                minHeight: isMobile ? 'auto' : '116px',
                cursor: 'pointer',
                transition: 'background 0.15s, border-color 0.15s',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = '#FCFCFD'
                e.currentTarget.style.borderColor = '#C9CFDA'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = '#ffffff'
                e.currentTarget.style.borderColor = '#E7E9EE'
              }}
            >
              {/* Rank, title and where the task came from */}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '9px' }}>
                <RankBadge index={idx} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: isMobile ? '13.5px' : '14px',
                    fontWeight: 600,
                    color: '#111318',
                    lineHeight: 1.35,
                    letterSpacing: '-0.01em',
                  }}>
                    {task.title}
                  </div>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: '5px',
                    marginTop: '5px', fontSize: '12px', color: '#8A94A6', lineHeight: 1.3,
                  }}>
                    <User size={12} strokeWidth={2} color="#B0BAC8" style={{ flexShrink: 0 }} />
                    {isSelf
                      ? 'Self Task'
                      : <span>Delegated by <span style={{ color: '#6B7280', fontWeight: 500 }}>{assignerDisplay}</span></span>
                    }
                  </div>
                </div>
                <span style={{ display: 'flex', flexShrink: 0, marginTop: '2px' }}>
                  <ChevronRightIcon color="#C4C9D4" />
                </span>
              </div>

              {/* Due date, priority and status — one quiet line at the foot of
                  every card, so the three cards agree on where to look. */}
              <div style={{
                marginTop: 'auto',
                display: 'flex', alignItems: 'center', gap: '8px',
              }}>
                {/* The task's own metadata wraps inside its column; the reorder
                    controls sit outside it, so they never drop to a line of
                    their own and the card keeps its height. */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
                  flex: 1, minWidth: 0,
                }}>
                {dueDateStr && (
                  <span style={{
                    display: 'flex', alignItems: 'center', gap: '4px',
                    fontSize: '11.5px', fontWeight: 500, color: '#6B7280',
                  }}>
                    <CalendarDays size={12} strokeWidth={2} color="#8A94A6" style={{ flexShrink: 0 }} />
                    {`Due ${dueDateStr}`}
                  </span>
                )}
                {priorityLabel && (
                  <span style={{ ...chipStyle, color: priorityColor }}>{priorityLabel}</span>
                )}
                {statusLabel && (
                  <span style={{ ...chipStyle, color: '#7B8494', fontWeight: 400 }}>{statusLabel}</span>
                )}
                </div>

                {/* Reorder, at the far end of the same line so it never competes
                    with the task's own information. Only the moves that exist
                    are offered: slot 1 cannot move back, and the last slot
                    cannot move on. */}
                {canReorder && tasks.length > 1 && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
                    {idx > 0 && (
                      <FocusReorderButton
                        label={isMobile ? 'Move up' : 'Move left'}
                        icon={isMobile
                          ? <ChevronUp size={15} strokeWidth={2} />
                          : <ChevronLeft size={15} strokeWidth={2} />}
                        disabled={reordering}
                        size={isMobile ? 32 : 24}
                        onActivate={() => onReorder(idx, -1)}
                      />
                    )}
                    {idx < tasks.length - 1 && (
                      <FocusReorderButton
                        label={isMobile ? 'Move down' : 'Move right'}
                        icon={isMobile
                          ? <ChevronDown size={15} strokeWidth={2} />
                          : <ChevronRight size={15} strokeWidth={2} />}
                        disabled={reordering}
                        size={isMobile ? 32 : 24}
                        onActivate={() => onReorder(idx, 1)}
                      />
                    )}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ── Operational status strip ──────────────────────────────────────────────────

function OperationalStatusPanel({
  overdueTasks,
  waitingTasks,
  dueTodayTasks,
  onShowList,
  isMobile,
}: {
  overdueTasks: Task[]
  waitingTasks: Task[]
  dueTodayTasks: Task[]
  onShowList: (list: { title: string; items: Task[] }) => void
  isMobile: boolean
}) {
  // Overdue keeps its red — it is the one counter that reports a problem.
  // Waiting and Due Today are states, not alarms, and stay neutral.
  const items = [
    { label: 'Overdue',   sub: 'Needs attention', count: overdueTasks.length,  items: overdueTasks,  title: 'Overdue Tasks', countColor: '#C0392B' },
    { label: 'Waiting',   sub: 'Pending action',  count: waitingTasks.length,  items: waitingTasks,  title: 'Waiting Tasks', countColor: '#111318' },
    { label: 'Due Today', sub: 'Finish today',    count: dueTodayTasks.length, items: dueTodayTasks, title: 'Due Today',     countColor: '#111318' },
  ]
  return (
    <section style={{
      display: 'grid',
      gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)',
      gap: isMobile ? '10px' : '12px',
    }}>
      {items.map(item => {
        // Unchanged rule: a counter opens its list only when it has one.
        const isInteractive = item.count > 0
        const open = () => onShowList({ title: item.title, items: item.items })
        return (
          <div
            key={item.label}
            onClick={() => isInteractive && open()}
            role={isInteractive ? 'button' : undefined}
            tabIndex={isInteractive ? 0 : undefined}
            onKeyDown={e => { if (isInteractive && e.key === 'Enter') open() }}
            style={{
              background: '#fff',
              border: '1px solid #E7E9EE',
              borderRadius: '12px',
              padding: '14px 16px',
              cursor: isInteractive ? 'pointer' : 'default',
              transition: 'background 0.15s, border-color 0.15s',
            }}
            onMouseEnter={e => {
              if (!isInteractive) return
              e.currentTarget.style.background = '#FCFCFD'
              e.currentTarget.style.borderColor = '#C9CFDA'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = '#fff'
              e.currentTarget.style.borderColor = '#E7E9EE'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{
                fontSize: '20px', fontWeight: 700, lineHeight: 1,
                color: item.count > 0 ? item.countColor : '#D1D5DB',
                letterSpacing: '-0.03em',
                minWidth: '20px',
              }}>
                {item.count}
              </span>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#3D4455', lineHeight: 1 }}>
                {item.label}
              </span>
              {isInteractive && (
                <span style={{ marginLeft: 'auto', display: 'flex' }}>
                  <ChevronRightIcon color="#C4C9D4" />
                </span>
              )}
            </div>
            <div style={{ fontSize: '11.5px', color: '#9CA3AF', marginTop: '6px', lineHeight: 1.2 }}>
              {item.sub}
            </div>
          </div>
        )
      })}
    </section>
  )
}

// ── Unacknowledged Tasks panel ────────────────────────────────────────────────

// ── Attention panel shell ────────────────────────────────────────────────────
// Needs Acknowledgement, Quotation Requests and Overdue Tasks were three copies
// of the same header. One shell instead, so the cards beside each other agree on
// padding, type and where "View all" sits. It decides nothing about contents.
function AttentionPanel({
  title, count, badgeTone = 'neutral', onViewAll, isMobile, children,
}: {
  title: string
  count: number
  badgeTone?: 'neutral' | 'alert'
  onViewAll: () => void
  isMobile: boolean
  children: React.ReactNode
}) {
  const interactive = count > 0
  return (
    <div style={{
      background: '#fff',
      border: '1px solid #E7E9EE',
      borderRadius: '12px',
      overflow: 'hidden',
    }}>
      <div
        onClick={() => interactive && onViewAll()}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: '10px',
          padding: isMobile ? '12px 14px' : '12px 16px',
          borderBottom: '1px solid #F0F1F4',
          cursor: interactive ? 'pointer' : 'default',
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => { if (interactive) e.currentTarget.style.background = '#FAFBFC' }}
        onMouseLeave={e => { e.currentTarget.style.background = '' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          <span style={{
            fontWeight: 600, fontSize: '14px', color: '#3D4455',
            letterSpacing: '-0.01em', lineHeight: 1.2,
          }}>
            {title}
          </span>
          {count > 0 && (
            <span style={{
              background: badgeTone === 'alert' ? '#FEF2F2' : '#F1F2F5',
              color: badgeTone === 'alert' ? '#C0392B' : '#6B7280',
              fontWeight: 600, fontSize: '11px',
              borderRadius: '999px', padding: '1px 7px', lineHeight: 1.6,
            }}>
              {count}
            </span>
          )}
        </div>
        {interactive && (
          <span style={{ fontSize: '11.5px', color: '#9CA3AF', whiteSpace: 'nowrap', flexShrink: 0 }}>
            View all →
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

// ── Compact empty state ──────────────────────────────────────────────────────
// An empty card must not reserve a populated card's height. This is one row:
// roughly 64px of content, so the whole card lands near 105px instead of 160.
function PanelEmptyState({ headline, detail }: { headline: string; detail: string }) {
  return (
    <div style={{ padding: '18px 16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
      <span style={{
        width: '28px', height: '28px', borderRadius: '8px', flexShrink: 0,
        background: '#F1F4F2', color: '#5A8468',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Check size={15} strokeWidth={2.2} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: '#3D4455', lineHeight: 1.3 }}>
          {headline}
        </div>
        <div style={{ fontSize: '12px', color: '#9CA3AF', lineHeight: 1.35, marginTop: '2px' }}>
          {detail}
        </div>
      </div>
    </div>
  )
}

// ── Unacknowledged Tasks panel ────────────────────────────────────────────────

function UnacknowledgedPanel({
  tasks,
  userMap,
  now,
  isMobile,
  currentUserId,
  acknowledgingIds,
  onAcknowledge,
  onPreview,
  onViewAll,
}: {
  tasks: Task[]
  userMap: Record<string, string>
  now: Date
  isMobile: boolean
  currentUserId?: string
  acknowledgingIds?: Set<string>
  onAcknowledge?: (task: Task) => void
  onPreview: (task: Task) => void
  onViewAll: () => void
}) {
  return (
    <AttentionPanel
      title="Needs Acknowledgement"
      count={tasks.length}
      onViewAll={onViewAll}
      isMobile={isMobile}
    >
      {tasks.length === 0 ? (
        <PanelEmptyState headline="All clear" detail="No tasks need acknowledgement" />
      ) : (
        <UnacknowledgedTasksSection
          tasks={tasks}
          userMap={userMap}
          now={now}
          onPreview={onPreview}
          compact
          variant="acknowledgement"
          currentUserId={currentUserId}
          acknowledgingIds={acknowledgingIds}
          onAcknowledge={onAcknowledge}
        />
      )}
    </AttentionPanel>
  )
}

// ── Quotation Requests panel ──────────────────────────────────────────────────

function QuotationPanel({
  tasks,
  userMap,
  isMobile,
  onOpen,
  onViewAll,
}: {
  tasks: Task[]
  userMap: Record<string, string>
  isMobile: boolean
  onOpen: (task: Task) => void
  onViewAll: () => void
}) {
  return (
    <AttentionPanel
      title="Quotation Requests"
      count={tasks.length}
      onViewAll={onViewAll}
      isMobile={isMobile}
    >
      {tasks.length === 0 ? (
        <PanelEmptyState headline="No active requests" detail="Quotation requests will appear here" />
      ) : (
        <QuotationRequestsSection tasks={tasks} userMap={userMap} onOpen={onOpen} />
      )}
    </AttentionPanel>
  )
}

// ── Overdue Tasks panel (non-admin) ──────────────────────────────────────────

function OverdueTasksPanel({
  tasks,
  userMap,
  now,
  isMobile,
  onSelectTask,
  onViewAll,
}: {
  tasks: Task[]
  userMap: Record<string, string>
  now: Date
  isMobile: boolean
  onSelectTask: (task: Task) => void
  onViewAll: () => void
}) {
  return (
    <AttentionPanel
      title="Overdue Tasks"
      count={tasks.length}
      badgeTone="alert"
      onViewAll={onViewAll}
      isMobile={isMobile}
    >
      {tasks.length === 0 ? (
        <PanelEmptyState headline="All caught up" detail="No overdue tasks" />
      ) : (
        <UnacknowledgedTasksSection tasks={tasks} userMap={userMap} now={now} onPreview={onSelectTask} compact />
      )}
    </AttentionPanel>
  )
}

// ── QuotationRequestsSection ──────────────────────────────────────────────────

function QuotationRequestsSection({
  tasks,
  userMap,
  onOpen,
}: {
  tasks: Task[]
  userMap: Record<string, string>
  onOpen: (task: Task) => void
}) {
  const now          = new Date()
  const todayStart   = new Date(now); todayStart.setHours(0, 0, 0, 0)
  const yesterdayStart = new Date(todayStart.getTime() - 86400000)
  const tomorrowStart  = new Date(todayStart.getTime() + 86400000)

  return (
    <div>
      {tasks.slice(0, 8).map((task, idx) => {
        const isLast        = idx === Math.min(tasks.length, 8) - 1
        const requesterName = userMap[task.created_by] ?? 'Unknown'
        const dueDate       = task.due_date ? new Date(task.due_date) : null
        const isToday       = dueDate ? dueDate.toDateString() === now.toDateString() : false
        const isDueOverdue  = dueDate ? dueDate < todayStart && !isToday : false
        const isTomorrow    = dueDate ? dueDate >= tomorrowStart && dueDate < new Date(tomorrowStart.getTime() + 86400000) : false
        const dueDateStr    = dueDate ? dueDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : null

        // Date/created text, with a days-remaining framing for near-term due dates
        let dateText: string | null = null
        let dateColor = '#6B7280'
        if (dueDate) {
          if (isDueOverdue)    { dateText = `Overdue · ${dueDateStr}`; dateColor = '#C0392B' }
          else if (isToday)    { dateText = 'Due today';               dateColor = '#D97706' }
          else if (isTomorrow) { dateText = 'Due tomorrow';            dateColor = '#6B7280' }
          else {
            const daysLeft = Math.round((dueDate.getTime() - todayStart.getTime()) / 86_400_000)
            dateText = daysLeft <= 7 ? `${daysLeft} days left` : `Due ${dueDateStr}`
            dateColor = '#6B7280'
          }
        } else {
          const created = new Date(task.created_at)
          if (created >= todayStart)        { dateText = 'Created today';     dateColor = '#9CA3AF' }
          else if (created >= yesterdayStart) { dateText = 'Created yesterday'; dateColor = '#9CA3AF' }
        }

        const priorityLower  = task.priority?.toLowerCase() ?? ''
        const priorityLabel  = task.priority ? task.priority.charAt(0).toUpperCase() + task.priority.slice(1) : null
        const priorityPill   = PRIORITY_PILL[priorityLower] ?? PRIORITY_PILL.low

        // Creator/assigner → Due/Overdue → Priority — only these three metadata items
        const metaSegments: MetaSegment[] = []
        if (requesterName && requesterName !== 'Unknown') {
          metaSegments.push({ text: requesterName, color: '#9CA3AF' })
        }
        if (dateText) metaSegments.push({ text: dateText, color: dateColor })
        if (priorityLabel) metaSegments.push({ text: priorityLabel, color: priorityPill.color, bg: priorityPill.bg, pill: true })

        return (
          <div
            key={task.id}
            onClick={() => onOpen(task)}
            role="button"
            tabIndex={0}
            onKeyDown={e => e.key === 'Enter' && onOpen(task)}
            style={{
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '8px 16px 8px 20px',
              borderBottom: isLast ? 'none' : '1px solid #F0F1F4',
              cursor: 'pointer',
              transition: 'background 0.12s',
              minHeight: '52px',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#F9FAFB' }}
            onMouseLeave={e => { e.currentTarget.style.background = '' }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: '14px', fontWeight: 600, color: '#111827',
                letterSpacing: '-0.01em', lineHeight: 1.35,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                marginBottom: '3px',
              }}>
                {task.customer_name ?? task.title}
              </div>
              <MetaLine segments={metaSegments} />
            </div>
            <ChevronRightIcon />
          </div>
        )
      })}
    </div>
  )
}

// ── UnacknowledgedTasksSection ────────────────────────────────────────────────

function UnacknowledgedTasksSection({
  tasks,
  userMap,
  now,
  onPreview,
  compact,
  variant = 'overdue',
  currentUserId,
  acknowledgingIds,
  onAcknowledge,
}: {
  tasks: Task[]
  userMap: Record<string, string>
  now: Date
  onPreview: (task: Task) => void
  compact?: boolean
  variant?: 'acknowledgement' | 'overdue'
  currentUserId?: string
  acknowledgingIds?: Set<string>
  onAcknowledge?: (task: Task) => void
}) {
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0)

  return (
    <div style={compact ? {} : { marginBottom: '24px' }}>
      {tasks.map((task, idx) => {
        const dueDate      = task.due_date ? new Date(task.due_date) : null
        const isToday      = dueDate ? dueDate.toDateString() === now.toDateString() : false
        const isDueOverdue = dueDate ? dueDate < todayStart && !isToday : false
        const dueDateStr   = dueDate ? dueDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : null

        let dateText: string | null = null
        let dateColor = '#6B7280'
        if (dueDate) {
          if (isDueOverdue) { dateText = `Overdue · ${dueDateStr}`; dateColor = '#C0392B' }
          else if (isToday) { dateText = 'Due today';               dateColor = '#D97706' }
          else              { dateText = `Due ${dueDateStr}`;        dateColor = '#6B7280' }
        }

        const priorityLower = task.priority?.toLowerCase() ?? ''
        const priorityLabel = task.priority ? task.priority.charAt(0).toUpperCase() + task.priority.slice(1) : null
        const priorityPill  = PRIORITY_PILL[priorityLower] ?? PRIORITY_PILL.low

        const isBlocked = task.status === 'blocked'

        const assignedByName = getAssignedByDisplay(task, userMap)

        const metaSegments: MetaSegment[] = []
        if (variant === 'acknowledgement') {
          // Assigner → Due/Overdue → Priority — only these three metadata items on the compact dashboard row
          if (assignedByName) {
            metaSegments.push({
              text: assignedByName === 'Self' ? 'You' : assignedByName, color: '#9CA3AF',
              icon: <User size={12} strokeWidth={2} color="#B0BAC8" style={{ flexShrink: 0 }} />,
            })
          }
          if (dateText) {
            metaSegments.push({
              text: dateText, color: dateColor,
              icon: <CalendarDays size={12} strokeWidth={2} color="#8A94A6" style={{ flexShrink: 0 }} />,
            })
          }
          if (priorityLabel) metaSegments.push({ text: priorityLabel, color: priorityPill.color, bg: priorityPill.bg, pill: true })
        } else {
          if (priorityLabel) metaSegments.push({ text: priorityLabel, color: priorityPill.color, bg: priorityPill.bg, pill: true })
          if (isBlocked) metaSegments.push({ text: 'Blocked', color: BLOCKED_PILL.color, bg: BLOCKED_PILL.bg, pill: true })
          if (dateText) metaSegments.push({ text: dateText, color: dateColor })
          if (assignedByName) {
            metaSegments.push({ text: `by ${assignedByName === 'Self' ? 'you' : assignedByName}`, color: '#9CA3AF' })
          }
        }
        const isLast = idx === tasks.length - 1

        const canAcknowledge = variant === 'acknowledgement' &&
          !!onAcknowledge && !task.acknowledged_at &&
          !!currentUserId && task.created_by !== currentUserId
        const isAcknowledging = acknowledgingIds?.has(task.id) ?? false

        return (
          <div
            key={task.id}
            onClick={() => onPreview(task)}
            role="button"
            tabIndex={0}
            onKeyDown={e => e.key === 'Enter' && onPreview(task)}
            style={{
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '8px 16px 8px 20px',
              borderBottom: isLast ? 'none' : '1px solid #F0F1F4',
              cursor: 'pointer',
              transition: 'background 0.12s',
              minHeight: '52px',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#F9FAFB' }}
            onMouseLeave={e => { e.currentTarget.style.background = '' }}
          >
            {/* Title + compact metadata (priority/waiting/blocked pills, due date, assignee) —
                given more visual weight than the action cluster on the right */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: '14px', fontWeight: 600, color: '#111827',
                letterSpacing: '-0.01em', lineHeight: 1.35,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                marginBottom: variant === 'acknowledgement' ? '8px' : '3px',
              }}>
                {task.title}
              </div>
              <MetaLine segments={metaSegments} gap={variant === 'acknowledgement' ? '10px' : '6px'} />
            </div>

            {/* Action cluster — lighter treatment than the title, tightly grouped */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
              {canAcknowledge && (
                <button
                  onClick={e => { e.stopPropagation(); onAcknowledge?.(task) }}
                  disabled={isAcknowledging}
                  aria-label={`Acknowledge: ${task.title}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '4px',
                    padding: '4px 8px',
                    fontSize: '12px', fontWeight: 500,
                    color: isAcknowledging ? '#B9BFC9' : '#4E9B72',
                    background: 'transparent',
                    border: 'none',
                    borderRadius: '6px', cursor: isAcknowledging ? 'default' : 'pointer',
                    transition: 'background 0.12s',
                  }}
                  onMouseEnter={e => { if (!isAcknowledging) e.currentTarget.style.background = 'rgba(69,168,112,0.08)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                >
                  <Check size={11} strokeWidth={2.5} />
                  {isAcknowledging ? 'Saving…' : 'Acknowledge'}
                </button>
              )}
              <ChevronRightIcon />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── TaskListDrawer ────────────────────────────────────────────────────────────

function TaskListDrawer({
  title,
  items,
  isMobile,
  onClose,
  onSelectTask,
  userMap,
}: {
  title: string
  items: Task[]
  isMobile?: boolean
  onClose: () => void
  onSelectTask: (task: Task) => void
  userMap: Record<string, string>
}) {
  const isOverdueDrawer = title === 'Overdue Tasks'
  const isWaitingDrawer = title === 'Waiting Tasks'
  const now = new Date()
  const msPerDay = 24 * 60 * 60 * 1000

  const subtitle = isOverdueDrawer
    ? `${items.length} task${items.length !== 1 ? 's' : ''} need your attention`
    : isWaitingDrawer
      ? `${items.length} task${items.length !== 1 ? 's' : ''} waiting on action`
      : `${items.length} task${items.length !== 1 ? 's' : ''}`

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', zIndex: 40 }} />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0,
        width: isMobile ? '100%' : '420px',
        background: '#fff', boxShadow: '-4px 0 24px rgba(0,0,0,0.12)',
        zIndex: 50, display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '20px 24px', borderBottom: '1px solid #F3F4F6', flexShrink: 0 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: '16px', color: '#111827', letterSpacing: '-0.01em', lineHeight: 1 }}>
              {title}
            </div>
            <div style={{ fontSize: '13px', color: '#9CA3AF', marginTop: '6px' }}>
              {subtitle}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9CA3AF', fontSize: '22px', lineHeight: 1, padding: '0 0 0 12px', flexShrink: 0 }}
            aria-label="Close"
          >×</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {items.length === 0 ? (
            <div style={{ padding: '52px 24px', textAlign: 'center' }}>
              <div style={{ fontSize: '14px', fontWeight: 500, color: '#374151', marginBottom: '6px' }}>All clear</div>
              <div style={{ fontSize: '13px', color: '#C4C9D4' }}>No tasks here right now.</div>
            </div>
          ) : (
            items.map((task, idx) => {
              const isLast    = idx === items.length - 1
              const dueDate   = task.due_date ? new Date(task.due_date) : null
              const daysOver  = dueDate ? Math.floor((now.getTime() - dueDate.getTime()) / msPerDay) : 0
              const dueDateStr = dueDate ? dueDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : null
              const assignedBy = getAssignedByDisplay(task, userMap)

              let dateLabel = ''
              let dateColor = '#6B7280'
              if (isOverdueDrawer && dueDate && daysOver > 0) {
                dateLabel = daysOver === 1 ? 'Overdue by 1 day' : `Overdue by ${daysOver} days`
                dateColor = '#C0392B'
              } else if (dueDateStr) {
                dateLabel = `Due ${dueDateStr}`
                dateColor = '#6B7280'
              }

              return (
                <div
                  key={task.id}
                  onClick={() => onSelectTask(task)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && onSelectTask(task)}
                  style={{
                    display: 'flex', alignItems: 'stretch',
                    borderBottom: isLast ? 'none' : '1px solid #F4F5F7',
                    cursor: 'pointer',
                    transition: 'background 0.12s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#F9FAFB' }}
                  onMouseLeave={e => { e.currentTarget.style.background = '' }}
                >
                  {/* Left accent strip — overdue drawer only */}
                  {isOverdueDrawer && (
                    <div style={{ width: '3px', flexShrink: 0, background: '#EF4444' }} />
                  )}

                  {/* Card content */}
                  <div style={{ flex: 1, minWidth: 0, padding: '18px 16px 18px 20px' }}>
                    {/* Title */}
                    <div style={{
                      fontSize: '15px', fontWeight: 600, color: '#111827',
                      letterSpacing: '-0.01em', lineHeight: 1.35,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      marginBottom: '8px',
                    }}>
                      {task.title}
                    </div>

                    {/* Assigned by */}
                    {assignedBy && assignedBy !== 'Self' && (
                      <div style={{ marginBottom: '10px' }}>
                        <div style={{ fontSize: '10px', fontWeight: 500, color: '#C4C9D4', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>
                          Assigned by
                        </div>
                        <div style={{ fontSize: '13px', fontWeight: 600, color: '#374151' }}>
                          {assignedBy}
                        </div>
                      </div>
                    )}

                    {/* Status + Priority chips */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: dateLabel ? '8px' : 0, flexWrap: 'wrap' }}>
                      <StatusChip status={task.status} />
                      {task.priority && <PriorityChip priority={task.priority} />}
                    </div>

                    {/* Date label */}
                    {dateLabel && (
                      <div style={{ fontSize: '12px', fontWeight: 500, color: dateColor }}>
                        {dateLabel}
                      </div>
                    )}
                  </div>

                  {/* Chevron */}
                  <div style={{ display: 'flex', alignItems: 'center', paddingRight: '16px', flexShrink: 0 }}>
                    <ChevronRightIcon />
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </>
  )
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, { color: string; bg: string }> = {
    pending:          { color: '#6B7280', bg: '#F3F4F6' },
    started:          { color: '#7C3AED', bg: '#F5F3FF' },
    working:          { color: '#1D4ED8', bg: '#EFF6FF' },
    waiting:          { color: '#92400E', bg: '#FFFBEB' },
    blocked:          { color: '#991B1B', bg: '#FEF2F2' },
    pending_approval: { color: '#8A6B12', bg: '#FBF6E6' },
    completed:        { color: '#166534', bg: '#F0FDF4' },
  }
  const s = map[status] ?? { color: '#374151', bg: '#F3F4F6' }
  return (
    <span style={{ fontSize: '11px', fontWeight: 600, color: s.color, background: s.bg, borderRadius: '5px', padding: '2px 8px', textTransform: 'capitalize' }}>
      {taskStatusLabel(status)}
    </span>
  )
}

function PriorityChip({ priority }: { priority: string }) {
  const map: Record<string, { color: string; bg: string }> = {
    high:   { color: '#991B1B', bg: '#FEF2F2' },
    medium: { color: '#92400E', bg: '#FFFBEB' },
    low:    { color: '#374151', bg: '#F3F4F6' },
  }
  const s = map[priority] ?? { color: '#374151', bg: '#F3F4F6' }
  return (
    <span style={{ fontSize: '11px', fontWeight: 600, color: s.color, background: s.bg, borderRadius: '5px', padding: '2px 8px', textTransform: 'capitalize' }}>
      {priority}
    </span>
  )
}

// ── EscalationListDrawer ──────────────────────────────────────────────────────

function EscalationListDrawer({
  items,
  isMobile,
  onClose,
  onSelectTask,
}: {
  items: { task: Task; owner: string; days: number; reason: string }[]
  isMobile?: boolean
  onClose: () => void
  onSelectTask: (task: Task) => void
}) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', zIndex: 40 }} />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: isMobile ? '100%' : '420px',
        background: '#fff', boxShadow: '-4px 0 24px rgba(0,0,0,0.12)',
        zIndex: 50, display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px', borderBottom: '1px solid #F3F4F6', flexShrink: 0 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: '15px', color: '#111827' }}>Escalations</div>
            <div style={{ fontSize: '13px', color: '#9CA3AF', marginTop: '2px' }}>{items.length} task{items.length !== 1 ? 's' : ''} requiring attention</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6B7280', fontSize: '20px', lineHeight: 1, padding: '4px 8px', borderRadius: '6px' }} aria-label="Close">×</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {items.length === 0 ? (
            <div style={{ padding: '48px 24px', textAlign: 'center', color: '#9CA3AF', fontSize: '14px' }}>No escalations right now.</div>
          ) : items.map(({ task, owner, days, reason }) => {
            const daysColor = days >= 10 ? '#C0392B' : days >= 7 ? '#D4893A' : '#374151'
            return (
              <div
                key={task.id}
                onClick={() => onSelectTask(task)}
                role="button"
                tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && onSelectTask(task)}
                style={{ padding: '14px 24px', borderBottom: '1px solid #F9FAFB', cursor: 'pointer', transition: 'background 0.1s' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#F9FAFB')}
                onMouseLeave={e => (e.currentTarget.style.background = '')}
              >
                <div style={{ fontSize: '14px', fontWeight: 500, color: '#111827', marginBottom: '6px', lineHeight: 1.4 }}>{task.title}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <div style={{ width: '22px', height: '22px', borderRadius: '50%', background: '#E5E7EB', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: 700, color: '#374151' }}>
                      {owner.slice(0, 2).toUpperCase()}
                    </div>
                    <span style={{ fontSize: '12px', color: '#374151' }}>{owner}</span>
                  </div>
                  <span style={{ fontSize: '12px', fontWeight: 700, color: daysColor }}>{days}d</span>
                  <ReasonBadge reason={reason} />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

function ReasonBadge({ reason }: { reason: string }) {
  const styles: Record<string, { color: string; bg: string }> = {
    Blocked: { color: '#991B1B', bg: '#FEF2F2' },
    Waiting: { color: '#92400E', bg: '#FFFBEB' },
    Stale:   { color: '#BE185D', bg: '#FDF2F8' },
  }
  const s = styles[reason] ?? { color: '#374151', bg: '#F3F4F6' }
  return (
    <span style={{ fontSize: '10px', fontWeight: 600, color: s.color, background: s.bg, borderRadius: '4px', padding: '1px 6px', whiteSpace: 'nowrap' }}>
      {reason}
    </span>
  )
}
