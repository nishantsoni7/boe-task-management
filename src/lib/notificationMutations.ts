// Notification mutation definitions, as plain TanStack Query option objects.
//
// These live outside the React hook on purpose: every one of them is a
// snapshot → optimistic write → rollback-on-failure sequence whose correctness
// is exactly what the "notifications come back after I delete them" bug was
// about, and driving them through a MutationObserver in a test is far more
// convincing than asserting on rendered markup. `useNotificationMutations`
// wires these into `useMutation`; the tests drive the identical objects.
//
// Shared contract, applied by every option set below:
//   1. snapshot every notification list + count cache
//   2. cancel in-flight refetches, so a slower GET cannot undo step 3
//   3. write the optimistic change
//   4. on ANY failure — thrown network error or non-2xx — restore the snapshot
//      and report a message
//   5. on success — patch the unread count directly, then invalidate only this
//      module's list and count

import type { QueryClient } from '@tanstack/react-query'
import type { Notification } from '@/lib/types'
import type { NotificationCategory } from '@/lib/notifications'
import {
  notificationKeys,
  snapshotNotificationCache,
  restoreNotificationCache,
  removeNotificationsFromLists,
  patchUnreadCount,
  setUnreadCount,
  countUnreadAmong,
  readApiError,
  type NotificationCacheSnapshot,
} from '@/lib/notificationCache'
import { perfStart, type PerfAction } from '@/lib/perf'
import { VIEW_AS_HEADER } from '@/lib/viewAs'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type NotificationMutationDeps = {
  qc: QueryClient
  category: NotificationCategory
  /** Called with a user-safe message whenever a mutation fails and rolls back. */
  reportError: (message: string) => void
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: FetchLike
  /** Called after a single delete settles, so the caller can release its lock. */
  releasePending?: (id: string) => void
  /**
   * True while an administrator is previewing another employee. Adds the preview
   * header to every request so the server refuses it — see doFetch below.
   */
  readOnly?: boolean
}

export type OptimisticContext = { snapshot: NotificationCacheSnapshot }
/** A group action also carries what it optimistically subtracted, to correct it. */
export type TaskGroupContext = OptimisticContext & { optimisticUnread: number }

export type DeleteSingleResult = { success: boolean; deleted: boolean; id?: string }
export type DeleteSelectedResult = { success: boolean; deletedIds?: string[]; deletedCount?: number }
export type DeleteAllResult = { success: boolean; deletedCount?: number }
export type MarkReadResult = { success: boolean; updatedCount?: number; unreadAffected?: number }
export type TaskGroupResult = {
  success: boolean
  deletedCount?: number
  /** Exact unread rows the server touched — including ones never loaded here. */
  unreadAffected?: number
}

/**
 * The one place every notification mutation issues its request.
 *
 * DEFENCE IN DEPTH FOR VIEW AS. When `deps.readOnly` is set the request carries
 * the preview header and the four /api/notifications routes refuse it with 403.
 * useNotificationMutations already returns no-ops in that state, so this path is
 * not normally reached at all — it exists so that a future call site which
 * bypasses the hook still cannot write from inside a preview.
 *
 * Trusting a client header is safe here BECAUSE IT ONLY EVER REMOVES AUTHORITY.
 * A caller who omits it gains nothing they did not already have as themselves.
 */
const doFetch = (deps: NotificationMutationDeps): FetchLike =>
  deps.fetchFn ?? ((input, init) => fetch(input, deps.readOnly
    ? { ...init, headers: { ...(init?.headers ?? {}), [VIEW_AS_HEADER]: '1' } }
    : init))

/**
 * Time one request round-trip. Inert unless NEXT_PUBLIC_BOE_PERF_DEBUG=true,
 * and it records only the action name and a duration — never an id, a title,
 * or a body. Paired with the matching perfTrack in each API route, this gives
 * the client-observed total next to the server-observed portion.
 */
async function timed<T>(action: PerfAction, run: () => Promise<T>): Promise<T> {
  const done = perfStart(action)
  try {
    return await run()
  } finally {
    done()
  }
}

/** Steps 1+2 — freeze the caches, stop anything that could clobber them. */
async function beginOptimistic(deps: NotificationMutationDeps): Promise<NotificationCacheSnapshot> {
  // Cancelled across the whole ['notifications'] prefix: a delete on the
  // Finance page must not be undone by an in-flight global-list GET either.
  await deps.qc.cancelQueries({ queryKey: notificationKeys.root() })
  return snapshotNotificationCache(deps.qc)
}

