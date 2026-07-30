/**
 * Pure scoring functions shared between the single-user and batch
 * performance-metrics routes. Do NOT import from route files.
 *
 * Score model — 4 pillars, max 100 pts:
 *  OUTPUT     (0–50)  Weighted completions: High×22 + Med×15 + Low×8, cap 50
 *  MOMENTUM   (0–20)  Status updates ×4 (cap 16) + blocker-cleared ×4 (cap 4)
 *  DISCIPLINE (0–20)  EOD log +12, was active today +5, timely ack ×3 (cap 3)
 *  RISK       (0→−40) Overdue ×−5 (cap −25) + stale-blocked ×−8 (cap −16)
 *  TOTAL = clamp(Output + Momentum + Discipline + Risk, 0, 100)
 *
 * The pillar weights are unchanged. What changed is the two RISK inputs: they
 * are now reconstructed for each day (buildDailyRiskSeries) instead of being
 * measured once as of now and copied across the window, and period averages
 * run over every eligible day (periodAverageScore) instead of only the days
 * that happened to hold data.
 *
 * Days are Asia/Kolkata business days throughout.
 */

import type {
  ScoreBreakdown, DayInputs, TrendDay,
  TrendAnalysis, TrendClassification, PerformanceRating,
} from '@/lib/types'
import { istDateOf, istDayEndUtc } from '@/lib/istDate'

export function computeBreakdown(inputs: DayInputs): ScoreBreakdown {
  const output = Math.min(
    50,
    inputs.completedHigh   * 22 +
    inputs.completedMedium * 15 +
    inputs.completedLow    * 8
  )
  const momentum = Math.min(20,
    Math.min(16, inputs.statusUpdates * 4) +
    Math.min(4,  inputs.blockerResolutions * 4)
  )
  const discipline = Math.min(20,
    (inputs.hasEodLog     ? 12 : 0) +
    (inputs.wasActiveToday ? 5 : 0) +
    Math.min(3, inputs.timelyAcks * 3)
  )
  const risk = -(
    Math.min(25, inputs.overdueCount      * 5) +
    Math.min(16, inputs.staleBlockedCount * 8)
  )
  const total = Math.max(0, Math.min(100, output + momentum + discipline + risk))
  return { output, momentum, discipline, risk, total }
}

// ─── Per-day risk reconstruction ─────────────────────────────────────────────
/**
 * Overdue and stale-blocked counts are *state*, not events: they describe the
 * task portfolio at a moment in time. Both routes used to measure that state
 * once (as of now) and inject the same numbers into every day of the trend, so
 * a person with 5 overdue tasks today showed −25 risk on all 7 trend days —
 * including days when nothing was overdue. That made the trend, the
 * improving/declining classification and the week-over-week delta unusable,
 * because yesterday's score changed every time today's portfolio changed.
 *
 * These functions rebuild the state each day actually had, from the task rows
 * plus the activity log already fetched for the window.
 *
 * Due dates are reconstructed too: `due_date_changed` activity carries old_val
 * and new_val, so the deadline that actually applied on a past day is known and
 * a task whose deadline was pushed no longer looks as though it always had the
 * later one.
 *
 * Known limits (deliberate — they need schema work, not more arithmetic):
 *  · The activity log is fetched per actor, so a status change made by someone
 *    other than the assignee is not seen by the timeline.
 *  · Tasks are gathered by their *current* assignee. A task reassigned during
 *    the window is attributed wholly to whoever holds it now; nothing records
 *    who held it on an earlier day.
 *  · Events before the window are unavailable; status is seeded from the first
 *    known event's `from_status` and freshness from `last_update_at`.
 */
export type RiskTask = {
  id:             string
  due_date:       string | null
  created_at:     string
  status:         string
  last_update_at: string | null
}

export type RiskEvent = {
  task_id:     string
  created_at:  string
  action:      string
  from_status: string | null
  to_status:   string | null
  /** Populated on due_date_changed: the deadline before and after the edit. */
  old_val?:    string | null
  new_val?:    string | null
}

/** Actions that record a deadline revision. Both spellings exist in the log. */
const DUE_DATE_ACTIONS = new Set(['due_date_changed', 'deadline_changed'])

