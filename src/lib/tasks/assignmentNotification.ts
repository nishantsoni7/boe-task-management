// The ONE place a "you have been given a task" notification is built — and,
// since the production trace, the one place it is WRITTEN.
//
// WHY A SERVER BOUNDARY IS THE FIX, AND A SHARED BUILDER WAS NOT.
//
// The four browser task creators inserted this row themselves, under the
// CREATOR's session, with `user_id` set to the ASSIGNEE. No client role may do
// that. The repository states the rule itself, in the header of
// 20260833000000_task_creator_approval.sql, as the FIRST reason that function is
// SECURITY DEFINER:
//
//   "the notification is addressed to the OTHER party, and no client role may
//    insert a notifications row for somebody else"
//
// So the insert was refused by the database, and the task was created with
// nobody told. A production query for the reported task returned the task row
// and a NULL notification: never written, not written-and-hidden.
//
// Standardising the payload — the first pass at this fix — changed WHAT was
// being written. It did not change WHO was writing it, so it could not have
// helped on its own. The write authority had to move.
//
// Every other cross-user notification in this repository already sits behind a
// server boundary: /api/notify-status-update, /api/cancel-task,
// /api/restore-task, /api/tasks/[id]/copy and /api/finance|orders|assets/notify
// all build a service-role client, and transition_task_review() is SECURITY
// DEFINER. The assignment paths were the only ones that did not.
//
// NOTHING IS TAKEN FROM THE CALLER BUT A TASK ID. Recipient, task title, type,
// body and the push flag are all derived from the stored task row.
//
// WHY THIS EXISTS. Five call sites create a task and notify its assignee —
// tasks/create, tasks/assigned-by-me, MeetingTaskModal,
// tasks/quotation-requests/new and /api/tasks/[id]/copy. Each had its own
// inline object literal, so the recipient rule, the type, the column set and
// the push flag were decided five times over — and four of them were issuing
// the write from a browser, where it could not succeed.
//
// THE RECIPIENT RULE. The assignee, and only when the assignee is not the
// person doing the assigning. Notifying yourself about your own action is the
// one rule every other task notification path already follows —
// /api/notify-status-update returns `{ skipped: true }` when actor === recipient,
// /api/cancel-task and /api/restore-task both guard `recipient !== user.id`,
// and transition_task_review() guards `v_recipient <> v_uid`. The assignment
// paths did not, so creating a task for yourself put an unread badge on your own
// screen for something you had just done. A self-task is created in `working`
// with `acknowledged_at` already set — there is nothing to tell the assignee.
//
// `is_push_sent` IS NOT A RECEIPT. Every call site set it `true` at insert
// time, which reads as "a push notification has been delivered for this row".
// Nothing delivers one: there is no push transport in this repository, no
// service worker and no subscription store, and nothing reads the column. The
// honest value at insert time is `false` — the in-app row exists, no push has
// been sent — and that is what a transport added later would need in order to
// find the backlog. The same overstatement exists on other modules' rows and
// inside transition_task_review(); correcting those needs a migration and a
// decision about the historical rows, so it is deliberately not done here.

import { insertUserNotifications } from '@/lib/notificationWrites'
import type { NotificationInsert } from '@/lib/notificationWrites'

/** The enum value every assignment row carries. */
export const TASK_ASSIGNMENT_NOTIFICATION_TYPE = 'task_assigned'

/** Default headline. The task's own title travels in `body`, never in here. */
export const TASK_ASSIGNMENT_TITLE = 'New task assigned to you'

export type TaskAssignmentInput = {
  /** Who the task was given to. */
  assigneeId: string
  /** Who did the assigning — the signed-in user. */
  actorId: string | null | undefined
  /** The task that was just created. Never null: it is what puts the row in the Task feed. */
  taskId: string
  /** The task's title. Becomes `body`, which is what the grouped card heads with. */
  taskTitle: string
  /** Overrides the headline (quotation requests say "New quotation request"). */
  title?: string
}

/**
 * The row to insert, or `null` when nobody should be notified.
 *
 * `null` is the self-assignment case and is a normal outcome, not an error.
 */
export function buildTaskAssignmentNotification(
  input: TaskAssignmentInput,
): NotificationInsert | null {
  const { assigneeId, actorId, taskId, taskTitle, title } = input
  if (!assigneeId || !taskId) return null
  if (actorId && assigneeId === actorId) return null
  return {
    user_id:      assigneeId,
    task_id:      taskId,
    type:         TASK_ASSIGNMENT_NOTIFICATION_TYPE,
    title:        title?.trim() || TASK_ASSIGNMENT_TITLE,
    body:         taskTitle,
    // See the header: no push transport exists, so nothing has been sent.
    is_push_sent: false,
  }
}

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

