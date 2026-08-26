// The ONE place that decides which My Tasks tab a task belongs to.
//
// WHY THIS FILE EXISTS. The rules below used to live inline in
// src/app/tasks/my/page.tsx, mixed into a 1700-line component, and they
// disagreed with themselves about `pending_approval`:
//
//   · the three *_actionable tabs excluded it (via accruesAssigneeOverdue),
//   · `waiting_blocked` and `action_required` excluded it by naming statuses,
//   · but `all` — which is what the sidebar's "My Tasks → In Progress" entry
//     actually opens — included it, and so did `important` and `needs_update`.
//
// So a task the assignee had already submitted for approval kept sitting in
// their working list with no action they could take on it. Extracting the
// rules here makes that a single decision instead of thirteen, and makes it
// directly testable without rendering the page.
//
// PURITY. Every function takes the clock ("today", "now") as an argument
// rather than reading it. The page passes the values it computes at module
// load, exactly as before; tests pass fixed ones.

import type { Task } from '@/lib/types'
import { accruesAssigneeOverdue } from '@/lib/tasks/reviewTransitions'

/** The status a delegated task holds between "assignee submitted" and "creator decided". */
export const AWAITING_APPROVAL_STATUS = 'pending_approval'

/**
 * What the assignee's own screens call that status.
 *
 * `taskStatusLabel(…, 'assignee')` says "Approval Pending" and is left alone —
 * it is asserted by reviewTransitions.test.ts and read by the task detail page.
 * This is My Tasks' tab-and-badge wording, kept as one constant so the tab
 * header and the row badge cannot drift apart.
 */
export const AWAITING_APPROVAL_LABEL = 'Awaiting Approval'

export type MyTaskTabKey =
  | 'today_actionable' | 'overdue_actionable' | 'future_actionable'
  | 'waiting_blocked'  | 'awaiting_approval'
  | 'action_required'  | 'all' | 'important' | 'unacknowledged'
  | 'in_progress'      | 'overdue' | 'needs_update' | 'non_completion' | 'completed'

export const MY_TASK_TAB_LABELS: Record<MyTaskTabKey, string> = {
  today_actionable:   'Today Actionable',
  overdue_actionable: 'Overdue Actionable',
  future_actionable:  'Future Actionable',
  waiting_blocked:    'Waiting / Blocked',
  awaiting_approval:  AWAITING_APPROVAL_LABEL,
  action_required:    'Action Required',
  all:                'All Tasks',
  important:          'Important',
  unacknowledged:     'Unacknowledged',
  in_progress:        'In Progress',
  overdue:            'Overdue',
  needs_update:       'Needs Update',
  non_completion:     'Non-Completion',
  completed:          'Completed',
}

export const MY_TASK_TAB_KEYS = Object.keys(MY_TASK_TAB_LABELS) as MyTaskTabKey[]

/**
 * Tabs that answer "what needs ME to do something".
 *
 * `awaiting_approval` is deliberately NOT one of them, and neither are the two
 * archival views. Everything listed here must be free of `pending_approval`
 * rows — asserted directly in myTaskTabs.test.ts, so adding a new working tab
 * without applying the rule fails the suite rather than shipping.
 */
export const ACTIVE_WORKING_TABS: readonly MyTaskTabKey[] = [
  'today_actionable', 'overdue_actionable', 'future_actionable',
  'waiting_blocked', 'action_required', 'all', 'important',
  'unacknowledged', 'in_progress', 'overdue', 'needs_update', 'non_completion',
]

/** A task the current user has finished and handed to its creator to review. */
export function isAwaitingApproval(task: Pick<Task, 'status'>): boolean {
  return task.status === AWAITING_APPROVAL_STATUS
}

/** Finished or abandoned — off everybody's plate. */
export function isClosed(task: Pick<Task, 'status'>): boolean {
  return task.status === 'completed' || task.status === 'cancelled'
}