/**
 * The deadline that applied to a task at a given instant: the value replaced by
 * the first revision made after that instant, or the current one if no revision
 * followed. Used both for per-day overdue counting and for deciding whether a
 * completion landed on time — a deadline pushed *after* the work finished must
 * not retroactively make a late finish look punctual.
 */
export function dueDateAsOf(
  currentDueDate: string | null,
  taskEvents: readonly RiskEvent[],
  atIso: string,
): string | null {
  const revision = taskEvents
    .filter(e => DUE_DATE_ACTIONS.has(e.action) && e.created_at > atIso)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
  return revision ? (revision.old_val ?? null) : currentDueDate
}

export type DailyRisk = { overdueCount: number; staleBlockedCount: number }

/** A blocked task counts as stale once it has gone this long with no activity. */
export const STALE_BLOCKED_DAYS = 2

const CLOSED_STATUSES = new Set(['completed', 'cancelled'])

export function buildDailyRiskSeries(
  dateList: string[],
  tasks: RiskTask[],
  events: RiskEvent[],
  now: Date = new Date(),
): Map<string, DailyRisk> {
  // Staleness is measured at the end of each day — except for today, where the
  // end of the day has not happened yet. Measuring today at midnight would age
  // every open blocker by the hours remaining in the day and report tasks as
  // stale before they are.
  const nowMs = now.getTime()
  const eventsByTask = new Map<string, RiskEvent[]>()
  for (const e of events) {
    const arr = eventsByTask.get(e.task_id)
    if (arr) arr.push(e)
    else eventsByTask.set(e.task_id, [e])
  }
  for (const arr of eventsByTask.values()) {
    arr.sort((a, b) => a.created_at.localeCompare(b.created_at))
  }

  const series = new Map<string, DailyRisk>(
    dateList.map(d => [d, { overdueCount: 0, staleBlockedCount: 0 }]),
  )

  for (const task of tasks) {
    const taskEvents  = eventsByTask.get(task.id) ?? []
    const statusMoves = taskEvents.filter(e => e.to_status !== null)
    const dueChanges  = taskEvents.filter(e => DUE_DATE_ACTIONS.has(e.action))
    const createdOn   = istDateOf(task.created_at)

    // Status the task held before the first event we can see. When no event is
    // visible the task never changed status inside the window, so its current
    // status held throughout.
    const seedStatus = statusMoves.length > 0
      ? (statusMoves[0].from_status ?? task.status)
      : task.status

    for (const date of dateList) {
      if (date < createdOn) continue
      const dayEnd = istDayEndUtc(date)
      const bucket = series.get(date)!

      // Status and last-touched time as they stood at the end of this day.
      let status     = seedStatus
      let lastTouch  = task.created_at
      for (const e of taskEvents) {
        if (e.created_at > dayEnd) break
        if (e.to_status !== null) status = e.to_status
        lastTouch = e.created_at
      }
      // `last_update_at` also moves on non-status activity (comments, notes).
      // Use it when it is the more recent of the two and had already happened.
      if (task.last_update_at && task.last_update_at <= dayEnd && task.last_update_at > lastTouch) {
        lastTouch = task.last_update_at
      }

      if (CLOSED_STATUSES.has(status)) continue

      // The deadline as it stood on this day: the value replaced by the first
      // revision made after this day, or the current one if none followed.
      const nextRevision = dueChanges.find(e => e.created_at > dayEnd)
      const dueOnDay     = nextRevision ? (nextRevision.old_val ?? null) : task.due_date

      if (dueOnDay && dueOnDay < date) bucket.overdueCount++

      if (status === 'blocked') {
        const measuredAt = Math.min(Date.parse(dayEnd), nowMs)
        const idleMs     = measuredAt - Date.parse(lastTouch)
        if (idleMs > STALE_BLOCKED_DAYS * 24 * 60 * 60 * 1000) bucket.staleBlockedCount++
      }
    }
  }

  return series
}

export function scoreRating(score: number): PerformanceRating {
  if (score >= 75) return 'excellent'
  if (score >= 58) return 'good'
  if (score >= 38) return 'average'
  if (score >= 20) return 'needs_improvement'
  return 'critical'
}

