// The two facts about the creator-approval workflow that live OUTSIDE the
// task-detail screen: what a reopened task goes back to, and what the three
// notifications are called.
//
// Both are contracts with code that cannot import the other side —
// /api/restore-task runs on the server with the service role, and the
// notification titles are composed inside
// supabase/migrations/20260833000000_task_creator_approval.sql. They are stated
// here so a test can hold them still.

/**
 * Where /api/restore-task sends a reopened task.
 *
 * Restore has always returned a task to the status it held immediately before
 * it was closed, read back from the activity log. For a task closed by creator
 * approval that status is `pending_approval` — and restoring INTO the approval
 * queue would be wrong twice over: the creator would be asked to approve work
 * they have just reopened, and the assignee would have no way to touch the task
 * they were reopened to fix.
 *
 * A reopened task goes to `working` instead. It is back with the assignee, and
 * the approval it already had is spent — the corrected work is submitted again
 * and approved again, which is the whole point of reopening it.
 *
 * Every other status restores exactly as before.
 */
export function restoreTargetStatus(previousStatus: string | null | undefined): string {
  if (!previousStatus) return 'working'
  if (previousStatus === 'pending_approval') return 'working'
  return previousStatus
}

/**
 * The three notification titles the RPC writes, with the actor's display name
 * in front. Task Management notifications are whitelisted into the feed by
 * TITLE (see src/lib/notifications.ts), so these strings are load-bearing: a
 * reworded title that no longer matches the filter is a notification nobody can
 * see. The suffixes are asserted against both the filter and the migration.
 */
export const TASK_REVIEW_NOTIFICATION_SUFFIXES = {
  submit:  'submitted task for approval',
  approve: 'approved and completed task',
  return:  'returned task to Working',
} as const

/**
 * Performance overdue responsibility rule.
 *
 * An overdue penalty may apply to an employee only while they still own an
 * actionable, unfinished obligation. The moment an assignee submits a task
 * for approval it stops accruing overdue responsibility against them, same
 * as `completed`/`cancelled` — the task is still open operationally (shown
 * as Pending/Approval Pending, see `taskStatusLabel` in lib/ui.ts), but the
 * outstanding action is a review, not work, and belongs to the creator. If
 * the creator returns the task (`restoreTargetStatus` above sends it back to
 * `working`), normal overdue accountability resumes from that point.
 *
 * This is the single source of truth for "can this task still accrue
 * overdue against its assignee" — every overdue calculation (current-day
 * portfolio counts, the historical per-day risk reconstruction in
 * lib/performance.ts, and the My Tasks overdue views) must go through it so
 * they cannot independently drift out of agreement with each other.
 */
export const NON_ACCRUING_OVERDUE_STATUSES = new Set(['completed', 'cancelled', 'pending_approval'])

export function accruesAssigneeOverdue(status: string): boolean {
  return !NON_ACCRUING_OVERDUE_STATUSES.has(status)
}