/**
 * THE WORKLOAD RULE: open work that still needs THIS user.
 *
 * Exactly the membership test for the `all` tab, and exactly what the Task Type
 * sidebar counts. Both read it from here rather than restating the statuses,
 * so a count and the list it summarises cannot disagree.
 *
 * Together with isAwaitingApproval and isClosed this PARTITIONS a user's tasks:
 * every task is in exactly one of the three, so nothing can be counted twice
 * between the actionable workload and the Awaiting Approval badge, and nothing
 * can fall through the gap. myTaskTabs.test.ts asserts that directly.
 */
export function isActionableWorkload(task: Pick<Task, 'status'>): boolean {
  return !isClosed(task) && !isAwaitingApproval(task)
}

// ── Task Type (the left sidebar): whose task is it ───────────────────────────

/** Who created it, relative to the viewer. Orthogonal to status. */
export type MyTaskType = 'all' | 'self' | 'delegated'

export function matchesTaskType(
  task: Pick<Task, 'created_by'>,
  type: MyTaskType,
  userId: string,
): boolean {
  if (type === 'self')      return task.created_by === userId
  if (type === 'delegated') return task.created_by !== userId
  return true
}

/** The collection a chosen Task Type narrows to. Status is not considered here. */
export function filterByTaskType(tasks: Task[], type: MyTaskType, userId: string): Task[] {
  return type === 'all' ? tasks : tasks.filter(t => matchesTaskType(t, type, userId))
}

/**
 * The three Task Type sidebar counts.
 *
 * These count WORK REQUIRING THIS USER, so a task submitted for approval is not
 * in any of them — it is waiting on its creator, and the only badge that counts
 * it is the Awaiting Approval tab's. Before this, the sidebar counted every
 * non-closed task, so a submitted task was counted here AND in Awaiting
 * Approval while appearing in no working tab: a number nothing on screen added
 * up to.
 */
export function countTaskTypeWorkload(
  tasks: Task[],
  userId: string,
): Record<MyTaskType, number> {
  const counts: Record<MyTaskType, number> = { all: 0, self: 0, delegated: 0 }
  for (const task of tasks) {
    if (!isActionableWorkload(task)) continue
    counts.all += 1
    if (matchesTaskType(task, 'self', userId)) counts.self += 1
    else counts.delegated += 1
  }
  return counts
}

// ── Date helpers ─────────────────────────────────────────────────────────────