/**
 * Step 5 — reconcile as narrowly as possible.
 *
 * Two deliberate restrictions:
 *
 * · Scope. NOT the ['notifications'] root, which prefix-matches all three
 *   module lists and all three badge counts — settling one delete would touch
 *   modules the user never acted on.
 *
 * · `refetchType: 'none'`. The caches are already provably correct at this
 *   point: the row was removed optimistically and the server has confirmed it,
 *   and the unread count was patched by a known delta. Refetching now would
 *   buy nothing, cost a request per mutation, and — worst of all — open a
 *   window for a slow GET to land after the delete and put the row back on
 *   screen. Marking the queries stale instead gets convergence with the server
 *   at the next mount or manual refresh, at zero requests now.
 */
/**
 * Settle a COMPLETE-GROUP action, whose scope the browser did not know.
 *
 * Two differences from `reconcile`, both forced by the same fact: the server
 * acted on rows this page never loaded.
 *
 * · THE COUNT IS CORRECTED, NOT GUESSED. `onMutate` already subtracted the
 *   unread rows it could see, which for a bounded page is a lower bound. The
 *   server returns the exact number; the difference is applied here. The value
 *   is never cleared first — it is adjusted — so nothing blanks and the
 *   persisted copy follows the same corrected number.
 *
 * · THE LIST IS ACTUALLY REFETCHED. `refetchType: 'none'` is right when the
 *   cache is provably correct, and after a group action it is not: older events
 *   for that task have gone from the server and are still absent from the
 *   client's knowledge either way, so the list must be re-read or a later "Load
 *   older" would present a stale picture.
 */
function reconcileGroup(
  deps: NotificationMutationDeps,
  optimisticUnread: number,
  serverUnread: number | undefined,
): void {
  if (typeof serverUnread === 'number' && Number.isFinite(serverUnread)) {
    const correction = serverUnread - optimisticUnread
    if (correction !== 0) patchUnreadCount(deps.qc, deps.category, -correction)
  } else {
    // The server did not tell us. Rather than subtract a knowingly incomplete
    // number, leave the visible count alone and let the badge query re-read it.
    deps.qc.invalidateQueries({ queryKey: notificationKeys.count(deps.category), exact: true })
  }
  deps.qc.invalidateQueries({ queryKey: notificationKeys.list(deps.category), exact: true })
}

function reconcile(deps: NotificationMutationDeps): void {
  const mark = { refetchType: 'none' as const, exact: true }
  deps.qc.invalidateQueries({ queryKey: notificationKeys.list(deps.category),  ...mark })
  deps.qc.invalidateQueries({ queryKey: notificationKeys.count(deps.category), ...mark })
}

function rollback(deps: NotificationMutationDeps, ctx: OptimisticContext | undefined, err: unknown, fallback: string) {
  if (ctx?.snapshot) restoreNotificationCache(deps.qc, ctx.snapshot)
  deps.reportError(err instanceof Error && err.message ? err.message : fallback)
}

/** Rows currently cached for this module (used to decide unread-count deltas). */
function cachedList(deps: NotificationMutationDeps, snap: NotificationCacheSnapshot): Notification[] | undefined {
  return snap.lists.find(l => l.category === deps.category)?.data
}

// ── Delete one ─────────────────────────────────────────────────────────────

export function deleteSingleOptions(deps: NotificationMutationDeps) {
  return {
    mutationKey: ['notifications', 'delete-single'] as const,
    mutationFn: (id: string): Promise<DeleteSingleResult> =>
      timed('notification.delete.single', async () => {
        const res = await doFetch(deps)(`/api/notifications/${id}`, { method: 'DELETE' })
        if (!res.ok) throw new Error(await readApiError(res, 'Could not delete this notification'))
        // `deleted: false` is a legitimate idempotent outcome — the row was
        // already gone (a retry, or a delete from another tab). The caller's
        // intent still holds, so the optimistic removal stands rather than
        // rolling back and resurrecting a row that does not exist.
        return (await res.json().catch(() => ({ success: true, deleted: true }))) as DeleteSingleResult
      }),
    onMutate: async (id: string): Promise<OptimisticContext> => {
      const snapshot = await beginOptimistic(deps)
      const wasUnread = (cachedList(deps, snapshot) ?? []).some(n => n.id === id && !n.is_read)
      removeNotificationsFromLists(deps.qc, new Set([id]))
      if (wasUnread) patchUnreadCount(deps.qc, deps.category, -1)
      return { snapshot }
    },
    onError: (err: unknown, id: string, ctx: OptimisticContext | undefined) => {
      rollback(deps, ctx, err, 'Could not delete this notification.')
      deps.releasePending?.(id)
    },
    onSuccess: (_data: DeleteSingleResult, id: string) => {
      // Re-applied before the pending lock is released: between onMutate and
      // here a refetch may have completed and reinstated the row. The server
      // has now confirmed it is gone, so the cache must not show it again.
      removeNotificationsFromLists(deps.qc, new Set([id]))
      deps.releasePending?.(id)
      reconcile(deps)
    },
  }
}

