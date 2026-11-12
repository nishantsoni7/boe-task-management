// DAY CLOSE: the rules, pure (owner, 2026-11-12).
//
// Office is 10:00 to 18:30 IST, Monday to Saturday. For every person the owner switches on:
//
//   10:30   the day's plan is filed: the tasks somebody else gave them that are due (copied in by the
//           server, cannot be removed) and their own items, each with the output they expect.
//           Somebody who arrives late gets 30 minutes from their arrival instead.
//   day     every item ends Done (an own item needs a link or a photo; an assigned task is done when it
//           has been submitted in Task Management) or Not done (a reason and the day it will be done).
//   18:00   "Close your day" opens. The day must be closed BEFORE the punch-out on the machine.
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

export const ITEM_TITLE_MAX = 300
export const ITEM_OUTPUT_MAX = 500
export const REASON_MAX = 1000
export const NOTE_MAX = 1000
export const URL_MAX = 1000
/** A plan holds at most this many own items: it is a day, not a backlog. */
export const MAX_OWN_ITEMS = 15

/** Task statuses that mean the assignee has handed the work in. */
export const TASK_HANDED_IN = ['pending_approval', 'completed'] as const
/** Task statuses that are not work any more. */
export const TASK_CLOSED = ['completed', 'cancelled'] as const

/** Leave types a pending-work lock applies to. */
export const LOCKED_LEAVE_TYPES = ['full_day_leave', 'half_day'] as const

export type StrikeKind = 'no_plan' | 'plan_late' | 'day_not_closed' | 'closed_after_leaving'
export type StrikeStatus = 'open' | 'upheld' | 'waived'
export type ItemStatus = 'open' | 'done' | 'not_done'
export type ItemSource = 'assigned' | 'own'

export const STRIKE_LABEL: Record<StrikeKind, string> = {
  no_plan: 'No plan filed',
  plan_late: 'Plan filed late',
  day_not_closed: 'Day not closed',
  closed_after_leaving: 'Closed after leaving',
}

export type PlanItem = {
  id: string
  source: ItemSource
  task_id: string | null
  title: string
  expected_output: string | null
  status: ItemStatus
  proof_url: string | null
  proof_photo_path: string | null
  proof_note: string | null
  reason: string | null
  next_date: string | null
  closed_at: string | null
  created_at: string
  /** Live, for an assigned item: the task's current status. */
  task_status?: string | null
  task_due_date?: string | null
}

export type Plan = {
  id: string
  employee_id: string
  work_date: string
  submitted_at: string | null
  closed_at: string | null
  close_note: string | null
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

/** An assigned item is done when its task has been handed in. */
export function assignedItemHandedIn(item: Pick<PlanItem, 'source' | 'task_status'>): boolean {
  return item.source === 'assigned' && !!item.task_status
    && (TASK_HANDED_IN as readonly string[]).includes(item.task_status)
}

/** What an item counts as right now: an assigned task handed in counts as done even before it is marked. */
export function effectiveStatus(item: PlanItem): ItemStatus {
  if (item.status !== 'open') return item.status
  return assignedItemHandedIn(item) ? 'done' : 'open'
}

export function countItems(items: readonly PlanItem[]) {
  let done = 0, notDone = 0, open = 0
  for (const item of items) {
    const s = effectiveStatus(item)
    if (s === 'done') done++
    else if (s === 'not_done') notDone++
    else open++
  }
  return { total: items.length, done, notDone, open }
}

// ─── Validation of what a person sends ───────────────────────────────────────

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }
const bad = (error: string): Result<never> => ({ ok: false, error })

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function validateNewItem(body: Record<string, unknown>): Result<{ title: string; expected_output: string | null }> {
  const title = text(body.title)
  const output = text(body.expected_output)
  if (title.length < 2) return bad('Write what you will do (at least 2 characters).')
  if (title.length > ITEM_TITLE_MAX) return bad(`Keep the item under ${ITEM_TITLE_MAX} characters.`)
  if (output.length > ITEM_OUTPUT_MAX) return bad(`Keep the expected output under ${ITEM_OUTPUT_MAX} characters.`)
  return { ok: true, value: { title, expected_output: output || null } }
}

export function isHttpUrl(v: string): boolean {
  if (!/^https?:\/\//i.test(v) || v.length > URL_MAX) return false
  try { new URL(v); return true } catch { return false }
}

const PHOTO_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/

/** A proof photo path is the caller's own folder: '{caller}/{uuid}.jpg'. */
export function isOwnPhotoPath(path: string, employeeId: string): boolean {
  return PHOTO_PATH.test(path) && path.startsWith(`${employeeId}/`)
}

export type ItemClose =
  | { status: 'done'; proof_url: string | null; proof_photo_path: string | null; proof_note: string | null }
  | { status: 'not_done'; reason: string; next_date: string }

/**
 * Closing one item. Done: an own item needs a link or a photo; an assigned item needs its task handed in
 * (pending approval or completed) in Task Management. Not done: a reason and a day from today on.
 */
export function validateItemClose(
  body: Record<string, unknown>,
  item: Pick<PlanItem, 'source' | 'task_status'>,
  employeeId: string,
  today: string,
): Result<ItemClose> {
  const status = body.status
  if (status === 'done') {
    const url = text(body.proof_url)
    const photo = text(body.proof_photo_path)
    const note = text(body.proof_note)
    if (url && !isHttpUrl(url)) return bad('The proof link must start with http:// or https://.')
    if (photo && !isOwnPhotoPath(photo, employeeId)) return bad('That photo is not one you uploaded.')
    if (note.length > NOTE_MAX) return bad(`Keep the note under ${NOTE_MAX} characters.`)
    if (item.source === 'assigned') {
      if (!assignedItemHandedIn(item)) {
        return bad('Submit this task in Task Management first. Until then, close it as Not done with a reason.')
      }
    } else if (!url && !photo) {
      return bad('Add proof: a link or a photo of the work.')
    }
    return { ok: true, value: { status: 'done', proof_url: url || null, proof_photo_path: photo || null, proof_note: note || null } }
  }
  if (status === 'not_done') {
    const reason = text(body.reason)
    const next = text(body.next_date)
    if (reason.length < 3) return bad('Say why it is not done (at least 3 characters).')
    if (reason.length > REASON_MAX) return bad(`Keep the reason under ${REASON_MAX} characters.`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) return bad('Choose the day it will be done.')
    if (next <= today) return bad('The new date must be after today.')
    if (next > istAddDays(today, 60)) return bad('Choose a day within the next 60 days.')
    return { ok: true, value: { status: 'not_done', reason, next_date: next } }
  }
  return bad('Choose Done or Not done.')
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
