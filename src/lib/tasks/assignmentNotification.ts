// The ONE place a "you have been given a task" notification is built.
//
// WHY THIS EXISTS. Four call sites create a task and notify its assignee —
// tasks/create, tasks/assigned-by-me, MeetingTaskModal and
// tasks/quotation-requests/new — plus /api/tasks/[id]/copy on the server. Each
// had its own inline object literal, so the recipient rule, the type, the
// column set and the push flag were decided five times over. Two of those
// decisions were wrong in the same way in every copy (see below), and nothing
// could assert the rule because there was no rule to assert — only five
// literals that happened to agree.
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
import type { NotificationInsert, NotificationInsertClient } from '@/lib/notificationWrites'

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

/**
 * Build and insert the assignment row, through the shared system-type guard.
 *
 * Returns the same `{ error }` shape a raw PostgREST insert returns, so the
 * call sites keep destructuring it out of their existing `Promise.all`, and
 * `{ skipped: true }` when the recipient rule said not to notify. A skip is a
 * success with `error: null` — the task was created, and there was nobody to
 * tell.
 */
export async function notifyTaskAssignment(
  client: NotificationInsertClient,
  input: TaskAssignmentInput,
): Promise<{ error: { message: string } | null; skipped: boolean }> {
  const row = buildTaskAssignmentNotification(input)
  if (!row) return { error: null, skipped: true }
  const { error } = await insertUserNotifications(client, row)
  return { error, skipped: false }
}
