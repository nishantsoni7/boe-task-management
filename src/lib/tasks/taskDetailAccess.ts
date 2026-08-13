// Who may post an update, who may complete a task, and — since the creator
// approval workflow — who may submit, approve or return one.
//
// These gates are pulled out of the JSX so they can be asserted directly: the
// rules about who closes a task are the ones most expensive to get wrong, and
// they are now relationship-dependent rather than a single "assignee decides".
//
// Every function here is a DISPLAY gate. The database is the enforcement
// boundary — `transition_task_review()` re-derives each of these rules from the
// locked task row (20260833000000_task_creator_approval.sql), and
// `tasks_enforce_review_path` refuses a delegated ordinary task that tries to
// reach `completed` or `pending_approval` any other way
// (20260834000000_task_creator_approval_enforcement.sql). Nothing here grants
// anything the server would refuse.
//
// The two migrations ship in that order with the frontend deployed BETWEEN
// them, so there is a window in which the RPC exists and the trigger does not.
// These gates are what keep the new frontend off the direct-completion path
// during that window — the database is not yet refusing it.

export type TaskAccessSubject = {
  assigned_to: string | null
  created_by: string | null
  status: string
  acknowledged_at: string | null
  task_type?: string | null
}

/** The review action names `transition_task_review(task_id, action, note)` accepts. */
export type TaskReviewAction = 'submit' | 'approve' | 'return'

/** Mirrors the ceiling the RPC enforces on a return reason. */
export const RETURN_REASON_MAX_LENGTH = 1000

/**
 * The statuses a task can be submitted for approval FROM — exactly the ones
 * Mark Complete used to be offered from, so no work becomes unfinishable.
 */
const SUBMITTABLE_STATUSES = new Set(['pending', 'started', 'working', 'waiting', 'blocked'])

const isFinished = (task: TaskAccessSubject) =>
  task.status === 'completed' || task.status === 'cancelled'

const isQuotation = (task: TaskAccessSubject) => task.task_type === 'quotation_request'

/**
 * A task one person created for someone else. Both ids must be present and
 * different — an unassigned or self-assigned task is not a delegation.
 */
export function isDelegatedTask(task: TaskAccessSubject): boolean {
  return (
    !!task.assigned_to &&
    !!task.created_by &&
    task.assigned_to !== task.created_by
  )
}

/**
 * The tasks this workflow governs: delegated AND ordinary. A self task has
 * nobody to approve to; a quotation request keeps its own completion workflow.
 */
export function needsCreatorApproval(task: TaskAccessSubject): boolean {
  return isDelegatedTask(task) && !isQuotation(task)
}

/**
 * The update composer is shown to the two people in the conversation — the
 * assignee and the creator (who may be a delegator) — while the task is still
 * live. Nobody else gets a composer, not even an admin.
 *
 * A task awaiting approval is still live, on purpose: the correction that
 * follows a return usually starts as a conversation before it starts as work.
 */
export function canPostUpdate(task: TaskAccessSubject, userId: string): boolean {
  const isAssignee = task.assigned_to === userId
  const isCreator  = task.created_by  === userId
  return (isAssignee || isCreator) && !isFinished(task)
}

/**
 * Direct completion — the assignee closing the task themselves, in one click.
 *
 * Unchanged for a self task and for a quotation request. Withdrawn for a
 * delegated ordinary task: that one now goes assignee → creator, and the
 * assignee's button becomes Submit for Approval (see canSubmitForApproval).
 */
export function canMarkComplete(task: TaskAccessSubject, userId: string): boolean {
  const isAssignee = task.assigned_to === userId
  if (!isAssignee || isFinished(task)) return false
  if (needsCreatorApproval(task)) return false

  const isSelfTask     = task.created_by === userId
  const needsAckFirst  =
    !isSelfTask &&
    !task.acknowledged_at &&
    !isQuotation(task)
  return !needsAckFirst
}

/**
 * The assignee handing finished work to the creator. Requires acknowledgement
 * for the same reason completion used to: the record of finished work should
 * always follow an accepted assignment.
 */
export function canSubmitForApproval(task: TaskAccessSubject, userId: string): boolean {
  if (!needsCreatorApproval(task)) return false
  if (task.assigned_to !== userId) return false
  if (!task.acknowledged_at) return false
  return SUBMITTABLE_STATUSES.has(task.status)
}

/** The creator accepting the work. Only from pending_approval, only once. */
export function canApproveTask(task: TaskAccessSubject, userId: string): boolean {
  if (!needsCreatorApproval(task)) return false
  if (task.created_by !== userId) return false
  return task.status === 'pending_approval'
}

/**
 * The creator sending it back. Same window as approval — the two are the halves
 * of one decision, and neither is available once that decision is made.
 */
export function canReturnTask(task: TaskAccessSubject, userId: string): boolean {
  return canApproveTask(task, userId)
}
