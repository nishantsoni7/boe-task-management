// WHAT THE TASK PREVIEW DRAWER SAYS ABOUT A TASK.
//
// The drawer used to list fields and show ONE "Recent update" — the newest
// activity row, which was often noise ("Task acknowledged", an automatic
// escalation) and never said WHY the task has its status. It now briefs the
// task: a headline (status, due, who holds it), the reason behind the status,
// and the last few real updates. All of it is read off the task and the 20
// activity rows the drawer already loads — no new query, no new write.
//
// Pure, so the rules are tested directly (taskDrawerBrief.test.ts).

import type { LogEntry, Task } from '@/lib/types'
import { formatShortDate, taskStatusLabel, type TaskStatusViewer } from '@/lib/ui'
import { accruesAssigneeOverdue } from './reviewTransitions'

const DAY_MS = 86_400_000

type Names = Record<string, string> | undefined

// ─── Headline ────────────────────────────────────────────────────────────────

/** "due tomorrow", "overdue by 3 days", "no due date". `today` is a YYYY-MM-DD
 *  key — the same UTC key isOverdue() compares against, so the words and the
 *  red "Overdue" flag can never disagree. */
export function dueInText(dueDate: string | null, status: string, today: string): string {
  if (!dueDate) return 'no due date'
  // A finished or in-review task is not late, so a countdown would mislead.
  if (!accruesAssigneeOverdue(status)) return `due ${formatShortDate(dueDate)}`
  const days = Math.round((Date.parse(dueDate) - Date.parse(today)) / DAY_MS)
  if (days < 0)   return days === -1 ? 'overdue by 1 day' : `overdue by ${-days} days`
  if (days === 0) return 'due today'
  if (days === 1) return 'due tomorrow'
  if (days <= 14) return `due in ${days} days`
  return `due ${formatShortDate(dueDate)}`
}

/** Who the ball is with: the assignee, or the creator while work awaits approval.
 *  Null once the task is finished, or when no name is known. Always a NAME, never
 *  "you": View As and the Super Admin user view hand the drawer the VIEWED
 *  person's id as `currentUserId`, so "you" would be wrong there. */
export function holderText(
  task: Pick<Task, 'status' | 'assigned_to' | 'created_by' | 'assignee_name'>,
  userMap: Names,
): string | null {
  if (task.status === 'completed' || task.status === 'cancelled') return null
  const holderId = task.status === 'pending_approval' ? task.created_by : task.assigned_to
  const fallback = holderId === task.assigned_to ? task.assignee_name : undefined
  return userMap?.[holderId] ?? fallback ?? null
}

export type Headline = { status: string; due: string; who: string | null }

/** "Working · due tomorrow · with Dhruv" as its three parts. */
export function headlineOf(
  task: Pick<Task, 'status' | 'due_date' | 'assigned_to' | 'created_by' | 'assignee_name'>,
  opts: { userMap?: Names; currentUserId?: string; today: string },
): Headline {
  const viewer: TaskStatusViewer =
    opts.currentUserId && opts.currentUserId === task.created_by && task.created_by !== task.assigned_to ? 'creator'
    : opts.currentUserId && opts.currentUserId === task.assigned_to ? 'assignee'
    : 'other'
  const holder = holderText(task, opts.userMap)
  return {
    status: taskStatusLabel(task.status, viewer),
    due:    dueInText(task.due_date, task.status, opts.today),
    who:    holder ? `with ${holder}` : null,
  }
}

// ─── Reason behind the status ────────────────────────────────────────────────

// Same fallback texts the full task page puts in its Current Status card.
const STATUS_CARD_DEFAULTS: Record<string, string> = {
  working: 'Task is in progress',
  waiting: 'Task is waiting for input',
  blocked: 'Task is blocked',
}

/** `id` is the log row the headline was read from, so the updates list can avoid
 *  printing the same words a second time. */
export type StatusReason = { id: string | null; reason: string | null; actorId: string | null; at: string | null }

