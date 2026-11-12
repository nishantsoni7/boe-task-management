// DAY CLOSE: the rules, pure (owner, 2026-11-12).
//
// Office is 10:00 to 18:30 IST, Monday to Saturday. For every person the owner switches on:
//
//   10:30   the day's plan is filed. THE PLAN IS THE PERSON'S OWN TASKS in Task Management (owner,
//           2026-11-12: no second list): every open task assigned to them that is due today or overdue,
//           their Self Tasks included. Filing keeps the list as it was. Somebody who arrives late gets
//           30 minutes from their arrival instead.
//   day     tasks are finished in Task Management. Finishing one needs proof posted on the task (a file
//           or a link), enforced by the database (20270624000000, tasks_day_close_proof).
//   18:00   "Close my day" opens, on the Task Management dashboard. Every task of the day is handed in
//           (submitted or completed) or carried over with a reason and a new date; the end-of-day
//           summary is written there and files the EOD log. Closed BEFORE the punch-out on the machine.
//   night   the check writes strikes (no money, owner 2026-11-12):
//             no_plan               came in, never filed a plan
//             plan_late             filed after the due time
//             day_not_closed        came in, never closed the day
//             closed_after_leaving  closed it, but only after the last punch on the machine
//           No strike on a Sunday, a holiday, a day of approved full-day leave, or a day with no punch
//           (attendance deals with absence; a missing machine record must never become a strike).
//   leave   a full-day or half-day leave request sent while work is pending (overdue tasks, or a day in
//           the last 7 not closed) is marked, and only the reviewer (the owner) may approve it.
//
// Nothing here reads a clock or a database; the server passes `now` and the rows.

import { istAddDays, istDateOf, istMinutesOfDay } from '../istDate'

/** 10:30 IST: the plan is due. */
export const PLAN_DUE_MINUTES = 630
/** A late arrival has this long after punching in to file the plan. */
export const PLAN_GRACE_AFTER_ARRIVAL_MINUTES = 30
/** 18:00 IST: closing the day opens. */
export const CLOSE_OPENS_MINUTES = 1080
/** 18:30 IST: office ends. */
export const OFFICE_ENDS_MINUTES = 1110
/** Closing within this long after the last punch still counts as closed before leaving (clock drift). */
export const CLOSE_AFTER_PUNCH_TOLERANCE_MINUTES = 5
/** Days looked back for a day that was not closed, when a leave request is judged. */
export const UNCLOSED_LOOKBACK_DAYS = 7

/** Task statuses that mean the assignee has handed the work in. */
export const TASK_HANDED_IN = ['pending_approval', 'completed'] as const
/** Task statuses that are not work any more. */
export const TASK_CLOSED = ['completed', 'cancelled'] as const

/** Leave types a pending-work lock applies to. */
export const LOCKED_LEAVE_TYPES = ['full_day_leave', 'half_day'] as const

export type StrikeKind = 'no_plan' | 'plan_late' | 'day_not_closed' | 'closed_after_leaving'
export type StrikeStatus = 'open' | 'upheld' | 'waived'
export const STRIKE_LABEL: Record<StrikeKind, string> = {
  no_plan: 'No plan filed',
  plan_late: 'Plan filed late',
  day_not_closed: 'Day not closed',
  closed_after_leaving: 'Closed after leaving',
}

export type Plan = {
  id: string
  employee_id: string
  work_date: string
  submitted_at: string | null
  closed_at: string | null
  close_note: string | null
  planned_task_ids?: string[]
}

// ─── Small helpers ───────────────────────────────────────────────────────────

/** Sunday is the weekly off (Saturday is a working day, owner 2026-11-12). */
export function isSunday(date: string): boolean {
  return new Date(`${date}T00:00:00Z`).getUTCDay() === 0
}

