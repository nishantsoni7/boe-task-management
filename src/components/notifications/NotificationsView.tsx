'use client'

import { useEffect, useState, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { useRefresh } from '@/contexts/RefreshContext'
import type { Notification, UserProfile } from '@/lib/types'
import type { NotificationCategory } from '@/lib/notifications'
import { getNotificationMeta } from '@/lib/notificationMeta'
import { colors, font } from '@/lib/tokens'
import { Bell, CheckCheck, Trash2, AlertTriangle, ChevronDown } from 'lucide-react'
import { useSignedInUserId } from '@/hooks/queries/usePermissionContext'
import { useProfile } from '@/hooks/queries/useProfile'
import { useNotifications } from '@/hooks/queries/useNotifications'
import { useNotificationMutations } from '@/hooks/queries/useNotificationMutations'
import { notificationKeys } from '@/lib/notificationCache'
import { NotificationListSkeleton } from './NotificationListSkeleton'
import { NotificationTaskGroup } from './NotificationTaskGroup'
import { NotificationRow } from './NotificationRow'
import {
  groupNotificationsByTask,
  filterDisplayItems,
  summarizeDisplayItems,
  allIdsOf,
  type NotificationTaskGroup as TaskGroup,
} from '@/lib/notifications/grouping'

type FilterTab = 'all' | 'unread'

// `title` is typed as `string` (not `React.ReactNode`) because FinanceLayout's
// prop is `string`-only — NotificationsView always passes the literal string
// "Notifications" anyway, so this stays compatible with both DashboardLayout
// (which accepts the broader ReactNode) and FinanceLayout.
type LayoutComponent = React.ComponentType<{
  profile: UserProfile | null
  title: string
  subtitle?: string
  actions?: React.ReactNode
  onSignOut: () => void
  children: React.ReactNode
}>

type NotificationsViewProps = {
  /**
   * Which module's notifications this view owns ('task' | 'finance' | 'order').
   * Required: every list, count, mark-read and delete key is derived from it,
   * and an absent category would produce a list key with no matching count key.
   * All three host pages already pass it explicitly.
   */
  category: NotificationCategory
  /** The module shell to render inside — DashboardLayout for the global page, FinanceLayout for Finance's. */
  Layout: LayoutComponent
  /** Where to send the user after logging out. */
  loginRedirectPath?: string
}

// Shared notification list UI + mutations, reused by the global /notifications
// page and module-scoped pages (e.g. /finance/notifications). All fetches and
// mutations go through the same /api/notifications* endpoints; `category` (when
// given) is threaded through every request so list, count, mark-read and
// delete all agree on exactly which rows belong to this view — see
// getNotificationCategoryFilter in src/lib/notifications.ts.
export function NotificationsView({ category, Layout, loginRedirectPath = '/login' }: NotificationsViewProps) {
  const [filter,   setFilter]   = useState<FilterTab>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [isMobile, setIsMobile] = useState(false)

  // Same breakpoint the rest of the app uses. Only affects layout: the group
  // summary wraps and its actions get taller touch targets; nothing is hidden
  // at either width.
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  const router      = useRouter()
  const supabase    = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()
  const { refreshKey } = useRefresh()

  // IDENTITY ONLY — deliberately not the permission context.
  //
  // What this replaces is a per-mount `supabase.auth.getUser()`: a NETWORK call
  // to the auth server whose only output was a user id, which then gated a
  // second request for the profile row. useSignedInUserId answers the same
  // question from the STORED session with no request at all, and it is the same
  // cached query every module shell already uses, so on any in-app navigation
  // the id is known on the first render.
  //
  // It would have been tempting to take usePermissionContext instead and get
  // the profile from it for free. That is free only where a shell already
  // resolves permissions — under a ModuleGuard, or inside DashboardLayout. This
  // component also renders inside OrdersLayout and AttendancePayrollLayout,
  // which resolve neither, so it would have added a
  // `resolve_effective_permissions_for_user` RPC to the cold load of four
  // module notification pages that never made one. The profile is instead read
  // through useProfile, whose cache entry usePermissionContext now publishes
  // into — so where a shell HAS resolved it, this is a cache hit and costs
  // nothing, and where none has, it is exactly the one request it always was.
  //
  // Identity freshness is held by the auth listener in Providers.tsx, which
  // drops the cache when the signed-in user actually changes. Nothing here is
  // an access decision: every /api/notifications* route independently verifies
  // the caller with its own server-side auth.getUser() and scopes every query
  // to `user_id = <that verified id>`. No user id is ever sent from here.
  const { data: userId, isPending: idPending } = useSignedInUserId()
  const authReady = !idPending
  const { data: profile = null } = useProfile(userId)

  // All list/count cache work lives in this hook: optimistic update, snapshot,
  // rollback on any failure, per-id pending locks, and narrow reconciliation.
  //
  // Declared BEFORE the list query because the list query needs to know whether
  // any of it is in flight — see `mutationInFlight`.
  const {
    markRead, markTaskGroupRead, deleteTaskGroup, groupBusy,
    markAllRead, deleteSingle, deleteSelected: runDeleteSelected, deleteAll,
    pendingDeletes, markingAll, deletingBulk, deletingAll,
    error: mutationError, clearError,
  } = useNotificationMutations(category)

  // A widening re-read while the server has not yet applied an optimistic
  // delete or mark-read would return those rows in their old state and put them
  // back on screen — the exact "deleted notifications come back" symptom the
  // mutation machinery exists to prevent. So "Load older" stands down until
  // every mutation has settled. Single deletes are covered by `pendingDeletes`
  // (which also hides those rows at render time); the three bulk operations
  // have no per-id set, which is why they are listed individually.
  const mutationInFlight =
    pendingDeletes.size > 0 || markingAll || deletingBulk || deletingAll || groupBusy

  const {
    data: notifications = [],
    isPending: notifPending,
    isError: notifError,
    error: notifErrorObj,
    loadOlder, hasOlder, loadingOlder, olderError,
  } = useNotifications(category, mutationInFlight)

  // TRUE ONLY BEFORE THE FIRST RESULT EXISTS.
  //
  // `isPending` is "this query has no data yet", which stays true across the
  // whole first fetch and becomes false the moment a cached list is available —
  // so a return visit inside the cache window renders instantly, and a cold
  // load shows the skeleton rather than an empty inbox. It is deliberately NOT
  // `isLoading`: TanStack reports `isLoading: false` for a query that has not
  // started fetching, which is exactly the window in which "No notifications
  // yet" used to flash.
  const loadingFirstPage = notifPending

  // Refresh from the layout's Refresh button / tab-visibility. Two changes from
  // before, both about not fighting an in-flight mutation:
  //  · the initial run is skipped — mounting already fetches, so invalidating
  //    on mount only forced a second identical request every visit;
  //  · only THIS module's list and count are invalidated, not the whole
  //    ['notifications'] prefix, which also refetched the other two modules'
  //    lists and all three badges.
  const lastRefreshKey = useRef(refreshKey)
  useEffect(() => {
    if (lastRefreshKey.current === refreshKey) return
    lastRefreshKey.current = refreshKey
    queryClient.invalidateQueries({ queryKey: notificationKeys.list(category),  exact: true })
    queryClient.invalidateQueries({ queryKey: notificationKeys.count(category), exact: true })
  }, [refreshKey, category, queryClient])

  // Signed out — send them to the login page. Waits for `ready`, because an
  // unresolved context reports `userId: null`, which is not the same answer as
  // "there is no session".
  useEffect(() => {
    if (authReady && !userId) router.push(loginRedirectPath)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, userId])

  // Prefetch task detail pages for notifications in view
  useEffect(() => {
    if (notifications.length === 0) return
    notifications.slice(0, 12).forEach(n => {
      if (n.task_id) router.prefetch(`/tasks/${n.task_id}`)
    })
  }, [notifications]) // eslint-disable-line react-hooks/exhaustive-deps

  // Rows with a DELETE still in flight are hidden immediately and stay hidden
  // even if a concurrent refetch puts them back in the cache — the server has
  // been told to remove them, so showing them again would be a lie. If the
  // delete fails, the mutation clears the pending id and the row returns.
  const rows = useMemo(
    () => (pendingDeletes.size === 0 ? notifications : notifications.filter(n => !pendingDeletes.has(n.id))),
    [notifications, pendingDeletes],
  )

  // ── The one arrangement ───────────────────────────────────────────────────
  //
  // One card per task, standalone rows for anything with no task. Recomputed
  // from the flat list on every change, which is what makes "Load older"
  // incapable of producing a duplicate group: there is no merge step, only a
  // fresh grouping of a wider newest-N array.
  const items   = useMemo(() => groupNotificationsByTask(rows), [rows])
  const visible = useMemo(() => filterDisplayItems(items, filter), [items, filter])

  // Counted in EVENTS, not cards: "16 unread updates across 6 tasks" is two
  // different quantities and the badge has always meant the first.
  const summary     = useMemo(() => summarizeDisplayItems(items), [items])
  const unreadCount = summary.unreadEvents

  // Surfaced in the inline banner. A failed list fetch no longer renders as an
  // empty inbox — useNotifications throws, and TanStack keeps the last good
  // list on screen underneath this message.
  // "You are all caught up" is the same false claim as the empty state, just in
  // the header — so it waits for the first page too.
  const subtitle = loadingFirstPage
    ? 'Loading…'
    : unreadCount === 0
      ? 'You are all caught up'
      : `${unreadCount} unread update${unreadCount === 1 ? '' : 's'}` +
        (summary.unreadContainers > 0
          ? ` across ${summary.unreadContainers} ${summary.unreadTaskGroups === summary.unreadContainers
              ? `task${summary.unreadContainers === 1 ? '' : 's'}`
              : `item${summary.unreadContainers === 1 ? '' : 's'}`}`
          : '')

  const banner = mutationError
    ?? olderError
    ?? (notifError
      ? (notifErrorObj instanceof Error ? notifErrorObj.message : 'Could not load notifications.')
      : null)

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  // ── Mutation entry points ───────────────────────────────────────────────
  // The optimistic update / snapshot / rollback / reconcile logic all lives in
  // useNotificationMutations; these wrappers only own local selection state.

  const handleDeleteSingle = (id: string) => {
    setSelected(prev => { const s = new Set(prev); s.delete(id); return s })
    deleteSingle(id)
  }

  const handleDeleteSelected = () => {
    if (deletingBulk || selected.size === 0) return
    const ids = [...selected]
    setSelected(new Set())
    runDeleteSelected(ids)
  }

  const handleDeleteAll = () => {
    if (deletingAll || rows.length === 0) return
    setSelected(new Set())
    deleteAll()
  }

  const openTaskGroup = (group: TaskGroup) => {
    const href = getNotificationMeta(group.latest).href
    if (href) router.push(href)
  }

  // Expanding is a disclosure; THIS is the deliberate act.
  //
  // It names the TASK, not the loaded ids. The page is bounded to the newest N
  // events, so an ids-based version would silently skip anything older and
  // leave unread rows behind with the badge still wrong.
  const handleMarkGroupRead = (group: TaskGroup) => {
    markTaskGroupRead(group.taskId)
  }

  // Deletes NOTIFICATION ROWS for this reader and this task — ALL of them, not
  // only the loaded ones. The server resolves the set from the task id under
  // the same category filter and system-type exclusion the list uses, so it
  // cannot reach another user's rows, another task's, or a category this page
  // does not show. It names one table: no task, activity record, comment or
  // attachment is touched.
  //
  // Confirmed because the scope is larger than what is on screen.
  const handleDeleteGroup = (group: TaskGroup) => {
    if (groupBusy) return
    const ok = window.confirm(
      'Delete all notifications for this task?\n\n' +
      'This removes the notification entries only. The task and its activity history will remain.',
    )
    if (!ok) return
    setSelected(prev => {
      const s = new Set(prev)
      for (const id of allIdsOf(group)) s.delete(id)
      return s
    })
    deleteTaskGroup(group.taskId)
  }

  const handleMarkAllRead = () => {
    if (unreadCount === 0 || markingAll) return
    markAllRead()
  }

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const s = new Set(prev)
      if (s.has(id)) s.delete(id)
      else s.add(id)
      return s
    })
  }

  const openNotif = (n: Notification) => {
    if (!n.is_read) markRead(n.id)
    const href = getNotificationMeta(n).href
    if (href) router.push(href)
  }

  const handleRowClick = (n: Notification) => {
    if (!n.is_read) markRead(n.id)
  }

  // NOTE: there is deliberately no early `return <LoadingScreen />` here.
  // Returning one unmounted the entire module shell — sidebar, header, Refresh,
  // every other nav entry — until the notification request came back, so
  // arriving at Notifications froze navigation and LEAVING it had to wait for
  // notification work to finish. The shell now always renders; only the list
  // area swaps to a skeleton.

  // ── Toolbar button base style helpers ─────────────────────────────────────
  const toolBtn = (active: boolean, danger = false) => ({
    display: 'inline-flex' as const, alignItems: 'center' as const, gap: '6px',
    padding: '7px 14px', borderRadius: '7px',
    fontSize: '12px', fontWeight: 600,
    fontFamily: font.body,
    transition: 'all 0.15s',
    border: `1.5px solid ${active ? (danger ? colors.red : colors.blue) : colors.border}`,
    background: active && !danger ? colors.blue : 'transparent',
    color: active ? (danger ? colors.red : '#ffffff') : colors.muted,
    cursor: active ? 'pointer' : 'not-allowed',
    opacity: 1,
  })

  return (
    <Layout
      profile={profile}
      title="Notifications"
      subtitle={subtitle}
      onSignOut={handleLogout}
      actions={
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {/* Delete selected — only shown when something is selected */}
          {selected.size > 0 && (
            <button
              onClick={handleDeleteSelected}
              disabled={deletingBulk}
              style={{
                ...toolBtn(true, true),
                opacity: deletingBulk ? 0.6 : 1,
              }}
            >
              <Trash2 size={13} strokeWidth={2.2} />
              {deletingBulk ? 'Deleting…' : `Delete selected (${selected.size})`}
            </button>
          )}

          <button
            onClick={handleMarkAllRead}
            disabled={unreadCount === 0 || markingAll}
            style={{ ...toolBtn(unreadCount > 0 && !markingAll), opacity: markingAll ? 0.6 : 1 }}
          >
            <CheckCheck size={14} strokeWidth={2.2} />
            {markingAll ? 'Marking…' : 'Mark all read'}
          </button>

          <button
            onClick={handleDeleteAll}
            disabled={deletingAll || rows.length === 0}
            style={{
              ...toolBtn(rows.length > 0 && !deletingAll, true),
              opacity: deletingAll ? 0.6 : 1,
            }}
          >
            <Trash2 size={13} strokeWidth={2.2} />
            {deletingAll ? 'Deleting…' : 'Delete all'}
          </button>
        </div>
      }
    >
      {/* Error banner — the only user-visible signal that a notification action
          failed. Non-disruptive: the list stays rendered underneath, and a
          rolled-back row is already back in place by the time this shows. */}
      {banner && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '9px',
          marginBottom: '12px', padding: '10px 14px',
          borderRadius: '8px',
          background: colors.redTint,
          border: `1px solid ${colors.red}33`,
          maxWidth: '900px',
        }}>
          <AlertTriangle size={14} color={colors.red} strokeWidth={2.2} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: '12.5px', fontWeight: 500, color: colors.red, fontFamily: font.body }}>
            {banner}
          </span>
          {mutationError && (
            <button
              onClick={clearError}
              title="Dismiss"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: colors.red, fontSize: '15px', lineHeight: 1, padding: '0 2px', flexShrink: 0,
              }}
            >
              ×
            </button>
          )}
        </div>
      )}

      {/* Filter pills */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '16px' }}>
        {(['all', 'unread'] as FilterTab[]).map(tab => (
          <button
            key={tab}
            onClick={() => setFilter(tab)}
            style={{
              padding: '5px 14px', borderRadius: '20px',
              fontSize: '12px', fontWeight: 600,
              border: `1.5px solid ${filter === tab ? colors.blue : colors.border}`,
              background: filter === tab ? colors.blue : 'transparent',
              color: filter === tab ? '#fff' : colors.secondary,
              cursor: 'pointer', fontFamily: font.body,
              transition: 'all 0.12s',
            }}
          >
            {tab === 'all' ? 'All' : `Unread${unreadCount > 0 ? ` (${unreadCount})` : ''}`}
          </button>
        ))}
      </div>

      {/* The first page is still in flight and nothing has ever been loaded —
          show the shape of the list, never a claim about its contents. */}
      {loadingFirstPage ? (
        <NotificationListSkeleton />
      ) : visible.length === 0 ? (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', padding: '64px 24px', gap: '10px',
        }}>
          <span style={{
            width: '44px', height: '44px', borderRadius: '50%',
            background: colors.float,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Bell size={18} color={colors.muted} />
          </span>
          <span style={{ fontSize: '14px', fontWeight: 600, color: colors.secondary }}>
            {filter === 'unread' ? 'No unread notifications' : 'No notifications yet'}
          </span>
          <span style={{ fontSize: '12px', color: colors.muted }}>
            {filter === 'unread' ? 'Switch to All to see your history.' : 'Important activity will appear here.'}
          </span>
        </div>
      ) : (
        <div>
          {visible.map(item =>
            item.kind === 'task' ? (
              <NotificationTaskGroup
                key={item.key}
                group={item}
                filter={filter}
                selected={selected}
                pendingDeletes={pendingDeletes}
                busy={groupBusy || markingAll || deletingBulk || deletingAll}
                isMobile={isMobile}
                onToggleSelect={toggleSelect}
                onOpenTask={openTaskGroup}
                onMarkGroupRead={handleMarkGroupRead}
                onDeleteGroup={handleDeleteGroup}
                onDeleteOne={handleDeleteSingle}
                onRowClick={handleRowClick}
              />
            ) : (
              <div key={item.key} className="boe-card" style={{ overflow: 'hidden', padding: 0, maxWidth: '900px', marginBottom: '8px' }}>
                <NotificationRow
                  n={item.notification}
                  isLast
                  selected={selected.has(item.notification.id)}
                  pending={pendingDeletes.has(item.notification.id)}
                  onToggleSelect={toggleSelect}
                  onOpen={openNotif}
                  onDelete={handleDeleteSingle}
                  onRowClick={handleRowClick}
                />
              </div>
            ),
          )}
        </div>
      )}

      {/* Bounded history. The page opens on the newest page and stops offering
          this at NOTIFICATION_MAX_ROWS — there is no control anywhere that
          downloads the whole notification history. "Mark all read" and
          "Delete all" are server-side over the entire category, so neither
          depends on how much of it is on screen. */}
      {!loadingFirstPage && hasOlder && (
        <div style={{ display: 'flex', justifyContent: 'center', maxWidth: '900px', marginTop: '12px' }}>
          <button
            onClick={loadOlder}
            disabled={loadingOlder}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '7px 14px', borderRadius: '7px',
              fontSize: '12px', fontWeight: 600, fontFamily: font.body,
              border: `1.5px solid ${colors.border}`,
              background: 'transparent',
              color: loadingOlder ? colors.muted : colors.secondary,
              cursor: loadingOlder ? 'not-allowed' : 'pointer',
            }}
          >
            <ChevronDown size={13} strokeWidth={2.2} />
            {loadingOlder ? 'Loading…' : 'Load older notifications'}
          </button>
        </div>
      )}
    </Layout>
  )
}
