/**
 * Team response — who answers on the tasks this person assigned, and who goes quiet.
 *
 * The owner's question is "who keeps the conversation going and who disappears",
 * asked so it can be discussed with the person. So every label here has to be
 * something that person can be shown the evidence for, and this file obeys the
 * same rule as teamPerformance.ts: never assert what the data cannot support.
 * `too_early` is a real outcome, and a leaver is listed apart and never scored.
 *
 * WHAT IT CAN SEE. Only actions. Nothing records who opened a task, so someone who
 * read it and said nothing is silent here. Only tasks the viewer assigned, because
 * that is what RLS lets them read, so someone busy on other people's work can look
 * quiet. Leave and holidays are not removed: Sundays are, and that is all.
 *
 * Pure and deterministic. The hook reads the rows; this only counts them.
 */

import { istDateOf, istDayEndUtc, istDayStartUtc, istToday } from '@/lib/istDate'
import { isExpectedWorkingDay } from '@/lib/performanceCalendar'
import { isMeaningfulAction } from '@/lib/teamPerformance'
import { accruesAssigneeOverdue } from '@/lib/tasks/reviewTransitions'

// ─── The owner's rules ────────────────────────────────────────────────────────
// Proposed in the mockup of 2026-10-31 and agreed there. They have not been tried
// against real data, so expect these numbers to move.

/** Days in the strip: two weeks of a Monday-to-Saturday office. */
export const STRIP_WORKING_DAYS = 12
/** How far back a message to the assignee still counts towards their reply time. */
export const REPLY_WINDOW_DAYS = 30

export const MIN_JUDGED_DAYS     = 5
export const MIN_JUDGED_MESSAGES = 3

export const ACTIVE_DAY_SHARE         = 0.7
export const ACTIVE_REPLY_HOURS       = 24
export const LEAST_ACTIVE_DAY_SHARE   = 0.4
export const LEAST_ACTIVE_REPLY_HOURS = 72

/** A message that waited longer than this is one to raise. */
export const SLOW_REPLY_HOURS = 48
/** An open task this long without a word from its assignee is quiet. */
export const QUIET_TASK_HOURS = 48
/** A message still unanswered counts once it is this old, at its age so far. */
const UNANSWERED_COUNTS_AFTER_HOURS = 24

const HOUR_MS = 3_600_000

// ─── Shapes ───────────────────────────────────────────────────────────────────

export type ResponseTask = {
  id: string
  title: string
  status: string
  assigned_to: string | null
  created_at: string
  due_date: string | null
  last_update_at: string | null
  completed_at: string | null
  cancelled_at: string | null
}

export type ResponseEvent = {
  task_id: string
  actor_id: string
  action: string
  from_status: string | null
  to_status: string | null
  created_at: string
}

export type ResponsePersonRow = { id: string; full_name: string; is_active: boolean }

export type DayState = 'updated' | 'silent' | 'not_counted'
export type DayCell = { date: string; state: DayState; why: string }

export type ResponseLabel = 'least_active' | 'inconsistent' | 'active' | 'too_early'

export type PersonResponse = {
  userId: string
  name: string
  label: ResponseLabel
  days: DayCell[]
  updatedDays: number
  countedDays: number
  /** Typical wait for a reply, in hours. Null when there was nothing to reply to. */
  replyHours: number | null
  messages: number
  slowMessages: number
  taskCount: number
  openTasks: number
  overdueTasks: number
  quietTasks: number
  longestQuiet: { title: string; days: number } | null
  mostLate: { title: string; days: number } | null
  lastUpdateAt: string | null
}

export type InactivePerson = { userId: string; name: string; openTasks: number }

export type TeamResponse = {
  people: PersonResponse[]
  inactive: InactivePerson[]
}

// ─── Small rules ──────────────────────────────────────────────────────────────

const isClosed = (status: string) => status === 'completed' || status === 'cancelled'

/** When a closed task stopped being anybody's to answer. */
function closedAt(task: ResponseTask): string | null {
  if (!isClosed(task.status)) return null
  return task.completed_at ?? task.cancelled_at ?? task.last_update_at ?? task.created_at
}

