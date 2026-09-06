'use client'

import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { NotificationCategory } from '@/lib/notifications'
import { useDisplaySubject } from '@/hooks/queries/useDisplaySubject'
import {
  deleteSingleOptions,
  deleteSelectedOptions,
  deleteAllOptions,
  markReadOptions,
  markManyReadOptions,
  markTaskGroupReadOptions,
  deleteTaskGroupOptions,
  markAllReadOptions,
  createPendingGuard,
  type NotificationMutationDeps,
} from '@/lib/notificationMutations'

// React binding for the notification mutations. All the cache logic —
// snapshot, optimistic write, rollback, narrow reconciliation — lives in
// src/lib/notificationMutations.ts and is covered directly by tests; this hook
// only owns React state: the error message, the pending-delete set, and the
// synchronous double-click guard.
//
// This replaces NotificationsView's hand-rolled `fetch().then()` mutations,
// which ignored non-2xx responses entirely: a failed delete left the row
// removed locally with no rollback and no error, so it silently reappeared on
// the next refetch. That was the "intermittent deletion" symptom.

export type NotificationMutations = {
  markRead: (id: string) => void
  /** Mark a known set read in ONE request — ids the caller already holds. */
  markManyRead: (ids: string[]) => void
  /** Mark EVERY notification for one task read, loaded or not. */
  markTaskGroupRead: (taskId: string) => void
  /** Delete EVERY notification for one task, loaded or not. Rows only. */
  deleteTaskGroup: (taskId: string) => void
  /** True while a complete-group action is in flight. */
  groupBusy: boolean
  /**
   * The task id of the group action in flight, or null.
   *
   * `groupBusy` still guards against a second concurrent group action — that
   * rule is unchanged. This exists so the LIST can disable one card instead of
   * re-rendering all of them: a page-wide boolean changes on every card's props
   * the moment any card is clicked, which is most of the cost the notifications
   * page was paying per interaction.
   */
  busyTaskId: string | null
  markAllRead: () => void
  deleteSingle: (id: string) => void
  deleteSelected: (ids: string[]) => void
  deleteAll: () => void
  /** Ids with a DELETE in flight — these rows render hidden and their buttons disabled. */
  pendingDeletes: ReadonlySet<string>
  markingAll: boolean
  deletingBulk: boolean
  deletingAll: boolean
  /** Last mutation failure, for the inline error banner. */
  error: string | null
  clearError: () => void
}

/** Every mutation this hook exposes, as a no-op. Returned while previewing. */
const NO_MUTATIONS: Omit<NotificationMutations, 'error' | 'clearError'> = {
  markRead: () => {},
  markManyRead: () => {},
  markTaskGroupRead: () => {},
  deleteTaskGroup: () => {},
  groupBusy: false,
  busyTaskId: null,
  markAllRead: () => {},
  deleteSingle: () => {},
  deleteSelected: () => {},
  deleteAll: () => {},
  pendingDeletes: new Set<string>(),
  markingAll: false,
  deletingBulk: false,
  deletingAll: false,
}

