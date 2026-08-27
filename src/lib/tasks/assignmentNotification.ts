// The BROWSER-SAFE half of task-assignment notifications.
//
// Payload shape, the names both sides speak, and the request that asks the
// server to do the write. Nothing here touches a database, reads an
// environment variable, or imports a Supabase client — it is safe in a client
// bundle, and four 'use client' screens import it.
//
// The privileged half lives in ./assignmentNotificationWriter.server.ts and is
// NOT reachable from here. That direction is enforced, not merely intended:
// src/lib/tasks/assignmentServerBoundary.test.ts walks the import graph from
// every 'use client' file and fails if the writer, the admin client helper, or
// the raw credential is reachable through any depth of import.
//
// ── WHY THE SPLIT EXISTS ─────────────────────────────────────────────────────
//
// When this fix first landed, one module held both halves and four client
// components imported it. No secret leaked — the writer takes its client as an
// argument and names no environment variable, and the production bundle was
// checked for its SELECT literal and did not contain it. But the only thing
// keeping it out was TREE-SHAKING, which is a build-time optimisation and not a
// boundary: one added type-and-value import, or a barrel re-export, and
// privileged code would ride into the browser with nothing failing to say so.
//
// A boundary you can see in the filename and that a test enforces is worth more
// than one a bundler happens to preserve.
//
// ── WHY THE ASSIGNMENT NOTIFICATION IS NOT WRITTEN FROM HERE ─────────────────
//
// It used to be, and it never worked. All four task-creation screens inserted
// the row in the browser, under the CREATOR's session, with `user_id` set to
// the ASSIGNEE. No client role may do that. The repository states the rule
// itself, as the first reason transition_task_review() is SECURITY DEFINER
// (20260833000000):
//
//   "the notification is addressed to the OTHER party, and no client role may
//    insert a notifications row for somebody else"
//
// The database refused every one of those inserts and the assignee was never
// told. Proven in production: the task row exists, its notification is NULL.

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
  /**
   * The task's creation activity row (20261016000000), when one exists.
   *
   * Supplied by the server-side writer, which re-derives it from the task on
   * every call — including a retry. Absent is normal and renders the fallbacks.
   */
  activityLogId?: string | null
}

/**
 * The row to insert, or `null` when nobody should be notified.
 *
 * `null` is the self-assignment case and is a normal outcome, not an error.
 */
export function buildTaskAssignmentNotification(
  input: TaskAssignmentInput,
): NotificationInsert | null {
  const { assigneeId, actorId, taskId, taskTitle, title, activityLogId } = input
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
    activity_log_id: activityLogId ?? null,
  }
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

// ─── The browser's side of the boundary ──────────────────────────────────────

/**
 * The one sentence every creation screen shows for outcome B.
 *
 * IT SAYS THE TASK EXISTS, FIRST. A generic "Task creation failed" here would
 * be worse than saying nothing: the task IS created, so a user who believes
 * otherwise submits the form again and now there are two. The wording is fixed
 * and shared so no screen can drift into the dangerous phrasing.
 */
export const ASSIGNMENT_NOTIFICATION_FAILED_MESSAGE =
  'Task created, but the assignee notification could not be sent.'

/** Shown in place of the warning once a retry succeeds. */
export const ASSIGNMENT_NOTIFICATION_RECOVERED_MESSAGE =
  'Assignee notified.'

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