/** The last `count` working days, oldest first, ending today. */
export function recentWorkingDays(today: string, count: number): string[] {
  const days: string[] = []
  let cursor = new Date(`${today}T00:00:00Z`)
  // Bounded by the rollout date inside isExpectedWorkingDay, and by this guard.
  for (let guard = 0; days.length < count && guard < count * 3; guard++) {
    const date = cursor.toISOString().slice(0, 10)
    if (isExpectedWorkingDay(date, { holidays: new Set(), joiningDate: null, exitDate: null })) days.unshift(date)
    cursor = new Date(cursor.getTime() - 86_400_000)
  }
  return days
}

/** The stretches a task sat with the creator, in which its assignee owes nothing. */
function approvalSpans(task: ResponseTask, events: readonly ResponseEvent[], nowMs: number): [number, number][] {
  const spans: [number, number][] = []
  let start: number | null = null
  for (const e of events) {
    const at = Date.parse(e.created_at)
    if (e.to_status === 'pending_approval') start ??= at
    else if (e.from_status === 'pending_approval') {
      spans.push([start ?? 0, at])
      start = null
    }
  }
  if (task.status === 'pending_approval') spans.push([start ?? 0, nowMs])
  return spans
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Something the creator said to the assignee, that the assignee owes an answer to. */
function isMessage(e: ResponseEvent): boolean {
  return e.action === 'created'
    || e.action === 'note_added'
    || e.action === 'comment_added'
    // Returned for correction.
    || (e.action === 'status_changed' && e.from_status === 'pending_approval' && e.to_status === 'working')
}

export function responseLabel(p: {
  updatedDays: number
  countedDays: number
  replyHours: number | null
  messages: number
}): ResponseLabel {
  if (p.countedDays < MIN_JUDGED_DAYS || p.messages < MIN_JUDGED_MESSAGES) return 'too_early'
  const share = p.updatedDays / p.countedDays
  const reply = p.replyHours ?? 0
  if (share < LEAST_ACTIVE_DAY_SHARE || reply > LEAST_ACTIVE_REPLY_HOURS) return 'least_active'
  if (share >= ACTIVE_DAY_SHARE && reply <= ACTIVE_REPLY_HOURS) return 'active'
  return 'inconsistent'
}

// ─── One person ───────────────────────────────────────────────────────────────

function measurePerson(
  userId: string,
  name: string,
  tasks: readonly ResponseTask[],
  eventsByTask: ReadonlyMap<string, readonly ResponseEvent[]>,
  viewerId: string,
  now: Date,
): PersonResponse {
  const nowMs = now.getTime()
  const today = istToday(now)
  const replyFrom = nowMs - REPLY_WINDOW_DAYS * 24 * HOUR_MS

  // ── Replies ──
  // Messages before a reply collapse into the first: three nudges in a row are
  // one wait, not three. A task that closed unanswered is dropped: nobody owes it
  // an answer any more, and it says nothing about the person.
  const waits: number[] = []
  const lastOwnEvent = new Map<string, number>()
  let lastUpdateMs: number | null = null
  const updatedDates = new Set<string>()

  for (const task of tasks) {
    let waitingSince: number | null = null
    for (const e of eventsByTask.get(task.id) ?? []) {
      const at = Date.parse(e.created_at)
      if (e.actor_id === userId && isMeaningfulAction(e.action)) {
        updatedDates.add(istDateOf(e.created_at))
        lastOwnEvent.set(task.id, at)
        if (lastUpdateMs === null || at > lastUpdateMs) lastUpdateMs = at
        if (waitingSince !== null) {
          if (waitingSince >= replyFrom) waits.push((at - waitingSince) / HOUR_MS)
          waitingSince = null
        }
      } else if (e.actor_id === viewerId && isMessage(e)) {
        waitingSince ??= at
      }
    }
    if (waitingSince !== null && waitingSince >= replyFrom && !isClosed(task.status)) {
      const age = (nowMs - waitingSince) / HOUR_MS
      if (age >= UNANSWERED_COUNTS_AFTER_HOURS) waits.push(age)
    }
  }

  // ── The strip ──
  const spans = new Map(tasks.map(t => [t.id, approvalSpans(t, eventsByTask.get(t.id) ?? [], nowMs)]))
  const days: DayCell[] = recentWorkingDays(today, STRIP_WORKING_DAYS).map(date => {
    if (updatedDates.has(date)) return { date, state: 'updated', why: 'Updated' }
    if (date === today) return { date, state: 'not_counted', why: 'Today, nothing yet' }

    const dayStart = Date.parse(istDayStartUtc(date))
    const dayEnd   = Date.parse(istDayEndUtc(date))
    let openThatDay = false
    let heldThatDay = false
    for (const task of tasks) {
      const closed = closedAt(task)
      if (Date.parse(task.created_at) > dayEnd) continue
      if (closed && Date.parse(closed) < dayStart) continue
      openThatDay = true
      const withCreator = (spans.get(task.id) ?? []).some(([from, to]) => from <= dayStart && to >= dayEnd)
      if (!withCreator) heldThatDay = true
    }
    if (heldThatDay) return { date, state: 'silent', why: 'No update' }
    return { date, state: 'not_counted', why: openThatDay ? 'Waiting for your approval' : 'No open task from you' }
  })

  // ── Open work ──
  let openTasks = 0
  let overdueTasks = 0
  let quietTasks = 0
  let longestQuiet: PersonResponse['longestQuiet'] = null
  let mostLate: PersonResponse['mostLate'] = null

  for (const task of tasks) {
    if (isClosed(task.status)) continue
    openTasks++

    if (task.due_date && task.due_date < today && accruesAssigneeOverdue(task.status)) {
      overdueTasks++
      const late = Math.round((Date.parse(today) - Date.parse(task.due_date)) / 86_400_000)
      if (!mostLate || late > mostLate.days) mostLate = { title: task.title, days: late }
    }

    if (task.status !== 'pending_approval') {
      const lastWord = lastOwnEvent.get(task.id) ?? Date.parse(task.created_at)
      const quietHours = (nowMs - lastWord) / HOUR_MS
      if (quietHours > QUIET_TASK_HOURS) {
        quietTasks++
        const quietDays = Math.floor(quietHours / 24)
        if (!longestQuiet || quietDays > longestQuiet.days) longestQuiet = { title: task.title, days: quietDays }
      }
    }
  }

  const updatedDays = days.filter(d => d.state === 'updated').length
  const countedDays = updatedDays + days.filter(d => d.state === 'silent').length
  const replyHours  = median(waits)
  const messages    = waits.length

  return {
    userId, name,
    label: responseLabel({ updatedDays, countedDays, replyHours, messages }),
    days, updatedDays, countedDays,
    replyHours, messages,
    slowMessages: waits.filter(h => h > SLOW_REPLY_HOURS).length,
    taskCount: tasks.length,
    openTasks, overdueTasks, quietTasks,
    longestQuiet, mostLate,
    lastUpdateAt: lastUpdateMs === null ? null : new Date(lastUpdateMs).toISOString(),
  }
}

// ─── The whole bar ────────────────────────────────────────────────────────────

const LABEL_ORDER: Record<ResponseLabel, number> = { least_active: 0, inconsistent: 1, active: 2, too_early: 3 }

/**
 * Least active first: the bar exists for the conversation, so the people worth
 * talking to must never be the ones that scroll out of view.
 */
export function buildTeamResponse({ tasks, events, people, viewerId, now }: {
  tasks: readonly ResponseTask[]
  events: readonly ResponseEvent[]
  /** Null when names could not be read: everyone is then treated as active. */
  people: readonly ResponsePersonRow[] | null
  viewerId: string
  now: Date
}): TeamResponse {
  const eventsByTask = new Map<string, ResponseEvent[]>()
  for (const e of [...events].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    const list = eventsByTask.get(e.task_id)
    if (list) list.push(e)
    else eventsByTask.set(e.task_id, [e])
  }

  const tasksByPerson = new Map<string, ResponseTask[]>()
  for (const task of tasks) {
    if (!task.assigned_to || task.assigned_to === viewerId) continue
    const list = tasksByPerson.get(task.assigned_to)
    if (list) list.push(task)
    else tasksByPerson.set(task.assigned_to, [task])
  }

  const byId = new Map((people ?? []).map(p => [p.id, p]))
  const judged: PersonResponse[] = []
  const inactive: InactivePerson[] = []

  for (const [userId, own] of tasksByPerson) {
    const row = byId.get(userId)
    const name = row?.full_name ?? 'Unknown'
    if (row && !row.is_active) {
      const openTasks = own.filter(t => !isClosed(t.status)).length
      if (openTasks > 0) inactive.push({ userId, name, openTasks })
      continue
    }
    const person = measurePerson(userId, name, own, eventsByTask, viewerId, now)
    if (person.openTasks > 0 || person.updatedDays + person.countedDays > 0) judged.push(person)
  }

  judged.sort((a, b) =>
    LABEL_ORDER[a.label] - LABEL_ORDER[b.label]
    || a.updatedDays / (a.countedDays || 1) - b.updatedDays / (b.countedDays || 1)
    || a.name.localeCompare(b.name))
  inactive.sort((a, b) => a.name.localeCompare(b.name))

  return { people: judged, inactive }
}

// ─── Words ────────────────────────────────────────────────────────────────────

export function formatReplyTime(hours: number): string {
  if (hours < 1) return 'under 1 hr'
  if (hours < 24) {
    const whole = Math.round(hours)
    return `${whole} ${whole === 1 ? 'hr' : 'hrs'}`
  }
  const days = Math.round(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'}`
}

/** The strip's day, for its tooltip. */
export function formatStripDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  })
}

function formatUpdateDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })
}

/** The lines on a person's card. `days` and `reply` are empty for someone too new to judge. */
export function personSummary(p: PersonResponse): { days: string; reply: string; flags: string } {
  const flags: string[] = []
  if (p.quietTasks > 0) flags.push(`${p.quietTasks} ${p.quietTasks === 1 ? 'task' : 'tasks'} quiet`)
  if (p.overdueTasks > 0) flags.push(`${p.overdueTasks} overdue`)
  const flagLine = flags.length > 0 ? `${flags.join(', ')}.` : ''

  if (p.label === 'too_early') {
    const reason = p.taskCount <= 2
      ? `Only ${p.taskCount} ${p.taskCount === 1 ? 'task' : 'tasks'} so far.`
      : 'Not enough to judge yet.'
    return { days: '', reply: reason, flags: flagLine }
  }
  return {
    days: `${p.updatedDays} of ${p.countedDays} days.`,
    reply: p.replyHours === null ? 'No messages to reply to.' : `Usually replies in ${formatReplyTime(p.replyHours)}.`,
    flags: flagLine,
  }
}

/** The facts to raise with the person. Each one can be checked against a task. */
export function talkingPoints(p: PersonResponse): string[] {
  const points: string[] = []
  if (p.slowMessages > 0) {
    points.push(`${p.slowMessages} of your ${p.messages} ${p.messages === 1 ? 'message' : 'messages'} waited over 2 days`)
  }
  if (p.longestQuiet) points.push(`Quiet for ${p.longestQuiet.days} days on "${p.longestQuiet.title}"`)
  if (p.mostLate) points.push(`"${p.mostLate.title}" is ${p.mostLate.days} ${p.mostLate.days === 1 ? 'day' : 'days'} late`)
  points.push(p.lastUpdateAt ? `Last update: ${formatUpdateDay(p.lastUpdateAt)}` : 'No update on your tasks yet')
  return points
}

const LABEL_COUNT_WORDS: Partial<Record<ResponseLabel, string>> = {
  least_active: 'least active',
  inconsistent: 'inconsistent',
}

/** The one line a phone shows before the bar is opened. */
export function teamSummaryLine(team: TeamResponse): string {
  const parts: string[] = []
  for (const label of ['least_active', 'inconsistent'] as const) {
    const count = team.people.filter(p => p.label === label).length
    if (count > 0) parts.push(`${count} ${LABEL_COUNT_WORDS[label]}`)
  }
  if (parts.length > 0) return parts.join(', ')
  return team.people.length > 0 ? 'Everyone is responding' : 'Nobody to show yet'
}