export type AssignmentNotificationOutcome =
  | { status: 'created' }
  /** The task is assigned to the person who created it — nobody to tell. */
  | { status: 'skipped_self' }
  /** An assignment notification for this task already exists. */
  | { status: 'skipped_duplicate' }
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'error'; message: string }

/** HTTP status for each outcome. Skips are successes: nothing needed doing. */
export const ASSIGNMENT_OUTCOME_STATUS: Record<AssignmentNotificationOutcome['status'], number> = {
  created:           200,
  skipped_self:      200,
  skipped_duplicate: 200,
  not_found:         404,
  forbidden:         403,
  error:             500,
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
 * IDEMPOTENCY, AND ITS LIMIT. A task is assigned once, so ANY existing
 * `task_assigned` row for (task, recipient) makes this a repeat — no time
 * window is needed, which makes this strictly stronger than the two-minute
 * window /api/finance/notify uses. It is a read followed by a write, so it is
 * NOT concurrency-safe: two simultaneous calls can both read "none" and both
 * insert. Closing that needs a unique index on
 * (user_id, task_id) where type = 'task_assigned' — a migration, deliberately
 * not added here. In practice the calls are sequential (one per task creation,
 * plus at most one retry from the same browser), and a duplicate row is a
 * cosmetic fault while a missing one is the bug being fixed.
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

  const row = buildTaskAssignmentNotification({
    assigneeId: task.assigned_to,
    // The creator is who caused the assignment; the caller may be an admin
    // acting for them. Passing the creator keeps the self-check inside the
    // builder consistent with the one above.
    actorId:    task.created_by,
    taskId:     task.id,
    taskTitle:  task.title ?? '',
  })
  if (!row) return { status: 'skipped_self' }

  // Still through the ONE centralized guard, so a system type could never
  // reach `notifications` down this path either. The store is adapted to the
  // guard's client shape rather than the other way round: the operation owns a
  // named port, not a Supabase builder.
  const { error } = await insertUserNotifications(
    { from: () => ({ insert: store.insert }) }, row)
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
    async insert(rows) {
      const { error } = await client.from('notifications').insert(rows)
      return { error: error ?? null }
    },
  }
}

// ─── The browser's side of the boundary ──────────────────────────────────────

export const ASSIGNMENT_NOTIFICATION_FAILED_MESSAGE =
  'Task created, but the assignee could not be notified. Please tell them directly.'

export type AssignmentNotificationRequest =
  | { ok: true; status: 'created' | 'skipped_self' | 'skipped_duplicate' }
  | { ok: false; reason: string }

/**
 * Ask the server to create the assignment notification for a task.
 *
 * ONE RETRY, AND ONLY WHERE ONE CAN HELP. A transport failure or a 5xx may be
 * transient, and the route is idempotent, so a single retry is safe and worth
 * making. A 4xx is a decision — unauthenticated, not your task, bad id — and
 * repeating it would only be noise.
 *
 * THE RESULT IS NOT ADVISORY. `ok: false` means the assignee has not been told,
 * and every caller turns it into something the person who created the task can
 * see. A console line is not a report: nobody creating a task is watching the
 * developer console, which is exactly how this defect survived in production.
 */
export async function requestAssignmentNotification(
  taskId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AssignmentNotificationRequest> {
  const attempt = async (): Promise<{ retryable: boolean; result: AssignmentNotificationRequest }> => {
    try {
      const res = await fetchImpl(`/api/tasks/${taskId}/notify-assignment`, { method: 'POST' })
      if (res.ok) {
        const body = await res.json().catch(() => ({})) as { status?: string }
        const status = body.status
        if (status === 'created' || status === 'skipped_self' || status === 'skipped_duplicate') {
          return { retryable: false, result: { ok: true, status } }
        }
        // A 200 without a status we recognise is not a notification we can
        // claim was created.
        return { retryable: false, result: { ok: false, reason: 'unexpected response' } }
      }
      return {
        retryable: res.status >= 500,
        result: { ok: false, reason: `HTTP ${res.status}` },
      }
    } catch (err) {
      return {
        retryable: true,
        result: { ok: false, reason: err instanceof Error ? err.message : 'request failed' },
      }
    }
  }

  const first = await attempt()
  if (first.result.ok || !first.retryable) return first.result
  return (await attempt()).result
}