/** "10:30 am" from minutes after midnight. */
export function clock(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  const suffix = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`
}

/** The minute of the IST day an instant falls on, or null when it is on another date. */
function minutesOnDate(instant: string, date: string): number | null {
  return istDateOf(instant) === date ? istMinutesOfDay(instant) : null
}

/** When the plan is due for this person on this date: 10:30, or 30 minutes after a late arrival. */
export function planDueMinutes(checkInAt: string | null, date: string, dueMinutes = PLAN_DUE_MINUTES): number {
  const arrived = checkInAt ? minutesOnDate(checkInAt, date) : null
  if (arrived === null) return dueMinutes
  return Math.max(dueMinutes, arrived + PLAN_GRACE_AFTER_ARRIVAL_MINUTES)
}

// ─── The day's tasks ─────────────────────────────────────────────────────────

export type DayTask = {
  id: string
  title: string
  status: string
  priority: string | null
  due_date: string | null
  assigned_to: string
  created_by: string
}

export type Carryover = { task_id: string; reason: string; next_date: string }

/** Handed in: submitted for approval or completed. The assignee's part is done. */
export function isHandedIn(status: string): boolean {
  return (TASK_HANDED_IN as readonly string[]).includes(status)
}

export type DayTaskState = 'done' | 'carried' | 'open'

export function dayTaskState(task: Pick<DayTask, 'id' | 'status'>, carried: ReadonlySet<string>): DayTaskState {
  if (isHandedIn(task.status)) return 'done'
  if (carried.has(task.id)) return 'carried'
  return 'open'
}

/**
 * The day's list: before filing, the open tasks due today or before; after filing, the tasks that were
 * planned (whatever happened to them since) and any open task that became due later in the day.
 * Cancelled tasks leave the list.
 */
export function dayTaskList(tasks: readonly DayTask[], today: string, planned: readonly string[] | null): DayTask[] {
  const plannedSet = new Set(planned ?? [])
  return tasks
    .filter(t => t.status !== 'cancelled')
    .filter(t => plannedSet.has(t.id) || isTaskDueForPlan(t, today))
    .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? '') || a.title.localeCompare(b.title))
}

export function countDay(tasks: readonly DayTask[], carried: ReadonlySet<string>) {
  let done = 0, carriedN = 0, open = 0
  for (const t of tasks) {
    const s = dayTaskState(t, carried)
    if (s === 'done') done++
    else if (s === 'carried') carriedN++
    else open++
  }
  return { total: tasks.length, done, carried: carriedN, open }
}

// ─── Validation of what a person sends ───────────────────────────────────────

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }
const bad = (error: string): Result<never> => ({ ok: false, error })
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export const REASON_MAX = 1000
export const SUMMARY_MAX = 4000

/** One task carried to another day: a reason and a day after today, within 60 days. */
export function validateCarryover(body: unknown, today: string): Result<Carryover> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const taskId = text(b.task_id)
  const reason = text(b.reason)
  const next = text(b.next_date)
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) return bad('Unknown task.')
  if (reason.length < 3) return bad('Say why it is not finished (at least 3 characters).')
  if (reason.length > REASON_MAX) return bad(`Keep the reason under ${REASON_MAX} characters.`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) return bad('Choose the day it will be done.')
  if (next <= today) return bad('The new date must be after today.')
  if (next > istAddDays(today, 60)) return bad('Choose a day within the next 60 days.')
  return { ok: true, value: { task_id: taskId, reason, next_date: next } }
}

/** The end-of-day summary, which is also the EOD log (owner, 2026-11-12: one evening action). */
export function validateSummary(v: unknown): Result<string> {
  const s = text(v)
  if (s.length < 3) return bad('Write a line or two about your day: what got done, what is stuck.')
  if (s.length > SUMMARY_MAX) return bad(`Keep the summary under ${SUMMARY_MAX} characters.`)
  return { ok: true, value: s }
}

// ─── The night's judgement ───────────────────────────────────────────────────

export type DayJudgeInput = {
  date: string
  /** A holiday row for the date (full or half). */
  holiday: boolean
  /** An approved full-day leave covers the date. */
  fullDayLeave: boolean
  /** From the machine (buildMachineDay). Both null: no punch that day. */
  checkInAt: string | null
  checkOutAt: string | null
  plan: Pick<Plan, 'submitted_at' | 'closed_at'> | null
  /** Open items at the time of judging (for the reviewer's detail). */
  openItems: number
  planDueMinutes?: number
}

export type StrikeDraft = { kind: StrikeKind; detail: Record<string, unknown> }

/** Whether the date is one a strike can be written for at all. */
export function isJudgedDay(input: Pick<DayJudgeInput, 'date' | 'holiday' | 'fullDayLeave' | 'checkInAt' | 'checkOutAt'>): boolean {
  if (isSunday(input.date) || input.holiday || input.fullDayLeave) return false
  return !!(input.checkInAt || input.checkOutAt)
}

export function judgeDay(input: DayJudgeInput): StrikeDraft[] {
  if (!isJudgedDay(input)) return []
  const strikes: StrikeDraft[] = []
  const { plan, date } = input
  const due = planDueMinutes(input.checkInAt, date, input.planDueMinutes ?? PLAN_DUE_MINUTES)

  if (!plan?.submitted_at) {
    strikes.push({ kind: 'no_plan', detail: { due: clock(due) } })
  } else {
    const filed = minutesOnDate(plan.submitted_at, date)
    // Filed on another date (after midnight) counts as late too.
    if (filed === null || filed > due) {
      strikes.push({ kind: 'plan_late', detail: { due: clock(due), filed_at: plan.submitted_at } })
    }
  }

  if (!plan?.closed_at) {
    strikes.push({
      kind: 'day_not_closed',
      detail: { punch_out_at: input.checkOutAt, open_items: input.openItems },
    })
  } else if (input.checkOutAt) {
    const closedMs = Date.parse(plan.closed_at)
    const outMs = Date.parse(input.checkOutAt)
    if (closedMs > outMs + CLOSE_AFTER_PUNCH_TOLERANCE_MINUTES * 60_000) {
      strikes.push({ kind: 'closed_after_leaving', detail: { punch_out_at: input.checkOutAt, closed_at: plan.closed_at } })
    }
  }
  return strikes
}

// ─── Leave while work is pending ─────────────────────────────────────────────

export function isLockedLeaveType(type: unknown): boolean {
  return typeof type === 'string' && (LOCKED_LEAVE_TYPES as readonly string[]).includes(type)
}

export type PendingWork = { overdueTasks: number; unclosedDays: number }

export function hasPendingWork(p: PendingWork): boolean {
  return p.overdueTasks > 0 || p.unclosedDays > 0
}

export function pendingWorkWords(p: PendingWork): string {
  const parts: string[] = []
  if (p.overdueTasks > 0) parts.push(`${p.overdueTasks} overdue ${p.overdueTasks === 1 ? 'task' : 'tasks'}`)
  if (p.unclosedDays > 0) parts.push(`${p.unclosedDays} ${p.unclosedDays === 1 ? 'day' : 'days'} not closed`)
  return parts.join(', ')
}

/** Is a task overdue for its assignee on `today`? Due before today, and not handed in or closed. */
export function isTaskOverdue(task: { status: string; due_date: string | null }, today: string): boolean {
  if (!task.due_date || task.due_date >= today) return false
  return !(['pending_approval', ...TASK_CLOSED] as string[]).includes(task.status)
}

/** Is an assigned task part of today's plan? Due today or before, and not closed. */
export function isTaskDueForPlan(task: { status: string; due_date: string | null }, today: string): boolean {
  if (!task.due_date || task.due_date > today) return false
  return !(TASK_CLOSED as readonly string[]).includes(task.status)
}

// ─── What the person is asked to do now (the strip, My Day) ──────────────────

export type DayPrompt =
  | { kind: 'none' }
  | { kind: 'file_plan'; late: boolean; due: string }
  | { kind: 'close_day'; open: number }
  | { kind: 'closed' }

export function dayPrompt(input: {
  now: Date
  date: string
  workingDay: boolean
  plan: Pick<Plan, 'submitted_at' | 'closed_at'> | null
  openItems: number
  checkInAt: string | null
  planDueMinutes?: number
  closeOpensMinutes?: number
}): DayPrompt {
  if (!input.workingDay) return { kind: 'none' }
  if (input.plan?.closed_at) return { kind: 'closed' }
  const minutes = istMinutesOfDay(input.now)
  const due = planDueMinutes(input.checkInAt, input.date, input.planDueMinutes ?? PLAN_DUE_MINUTES)
  if (!input.plan?.submitted_at) return { kind: 'file_plan', late: minutes > due, due: clock(due) }
  if (minutes >= (input.closeOpensMinutes ?? CLOSE_OPENS_MINUTES)) return { kind: 'close_day', open: input.openItems }
  return { kind: 'none' }
}