export function useNotificationMutations(category: NotificationCategory): NotificationMutations {
  const qc = useQueryClient()
  const { readOnly } = useDisplaySubject()

  const [error, setError] = useState<string | null>(null)
  const clearError = useCallback(() => setError(null), [])

  // Two views of the same set. `guard` is the authority, mutated synchronously
  // inside the click handler so a double-click is rejected before React can
  // re-render; `pendingDeletes` is the render-visible copy that disables and
  // hides the affected rows.
  //
  // Held in lazily-initialised state rather than a ref: the object is created
  // once and never replaced, so this is identical in behaviour, and it keeps
  // the guard out of ref-during-render territory. Mutating it never schedules
  // a render on its own — `syncPending` does that explicitly.
  const [guard] = useState(createPendingGuard)
  const [pendingDeletes, setPendingDeletes] = useState<ReadonlySet<string>>(() => new Set<string>())
  const syncPending = useCallback(() => setPendingDeletes(guard.snapshot()), [guard])

  const deps: NotificationMutationDeps = useMemo(() => ({
    qc,
    category,
    reportError: setError,
    readOnly,
    releasePending: (id: string) => {
      guard.release(id)
      syncPending()
    },
  }), [qc, category, guard, syncPending, readOnly])

  const deleteSingleMutation   = useMutation(deleteSingleOptions(deps))
  const deleteSelectedMutation = useMutation(deleteSelectedOptions(deps))
  const deleteAllMutation      = useMutation(deleteAllOptions(deps))
  const markReadMutation       = useMutation(markReadOptions(deps))
  const markManyReadMutation   = useMutation(markManyReadOptions(deps))
  const markTaskGroupMutation  = useMutation(markTaskGroupReadOptions(deps))
  const deleteTaskGroupMutation = useMutation(deleteTaskGroupOptions(deps))
  const markAllReadMutation    = useMutation(markAllReadOptions(deps))

  const deleteSingle = useCallback((id: string) => {
    // Rejected synchronously if this id is already in flight, so a rapid
    // double-click produces exactly one DELETE request.
    if (!guard.tryAcquire(id)) return
    syncPending()
    setError(null)
    deleteSingleMutation.mutate(id)
  }, [deleteSingleMutation, guard, syncPending])

  const deleteSelected = useCallback((ids: string[]) => {
    if (ids.length === 0 || deleteSelectedMutation.isPending) return
    setError(null)
    deleteSelectedMutation.mutate(ids)
  }, [deleteSelectedMutation])

  const deleteAll = useCallback(() => {
    if (deleteAllMutation.isPending) return
    setError(null)
    deleteAllMutation.mutate()
  }, [deleteAllMutation])

  const markRead = useCallback((id: string) => {
    markReadMutation.mutate(id)
  }, [markReadMutation])

  const markTaskGroupRead = useCallback((taskId: string) => {
    if (!taskId || markTaskGroupMutation.isPending) return
    setError(null)
    markTaskGroupMutation.mutate(taskId)
  }, [markTaskGroupMutation])

  const deleteTaskGroup = useCallback((taskId: string) => {
    if (!taskId || deleteTaskGroupMutation.isPending) return
    setError(null)
    deleteTaskGroupMutation.mutate(taskId)
  }, [deleteTaskGroupMutation])

  const markManyRead = useCallback((ids: string[]) => {
    // Nothing unread in the group, or one already in flight: the click is a
    // no-op rather than a redundant request that could double-patch the badge.
    if (ids.length === 0 || markManyReadMutation.isPending) return
    setError(null)
    markManyReadMutation.mutate(ids)
  }, [markManyReadMutation])

  const markAllRead = useCallback(() => {
    if (markAllReadMutation.isPending) return
    setError(null)
    markAllReadMutation.mutate()
  }, [markAllReadMutation])

  // ── WHILE PREVIEWING, NOTHING MUTATES ───────────────────────────────────────
  //
  // Returned as no-ops rather than as failing requests, deliberately. The
  // requirement is that opening a notification does not mark it read and that
  // Mark as read, delete and bulk delete do nothing — so there must be no
  // optimistic write, no request and no error banner, because all three are
  // things "nothing happened" is not.
  //
  // WHOSE STATE WAS AT RISK. Not the employee's: every notification endpoint
  // scopes its write to `user_id = <the token's own user>` and none accepts a
  // user id from the client, so an admin previewing Dhruv could never have
  // marked DHRUV's notification read — the audit-integrity half was already
  // structurally safe. What this prevents is the admin silently mutating THEIR
  // OWN inbox by clicking a control that, by design, looks like the employee's.
  //
  // The server refuses the same requests independently — see
  // isPreviewRequest in src/lib/viewAs.ts and the guards in the four
  // /api/notifications routes. This is the UX half; that is the boundary.
  //
  // `error` and `clearError` stay real so the banner still clears if one was
  // showing when View As was entered.
  if (readOnly) return { ...NO_MUTATIONS, error, clearError }

  return {
    markRead,
    markManyRead,
    markTaskGroupRead,
    deleteTaskGroup,
    groupBusy: markTaskGroupMutation.isPending || deleteTaskGroupMutation.isPending,
    busyTaskId:
      (markTaskGroupMutation.isPending ? markTaskGroupMutation.variables ?? null : null) ??
      (deleteTaskGroupMutation.isPending ? deleteTaskGroupMutation.variables ?? null : null),
    markAllRead,
    deleteSingle,
    deleteSelected,
    deleteAll,
    pendingDeletes,
    markingAll:   markAllReadMutation.isPending,
    deletingBulk: deleteSelectedMutation.isPending,
    deletingAll:  deleteAllMutation.isPending,
    error,
    clearError,
  }
}