// ─── Period averaging ────────────────────────────────────────────────────────
/**
 * One definition of "average score over a period", shared by the personal page
 * and the team endpoint. They previously disagreed: the personal page averaged
 * only the days it happened to hold trend data for (~7), silently dropping
 * every day the employee did nothing, while the team endpoint averaged all 30
 * days with idle days counted as 0. The same person showed two different
 * monthly numbers, and the "needs attention" threshold fired on the team one.
 *
 * A day the employee was expected to work but didn't is a real zero, so every
 * eligible date counts. Which dates are eligible is decided by
 * lib/performanceCalendar — Sundays, company holidays, pre-joining and
 * post-exit dates are not the employee's to answer for.
 */

/** Mean daily score across the supplied days. Null when there are none. */
export function periodAverageScore(days: TrendDay[]): number | null {
  if (days.length === 0) return null
  return Math.round(days.reduce((s, d) => s + d.score, 0) / days.length)
}

export function analyzeTrend(trendDays: TrendDay[]): TrendAnalysis {
  const scores = trendDays.map(d => d.score)

  if (scores.length < 3) {
    return {
      classification:    'insufficient_data',
      direction:         'flat',
      streak:            0,
      weekOverWeekDelta: 0,
      description:       'Not enough data yet',
    }
  }

  const n        = scores.length
  const avg      = scores.reduce((s, v) => s + v, 0) / n
  const variance = scores.reduce((s, v) => s + (v - avg) ** 2, 0) / n
  const stddev   = Math.sqrt(variance)

  const firstHalf  = scores.slice(0, Math.floor(n / 2))
  const secondHalf = scores.slice(Math.floor(n / 2))
  const firstAvg   = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length
  const secondAvg  = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length
  const halfDelta  = secondAvg - firstAvg

  const lastDir = scores[n - 1] >= scores[n - 2] ? 'up' : 'down'
  let streak = 1
  for (let i = n - 2; i > 0; i--) {
    const dir = scores[i] >= scores[i - 1] ? 'up' : 'down'
    if (dir === lastDir) streak++
    else break
  }

  let weekOverWeekDelta = Math.round(halfDelta)
  if (scores.length >= 14) {
    const prevWeekAvg = scores.slice(-14, -7).reduce((s, v) => s + v, 0) / 7
    const thisWeekAvg = scores.slice(-7).reduce((s, v) => s + v, 0) / 7
    weekOverWeekDelta = Math.round(thisWeekAvg - prevWeekAvg)
  }

  let classification: TrendClassification
  if      (stddev > 20)                            classification = 'volatile'
  else if (halfDelta > 8  && lastDir === 'up')     classification = 'improving'
  else if (halfDelta < -8 && lastDir === 'down')   classification = 'declining'
  else if (stddev < 8 && avg >= 50)                classification = 'consistent'
  else                                             classification = 'stagnant'

  const direction = halfDelta > 3 ? 'up' : halfDelta < -3 ? 'down' : 'flat'

  const descriptions: Record<TrendClassification, string> = {
    improving:         `Improving — up ${Math.abs(Math.round(halfDelta))} pts over last ${n} days`,
    declining:         `Declining — down ${Math.abs(Math.round(halfDelta))} pts over last ${n} days`,
    volatile:          `Volatile — ${Math.round(stddev)} pt swing day-to-day`,
    consistent:        `Consistent — steady at ~${Math.round(avg)}/100`,
    stagnant:          `Flat — little change recently`,
    insufficient_data: 'Not enough data yet',
  }

  return { classification, direction, streak, weekOverWeekDelta, description: descriptions[classification] }
}

export function trendDayFromInputs(date: string, inputs: DayInputs): TrendDay {
  const breakdown = computeBreakdown(inputs)
  return {
    date,
    score: breakdown.total,
    breakdown,
    inputs: {
      completedHigh:   inputs.completedHigh,
      completedMedium: inputs.completedMedium,
      completedLow:    inputs.completedLow,
      statusUpdates:   inputs.statusUpdates,
      hasEodLog:       inputs.hasEodLog,
    },
  }
}