// ── Delete selected ────────────────────────────────────────────────────────

export function deleteSelectedOptions(deps: NotificationMutationDeps) {
  return {
    mutationKey: ['notifications', 'delete-selected'] as const,
    mutationFn: (ids: string[]): Promise<DeleteSelectedResult> =>
      timed('notification.delete.selected', async () => {
        const res = await doFetch(deps)('/api/notifications/delete-selected', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        })
        if (!res.ok) throw new Error(await readApiError(res, 'Could not delete the selected notifications'))
        return (await res.json().catch(() => ({ success: true }))) as DeleteSelectedResult
      }),
    onMutate: async (ids: string[]): Promise<OptimisticContext> => {
      const snapshot = await beginOptimistic(deps)
      const idSet = new Set(ids)
      const unread = countUnreadAmong(cachedList(deps, snapshot), idSet)
      removeNotificationsFromLists(deps.qc, idSet)
      if (unread > 0) patchUnreadCount(deps.qc, deps.category, -unread)
      return { snapshot }
    },
    onError: (err: unknown, _ids: string[], ctx: OptimisticContext | undefined) =>
      rollback(deps, ctx, err, 'Could not delete the selected notifications.'),
    onSuccess: (_data: DeleteSelectedResult, ids: string[]) => {
      removeNotificationsFromLists(deps.qc, new Set(ids))
      reconcile(deps)
    },
  }
}

// ── Delete all (this module only) ──────────────────────────────────────────

export function deleteAllOptions(deps: NotificationMutationDeps) {
  return {
    mutationKey: ['notifications', 'delete-all'] as const,
    mutationFn: (): Promise<DeleteAllResult> =>
      timed('notification.delete.all', async () => {
        // Category is always sent explicitly so the server can never fall back
        // to its `task` default and clear a different module's rows.
        const res = await doFetch(deps)(`/api/notifications?category=${deps.category}`, { method: 'DELETE' })
        if (!res.ok) throw new Error(await readApiError(res, 'Could not delete all notifications'))
        return (await res.json().catch(() => ({ success: true }))) as DeleteAllResult
      }),
    onMutate: async (): Promise<OptimisticContext> => {
      const snapshot = await beginOptimistic(deps)
      // ONLY this module's list is cleared. Finance/Orders caches are left
      // exactly as they were, matching the server's category scoping — "Delete
      // all" on the Task page must never empty another module's inbox.
      deps.qc.setQueryData<Notification[]>(notificationKeys.list(deps.category), [])
      setUnreadCount(deps.qc, deps.category, 0)
      return { snapshot }
    },
    onError: (err: unknown, _v: void, ctx: OptimisticContext | undefined) =>
      rollback(deps, ctx, err, 'Could not delete all notifications.'),
    onSuccess: () => reconcile(deps),
  }
}

// ── Mark one read ──────────────────────────────────────────────────────────