type LogLike = Pick<LogEntry, 'id' | 'action' | 'note' | 'from_status' | 'to_status' | 'created_at' | 'actor_id'>
  & Partial<Pick<LogEntry, 'old_val' | 'new_val'>>

/** The newest `status_changed` row drives it, as on the full task page. A
 *  blocked task's reason is the Blocker box's text, so it is not repeated. */
export function statusReasonOf(
  task: Pick<Task, 'status' | 'blocker_reason'>,
  log: readonly LogLike[],
): StatusReason {
  const latest = log.find(e => e.action === 'status_changed')
  if (!latest) return { id: null, reason: null, actorId: null, at: null }
  const own = latest.note?.trim() ? latest.note : null
  const reason = own ?? STATUS_CARD_DEFAULTS[task.status] ?? null
  const duplicate = task.status === 'blocked' && reason !== null && reason === task.blocker_reason
  return { id: latest.id, reason: duplicate ? null : reason, actorId: latest.actor_id, at: latest.created_at }
}

// ─── Latest updates ──────────────────────────────────────────────────────────

/** Lines the system writes by itself, or that say nothing on their own. They
 *  are skipped whenever a real update exists. */
const SYSTEM_ACTIONS = new Set(['escalated', 'stale_flagged', 'acknowledged', 'task_copied'])

export const LATEST_UPDATES_MAX = 3

export type UpdateLine = {
  id: string
  actorId: string
  /** The sentence after the person's name: "changed the status to Working". */
  what: string
  /** Their words, or the old → new values. Null when there is nothing more. */
  detail: string | null
  at: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/

function shown(value: string | null | undefined, empty: string): string {
  if (!value) return empty
  return ISO_DATE.test(value) ? formatShortDate(value) : value
}

function describe(e: LogLike): { what: string; detail: string | null } {
  const note = e.note?.trim() ? e.note : null
  switch (e.action) {
    case 'status_changed': {
      if (e.from_status && e.to_status && e.from_status === e.to_status) {
        return { what: 'posted a progress update', detail: note }
      }
      const to = e.to_status ? taskStatusLabel(e.to_status) : null
      const from = e.from_status ? taskStatusLabel(e.from_status) : null
      return {
        what: to ? (from ? `changed the status from ${from} to ${to}` : `changed the status to ${to}`) : 'changed the status',
        detail: note,
      }
    }
    case 'note_added':
    case 'comment_added':
      // "Send Update" refuses an empty post, so a row with no text carried files.
      return { what: note ? 'commented' : 'attached a file', detail: note }
    case 'due_date_changed':
    case 'deadline_changed': {
      const change = `${shown(e.old_val, 'No date')} → ${shown(e.new_val, 'Cleared')}`
      return { what: 'changed the due date', detail: note ? `${change}\n${note}` : change }
    }
    case 'priority_changed': {
      const change = e.old_val && e.new_val ? `${e.old_val} → ${e.new_val}` : null
      return { what: 'changed the priority', detail: change && note ? `${change}\n${note}` : (change ?? note) }
    }
    case 'title_changed': return { what: 'changed the title', detail: note }
    case 'created':       return { what: 'created the task', detail: note }
    case 'delegated':     return { what: 'delegated the task', detail: note }
    case 'acknowledged':  return { what: 'acknowledged the task', detail: note }
    default:              return { what: e.action.replace(/_/g, ' '), detail: note }
  }
}

/** The newest few real updates. When every row is a system line the section
 *  would be empty, so it falls back to the newest rows rather than saying
 *  nothing happened. `log` is newest first. */
export function latestUpdatesOf(log: readonly LogLike[], max = LATEST_UPDATES_MAX): UpdateLine[] {
  const real = log.filter(e => !SYSTEM_ACTIONS.has(e.action))
  return (real.length > 0 ? real : log).slice(0, max).map(e => ({
    id: e.id, actorId: e.actor_id, at: e.created_at, ...describe(e),
  }))
}
