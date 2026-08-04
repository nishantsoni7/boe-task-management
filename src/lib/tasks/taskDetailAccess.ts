// Who may post an update, and who may mark a task complete.
//
// These two rules gate the interactions this module's performance work touches,
// so they are pulled out of the JSX to be asserted directly — the optimisation
// must not widen who can do either. The logic is UNCHANGED from the inline
// conditions it replaces; this is the same predicate, in a place a test can
// reach it. Every other visibility rule on the task-detail page stays inline.
//
// Both are display gates. The database's RLS policies remain the enforcement
// boundary — nothing here grants anything the server would refuse.

export type TaskAccessSubject = {
  assigned_to: string | null
  created_by: string | null
  status: string
  acknowledged_at: string | null
  task_type?: string | null
}

const isFinished = (task: TaskAccessSubject) =>
  task.status === 'completed' || task.status === 'cancelled'

/**
 * The update composer is shown to the two people in the conversation — the
 * assignee and the creator (who may be a delegator) — while the task is still
 * live. Nobody else gets a composer, not even an admin.
 */
export function canPostUpdate(task: TaskAccessSubject, userId: string): boolean {
  const isAssignee = task.assigned_to === userId
  const isCreator  = task.created_by === userId
  return (isAssignee || isCreator) && !isFinished(task)
}

/**
 * Only the assignee completes a task — a delegator cannot close it on the
 * assignee's behalf — and an assigned task must be acknowledged first, so the
 * completion record always follows an accepted assignment. A self-assigned task
 * and a quotation request skip the acknowledgement step, matching how they are
 * created.
 */
export function canMarkComplete(task: TaskAccessSubject, userId: string): boolean {
  const isAssignee = task.assigned_to === userId
  if (!isAssignee || isFinished(task)) return false

  const isSelfTask     = task.created_by === userId
  const needsAckFirst  =
    !isSelfTask &&
    !task.acknowledged_at &&
    task.task_type !== 'quotation_request'
  return !needsAckFirst
}
