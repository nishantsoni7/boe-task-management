// The SERVER-ONLY half of task-assignment notifications.
//
// ── DO NOT IMPORT THIS FROM A CLIENT COMPONENT ───────────────────────────────
//
// It exists to run with the service-role credential, which is the only client
// that may write a notifications row addressed to somebody else. Nothing here
// is useful in a browser and nothing here is safe to invite into one. The
// `.server.ts` suffix says so in the filename; the import graph is checked in
// src/lib/tasks/assignmentServerBoundary.test.ts, which fails if this module is
// reachable from any 'use client' file through any depth of import.
//
// The browser's half is ./assignmentNotification.ts — payload shape, shared
// names, and the fetch that asks this code to run. This module imports THAT
// one; the reverse direction is what the boundary test forbids.
//
// `import 'server-only'` is deliberately NOT used: the package is not installed
// (Next.js carries it as a build-time devDependency, not a resolvable one), no
// module in this repository uses it, and the established mechanism here is the
// import-graph test — see src/lib/supabase/adminClient.test.ts, which has
// guarded the credential this way since the admin helper was centralised.
// Adding a second mechanism for one module would weaken the first by making it
// look optional.

import { insertUserNotifications } from '@/lib/notificationWrites'
import type { NotificationInsert } from '@/lib/notificationWrites'
import { findTaskCreationActivityId } from '@/lib/notifications/activityLink'
import {
  buildTaskAssignmentNotification,
  TASK_ASSIGNMENT_NOTIFICATION_TYPE,
  type AssignmentNotificationOutcome,
} from './assignmentNotification'

// ─── The trusted server-side operation ───────────────────────────────────────

/** Only the columns the operation reads. Nothing else about the task is used. */
export type AssignmentTaskRow = {
  id: string
  title: string | null
  assigned_to: string | null
  created_by: string | null
}

/**
 * The four things the operation needs from the database, named as an interface
 * so the rule can be tested without modelling PostgREST's builder chain.
 * `supabaseAssignmentStore` below is the only real implementation.
 */
export type AssignmentNotificationStore = {
  /**
   * The task's `action = 'created'` activity row, or null when it has none.
   *
   * RE-DERIVED, NOT REMEMBERED. This is what makes assignment retry safe: the
   * route looks the id up from the task each time rather than being handed one,
   * so a retry after a partial failure links to the SAME activity row, creates
   * no second one, and needs nothing carried across the failure. Null is a real
   * answer — a copied task records `task_copied`, not `created` — and produces
   * an unlinked notification with the historical fallbacks.
   */
  findCreationActivityId(taskId: string): Promise<string | null>
  fetchTask(taskId: string): Promise<{ task: AssignmentTaskRow | null; error: { message: string } | null }>
  isAdmin(userId: string): Promise<boolean>
  /**
   * `readable: false` means the lookup itself failed — which tells us nothing
   * about what exists. See the duplicate note in the operation.
   */
  hasAssignmentNotification(taskId: string, recipientId: string): Promise<{ exists: boolean; readable: boolean }>
  /** Rows as the shared guard hands them over — always the deliverable ones. */
  insert(rows: NotificationInsert[]): Promise<{ error: { message: string } | null }>
}

/**
 * Create the assignment notification for one task, on behalf of one caller.
 *
 * AUTHORIZATION. The caller must be the task's creator, or an admin. That is
 * the same rule /api/cancel-task applies to a task-scoped action, and it is
 * what stops one authenticated user causing a notification about somebody
 * else's task. The task id is the ONLY thing the caller supplies.
 *
 * RECIPIENT. `tasks.assigned_to`, read from the stored row. Never the caller's
 * word for it.
 *
 * SELF-TASK. Skipped when the task's assignee IS its creator. Note the rule is
 * about the TASK (assigned_to === created_by), not about the caller: a task
 * somebody else assigned to you is still a notification you should get, even if
 * an admin is the one triggering this call.
 *
 * IDEMPOTENCY — WHAT IS AND IS NOT GUARANTEED.
 *
 * THIS IS NOT FULLY IDEMPOTENT. It is a SELECT followed by an INSERT with
 * nothing between them, so the guarantee has a precise shape and it is smaller
 * than the word "idempotent" implies. Stated plainly so nobody has to infer it:
 *
 *   WHAT IT PREVENTS. Sequential duplicates — the ordinary case, and every case
 *   this feature actually produces. A retry after a lost response, a second
 *   press of the Retry button, the copy route notifying in-process followed by
 *   a browser retry: each of those reads the row the previous one wrote and
 *   returns `skipped_duplicate` without writing.
 *
 *   WHAT IT DOES NOT PREVENT. Concurrent duplicates. Two requests that overlap
 *   can both read "none" and both insert, and the result is two identical
 *   notifications for one assignment. Nothing here serialises them: there is no
 *   lock, no upsert and no constraint.
 *
 *   WHY THAT IS ACCEPTED, FOR NOW. A duplicate notification is a visible,
 *   harmless annoyance. A missing one is the defect this whole change exists to
 *   fix — an assignee given work and never told. Given a choice between the two
 *   failure modes under concurrency, this takes the duplicate.
 *
 *   WHAT WOULD CLOSE IT. A partial unique index —
 *     create unique index ... on notifications (user_id, task_id)
 *       where type = 'task_assigned';
 *   plus an `on conflict do nothing` insert. That is a MIGRATION and is
 *   deliberately NOT part of this hotfix; it is recorded for a separate
 *   decision, because it also has to answer what to do about any duplicate rows
 *   already in production, which the index would refuse to be created over.
 *
 * The identity itself is stronger than the repository's other dedup: a task is
 * assigned once, so ANY existing `task_assigned` row for (task, recipient) is a
 * repeat however old — no time window, where /api/finance/notify uses two
 * minutes.
 *
 * AN EXISTING ROW IS SUCCESS. `skipped_duplicate` carries HTTP 200 and every
 * caller treats it as notified. It is never reported as an error, because
 * nothing is wrong: the assignee has their notification.
 *
 * A FAILED DUPLICATE CHECK DOES NOT BLOCK THE WRITE. Same direction
 * /api/finance/notify takes: a read that errored tells us nothing about what
 * exists, and a missing notification is worse than a duplicated one.
 */