export function markReadOptions(deps: NotificationMutationDeps) {
  return {
    mutationKey: ['notifications', 'mark-read'] as const,
    mutationFn: (id: string): Promise<MarkReadResult> =>
      timed('notification.mark.read', async () => {
        const res = await doFetch(deps)('/api/notifications/mark-read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        })
        if (!res.ok) throw new Error(await readApiError(res, 'Could not mark this notification as read'))
        return (await res.json().catch(() => ({ success: true }))) as MarkReadResult
      }),
    onMutate: async (id: string): Promise<OptimisticContext> => {
      const snapshot = await beginOptimistic(deps)
      const wasUnread = (cachedList(deps, snapshot) ?? []).some(n => n.id === id && !n.is_read)
      const now = new Date().toISOString()
      deps.qc.setQueryData<Notification[]>(notificationKeys.list(deps.category), old =>
        (old ?? []).map(n => (n.id === id ? { ...n, is_read: true, read_at: now } : n)))
      if (wasUnread) patchUnreadCount(deps.qc, deps.category, -1)
      return { snapshot }
    },
    onError: (err: unknown, _id: string, ctx: OptimisticContext | undefined) =>
      rollback(deps, ctx, err, 'Could not mark this notification as read.'),
    onSuccess: () => reconcile(deps),
  }
}

// ── Mark a known set read (one task group) ─────────────────────────────────

/**
 * The same operation as `markReadOptions`, for a SET of ids.
 *
 * One request rather than one per event. Marking a four-event task group read
 * through the single-id path would be four optimistic updates, four failure
 * modes and four chances for the unread count to drift; here the delta is
 * computed once, from the events that were actually unread, and one rollback
 * restores everything if the request fails.
 *
 * The unread count is patched by the number of ids that were unread IN THE
 * CACHE — not by `ids.length` — so pressing it twice, or pressing it on a group
 * where some events are already read, cannot take the badge below the truth.
 */
export function markManyReadOptions(deps: NotificationMutationDeps) {
  return {
    mutationKey: ['notifications', 'mark-many-read'] as const,
    mutationFn: (ids: string[]): Promise<MarkReadResult> =>
      timed('notification.mark.read', async () => {
        const res = await doFetch(deps)('/api/notifications/mark-read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        })
        if (!res.ok) throw new Error(await readApiError(res, 'Could not mark these notifications as read'))
        return (await res.json().catch(() => ({ success: true }))) as MarkReadResult
      }),
    onMutate: async (ids: string[]): Promise<OptimisticContext> => {
      const snapshot = await beginOptimistic(deps)
      const target = new Set(ids)
      const unreadAmong = countUnreadAmong(cachedList(deps, snapshot), target)
      const now = new Date().toISOString()
      deps.qc.setQueryData<Notification[]>(notificationKeys.list(deps.category), old =>
        (old ?? []).map(n => (target.has(n.id) && !n.is_read ? { ...n, is_read: true, read_at: now } : n)))
      if (unreadAmong > 0) patchUnreadCount(deps.qc, deps.category, -unreadAmong)
      return { snapshot }
    },
    onError: (err: unknown, _ids: string[], ctx: OptimisticContext | undefined) =>
      rollback(deps, ctx, err, 'Could not mark these notifications as read.'),
    onSuccess: () => reconcile(deps),
  }
}

// ── A COMPLETE task group ──────────────────────────────────────────────────
//
// Both of the following name a TASK, not a list of ids. The page is bounded to
// the newest N events, so a group action built from loaded ids would silently
// skip whatever sits outside that window: "mark all updates for this task as
// read" would leave older unread rows behind, and "delete all notifications for
// this task" would appear to work until the next "Load older" brought the group
// back. The database decides the set; the client only says which task.

/** Mark EVERY notification for one task read — loaded or not. */
export function markTaskGroupReadOptions(deps: NotificationMutationDeps) {
  return {
    mutationKey: ['notifications', 'mark-task-group-read'] as const,
    mutationFn: (taskId: string): Promise<MarkReadResult> =>
      timed('notification.mark.read', async () => {
        const res = await doFetch(deps)('/api/notifications/mark-read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId, category: deps.category }),
        })
        if (!res.ok) throw new Error(await readApiError(res, 'Could not mark this task’s updates as read'))
        return (await res.json().catch(() => ({ success: true }))) as MarkReadResult
      }),
    onMutate: async (taskId: string): Promise<TaskGroupContext> => {
      const snapshot = await beginOptimistic(deps)
      const now = new Date().toISOString()
      // Only the loaded rows can be updated optimistically — that is the whole
      // limitation this mutation exists to work around, and the correction
      // lands in onSuccess.
      const loadedUnread = (cachedList(deps, snapshot) ?? [])
        .filter(n => n.task_id === taskId && !n.is_read).length
      deps.qc.setQueryData<Notification[]>(notificationKeys.list(deps.category), old =>
        (old ?? []).map(n =>
          (n.task_id === taskId && !n.is_read ? { ...n, is_read: true, read_at: now } : n)))
      if (loadedUnread > 0) patchUnreadCount(deps.qc, deps.category, -loadedUnread)
      return { snapshot, optimisticUnread: loadedUnread }
    },
    onError: (err: unknown, _taskId: string, ctx: TaskGroupContext | undefined) =>
      rollback(deps, ctx, err, 'Could not mark this task’s updates as read.'),
    onSuccess: (data: MarkReadResult, _taskId: string, ctx: TaskGroupContext | undefined) =>
      reconcileGroup(deps, ctx?.optimisticUnread ?? 0, data?.unreadAffected),
  }
}

/** Delete EVERY notification for one task — loaded or not. Rows only. */
export function deleteTaskGroupOptions(deps: NotificationMutationDeps) {
  return {
    mutationKey: ['notifications', 'delete-task-group'] as const,
    mutationFn: (taskId: string): Promise<TaskGroupResult> =>
      timed('notification.delete.selected', async () => {
        const res = await doFetch(deps)(
          `/api/notifications?category=${deps.category}&taskId=${encodeURIComponent(taskId)}`,
          { method: 'DELETE' })
        if (!res.ok) throw new Error(await readApiError(res, 'Could not delete this task’s notifications'))
        return (await res.json().catch(() => ({ success: true }))) as TaskGroupResult
      }),
    onMutate: async (taskId: string): Promise<TaskGroupContext> => {
      const snapshot = await beginOptimistic(deps)
      const doomed = (cachedList(deps, snapshot) ?? []).filter(n => n.task_id === taskId)
      const loadedUnread = doomed.filter(n => !n.is_read).length
      removeNotificationsFromLists(deps.qc, new Set(doomed.map(n => n.id)))
      if (loadedUnread > 0) patchUnreadCount(deps.qc, deps.category, -loadedUnread)
      return { snapshot, optimisticUnread: loadedUnread }
    },
    onError: (err: unknown, _taskId: string, ctx: TaskGroupContext | undefined) =>
      rollback(deps, ctx, err, 'Could not delete this task’s notifications.'),
    onSuccess: (data: TaskGroupResult, _taskId: string, ctx: TaskGroupContext | undefined) =>
      reconcileGroup(deps, ctx?.optimisticUnread ?? 0, data?.unreadAffected),
  }
}

// ── Mark all read (this module only) ───────────────────────────────────────

export function markAllReadOptions(deps: NotificationMutationDeps) {
  return {
    mutationKey: ['notifications', 'mark-all-read'] as const,
    mutationFn: async (): Promise<MarkReadResult> => {
      const res = await doFetch(deps)('/api/notifications/mark-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true, category: deps.category }),
      })
      if (!res.ok) throw new Error(await readApiError(res, 'Could not mark all as read'))
      return (await res.json().catch(() => ({ success: true }))) as MarkReadResult
    },
    onMutate: async (): Promise<OptimisticContext> => {
      const snapshot = await beginOptimistic(deps)
      const now = new Date().toISOString()
      deps.qc.setQueryData<Notification[]>(notificationKeys.list(deps.category), old =>
        (old ?? []).map(n => (n.is_read ? n : { ...n, is_read: true, read_at: now })))
      setUnreadCount(deps.qc, deps.category, 0)
      return { snapshot }
    },
    onError: (err: unknown, _v: void, ctx: OptimisticContext | undefined) =>
      rollback(deps, ctx, err, 'Could not mark all notifications as read.'),
    onSuccess: () => reconcile(deps),
  }
}

// ── Duplicate-submission guard ─────────────────────────────────────────────

export type PendingGuard = {
  /** Returns false if `id` is already in flight — the caller must then do nothing. */
  tryAcquire: (id: string) => boolean
  release: (id: string) => void
  has: (id: string) => boolean
  snapshot: () => Set<string>
  size: () => number
}

/**
 * Synchronous per-id lock for deletes.
 *
 * Synchronous matters: a double-click delivers both events before React has
 * re-rendered the button as disabled, so a state-based guard alone would let
 * the second click through. `tryAcquire` claims the id in the same tick as the
 * first click, and the second one is rejected outright.
 */
export function createPendingGuard(): PendingGuard {
  const ids = new Set<string>()
  return {
    tryAcquire: (id: string) => {
      if (ids.has(id)) return false
      ids.add(id)
      return true
    },
    release: (id: string) => { ids.delete(id) },
    has:      (id: string) => ids.has(id),
    snapshot: () => new Set(ids),
    size:     () => ids.size,
  }
}