/** Local calendar date, `offsetDays` from today, as YYYY-MM-DD. */
export function localDateStr(offsetDays = 0, now: Date = new Date()): string {
  const d = new Date(now.getTime())
  d.setDate(d.getDate() + offsetDays)
  const yyyy = d.getFullYear()
  const mm   = String(d.getMonth() + 1).padStart(2, '0')
  const dd   = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/** Normalize any due_date format (plain YYYY-MM-DD or full ISO timestamp) to local YYYY-MM-DD. */
export function normalizeDueDate(raw: string | null | undefined): string | null {
  if (!raw) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const d = new Date(raw)
  if (isNaN(d.getTime())) return null
  return localDateStr(0, d)
}

/** Hours after which a task with no update is considered stale. */
export const NEEDS_UPDATE_MS = 48 * 60 * 60 * 1000

/**
 * Overdue against the ASSIGNEE.
 *
 * Routed through accruesAssigneeOverdue so this agrees, by construction, with
 * Performance scoring and the historical risk reconstruction: a task submitted
 * for approval stops being the assignee's overdue problem.
 */
export function isOverdue(task: Pick<Task, 'due_date' | 'status'>, todayStr: string): boolean {
  const d = normalizeDueDate(task.due_date)
  return !!d && d < todayStr && accruesAssigneeOverdue(task.status)
}

export function needsUpdate(task: Pick<Task, 'status' | 'last_update_at' | 'created_at'>, nowMs: number): boolean {
  if (task.status === 'completed' || task.status === 'cancelled') return false
  return nowMs - new Date(task.last_update_at ?? task.created_at).getTime() > NEEDS_UPDATE_MS
}

export function isUnacknowledged(task: Pick<Task, 'acknowledged_at' | 'status' | 'created_by' | 'assigned_to'>): boolean {
  return !task.acknowledged_at
    && task.status !== 'completed'
    && task.status !== 'cancelled'
    && task.created_by !== task.assigned_to
}

export function isNonCompletion(
  task: Pick<Task, 'due_date' | 'status' | 'last_update_at' | 'created_at'>,
  todayStr: string,
  nowMs: number,
): boolean {
  return isOverdue(task, todayStr) && needsUpdate(task, nowMs)
}

// ── Bucketing ────────────────────────────────────────────────────────────────

export type MyTaskClock = { todayStr: string; nowMs: number }

export type MyTaskBuckets = Record<MyTaskTabKey, Task[]>

const sortImportantFirst = (arr: Task[]): Task[] =>
  [...arr].sort((a, b) => (b.is_urgent ? 1 : 0) - (a.is_urgent ? 1 : 0))

/**
 * Split one already-fetched task collection into every tab.
 *
 * ONE pass over ONE collection: switching tabs is a lookup in this object, not
 * another request. That is what makes tab switching instant and why My Tasks
 * fetches the assignee's tasks exactly once per visit.
 *
 * THE APPROVAL RULE, stated once: a task in `pending_approval` is the
 * creator's move, not the assignee's, so it appears in `awaiting_approval` and
 * in NO active working tab. `completed` and `cancelled` are unaffected — they
 * were already excluded everywhere they mattered.
 */
export function buildMyTaskBuckets(tasks: Task[], clock: MyTaskClock): MyTaskBuckets {
  const { todayStr, nowMs } = clock

  // Still the assignee's move: not closed, not submitted for approval, and not
  // parked on somebody else.
  const isActiveActionable = (t: Task) =>
    accruesAssigneeOverdue(t.status) && t.status !== 'waiting' && t.status !== 'blocked'

  const dueOn = (t: Task) => normalizeDueDate(t.due_date)

  return {
    today_actionable: sortImportantFirst(tasks.filter(t =>
      isActiveActionable(t) && dueOn(t) === todayStr)),

    overdue_actionable: sortImportantFirst(tasks.filter(t => {
      const d = dueOn(t); return isActiveActionable(t) && !!d && d < todayStr
    })),

    future_actionable: sortImportantFirst(tasks.filter(t => {
      const d = dueOn(t); return isActiveActionable(t) && !!d && d > todayStr
    })),

    waiting_blocked: sortImportantFirst(tasks.filter(t =>
      t.status === 'waiting' || t.status === 'blocked')),

    // The new home for work that is finished and waiting on somebody else.
    awaiting_approval: sortImportantFirst(tasks.filter(isAwaitingApproval)),

    action_required: sortImportantFirst(tasks.filter(t =>
      t.status === 'pending' || t.status === 'started' || t.status === 'working')),

    // `all` is what the sidebar's "In Progress" entry opens, so this is the
    // exclusion that actually removes a submitted task from the working view.
    all:       sortImportantFirst(tasks.filter(isActionableWorkload)),
    important: sortImportantFirst(tasks.filter(t => t.is_urgent && isActionableWorkload(t))),

    unacknowledged: sortImportantFirst(tasks.filter(t => isUnacknowledged(t) && !isAwaitingApproval(t))),

    in_progress: sortImportantFirst(tasks.filter(t =>
      !isOverdue(t, todayStr) && t.status !== 'completed'
      && ['started', 'working', 'pending'].includes(t.status))),

    overdue:      sortImportantFirst(tasks.filter(t => isOverdue(t, todayStr))),
    needs_update: sortImportantFirst(tasks.filter(t => needsUpdate(t, nowMs) && !isAwaitingApproval(t))),
    non_completion: sortImportantFirst(tasks.filter(t => isNonCompletion(t, todayStr, nowMs))),

    completed: tasks.filter(t => t.status === 'completed'),
  }
}

/** Per-tab counts for the tab badges, from the same single pass. */
export function countMyTaskBuckets(buckets: MyTaskBuckets): Record<MyTaskTabKey, number> {
  const out = {} as Record<MyTaskTabKey, number>
  for (const key of MY_TASK_TAB_KEYS) out[key] = buckets[key].length
  return out
}