export async function createAssignmentNotification(
  store: AssignmentNotificationStore,
  args: { taskId: string; callerId: string },
): Promise<AssignmentNotificationOutcome> {
  const { taskId, callerId } = args
  if (!taskId || !callerId) return { status: 'forbidden' }

  const { task, error: fetchError } = await store.fetchTask(taskId)
  if (fetchError) return { status: 'error', message: fetchError.message }
  if (!task) return { status: 'not_found' }

  const isCreator = task.created_by != null && task.created_by === callerId
  if (!isCreator && !(await store.isAdmin(callerId))) return { status: 'forbidden' }

  if (!task.assigned_to) return { status: 'skipped_self' }
  if (task.assigned_to === task.created_by) return { status: 'skipped_self' }

  const dup = await store.hasAssignmentNotification(task.id, task.assigned_to)
  if (dup.readable && dup.exists) return { status: 'skipped_duplicate' }

  // Looked up BEFORE the write and never after: an id resolved afterwards
  // could only be found by matching a timestamp, which is exactly what
  // 20261016000000 exists to avoid.
  const activityLogId = await store.findCreationActivityId(task.id)

  const row = buildTaskAssignmentNotification({
    assigneeId: task.assigned_to,
    // The creator is who caused the assignment; the caller may be an admin
    // acting for them. Passing the creator keeps the self-check inside the
    // builder consistent with the one above.
    actorId:    task.created_by,
    taskId:     task.id,
    taskTitle:  task.title ?? '',
    activityLogId,
  })
  if (!row) return { status: 'skipped_self' }

  // Still through the ONE centralized guard, so a system type could never
  // reach `notifications` down this path either. The store is adapted to the
  // guard's client shape rather than the other way round: the operation owns a
  // named port, not a Supabase builder.
  // The actor is the CREATOR, not `callerId`: an admin may be triggering this
  // on somebody else's behalf, and a task somebody else assigned to you is
  // still a notification you should get. Same reasoning as `actorId` above.
  const { error } = await insertUserNotifications(
    { from: () => ({ insert: store.insert }) }, row, { actorId: task.created_by })
  if (error) return { status: 'error', message: error.message }
  return { status: 'created' }
}

/** Minimal shape of the service-role Supabase client this adapter needs. */
type ServiceClient = {
  from: (table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    select: (columns: string) => any
    insert: (rows: NotificationInsert[]) => PromiseLike<{ error: { message: string } | null }>
  }
}

/**
 * Bind the operation to a real service-role client.
 *
 * SERVICE ROLE IS THE POINT, not an optimisation: it is the only client that
 * may write a notifications row addressed to somebody else. The route that
 * builds it authenticates the caller first, and this operation authorizes them
 * against the stored task, so the elevated key is never reachable without both.
 */
export function supabaseAssignmentStore(client: ServiceClient): AssignmentNotificationStore {
  return {
    async fetchTask(taskId) {
      const { data, error } = await client
        .from('tasks')
        .select('id, title, assigned_to, created_by')
        .eq('id', taskId)
        .maybeSingle()
      return { task: (data as AssignmentTaskRow | null) ?? null, error: error ?? null }
    },
    async isAdmin(userId) {
      const { data } = await client
        .from('users')
        .select('role')
        .eq('id', userId)
        .maybeSingle()
      return (data as { role?: string } | null)?.role === 'admin'
    },
    async hasAssignmentNotification(taskId, recipientId) {
      const { data, error } = await client
        .from('notifications')
        .select('id')
        .eq('task_id', taskId)
        .eq('user_id', recipientId)
        .eq('type', TASK_ASSIGNMENT_NOTIFICATION_TYPE)
        .limit(1)
      if (error) return { exists: false, readable: false }
      return { exists: (data ?? []).length > 0, readable: true }
    },
    async findCreationActivityId(taskId) {
      return findTaskCreationActivityId(client, taskId)
    },
    async insert(rows) {
      const { error } = await client.from('notifications').insert(rows)
      return { error: error ?? null }
    },
  }
}

