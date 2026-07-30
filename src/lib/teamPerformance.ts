/**
 * Team Performance — the management layer.
 *
 * The old team page showed metrics and left the owner to work out what they
 * meant. This module turns those metrics into the conclusions the owner
 * actually asks for: who is best, who is weakest, who is slipping, who is not
 * using the system, and what to do about each.
 *
 * Everything here is pure and deterministic. No AI, no external calls, no
 * randomness — every statement the page makes has to be reproducible from the
 * numbers, because the owner will be repeating these statements to people.
 *
 * The rule the whole file obeys: never assert something the data cannot
 * support. Where a metric has no reliable source, it is absent rather than
 * zero, and `insufficient_data` is a real, displayable outcome.
 */

import type { ScoreBreakdown, StuckTask, TrendDay } from '@/lib/types'
import type { HolidayCoverage, ResolvedPeriod } from '@/lib/performanceCalendar'
import type { ExcludedUser } from '@/lib/performanceEligibility'
import {
  type AdoptionMetrics, adoptionRate, avgFirstOpenLabel, hasAdoptionData,
} from '@/lib/performanceAdoption'
import { istDateOf, istDayStartUtc } from '@/lib/istDate'

// ─── Meaningful activity ──────────────────────────────────────────────────────

/**
 * What counts as actually using the system on a given day.
 *
 * Deliberately NOT login. Someone can sign in every morning, touch nothing and
 * look engaged; the owner's question is who is *working* in Task Management,
 * not who authenticated. There is also no login-event table to read, so a
 * login-based metric would have to be invented.
 *
 * Every action here leaves a row in task_activity_log or daily_work_logs, so
 * the metric is reconstructable for any past day.
 */
export const MEANINGFUL_ACTIONS: ReadonlySet<string> = new Set([
  'created',
  'acknowledged',
  'status_changed',
  'note_added',
  'comment_added',
  'due_date_changed',
  'priority_changed',
  'title_changed',
  'waiting',
  'working',
  'task_copied',
  'delegated',
  'escalated',
])

export function isMeaningfulAction(action: string): boolean {
  return MEANINGFUL_ACTIONS.has(action)
}

/**
 * Days on which the employee did something real. An EOD submission counts on
 * its own — writing up the day is meaningful work — but it is tracked
 * separately too, so "only submits EOD, never touches a task" stays visible.
 */
export function meaningfulActiveDays(
  eligibleDates: readonly string[],
  events: readonly { action: string; created_at: string }[],
  eodDates: ReadonlySet<string>,
): { activeDays: number; activeDates: Set<string>; eodOnlyDays: number } {
  const eligible  = new Set(eligibleDates)
  const taskDates = new Set<string>()

  for (const e of events) {
    if (!isMeaningfulAction(e.action)) continue
    const d = istDateOf(e.created_at)
    if (eligible.has(d)) taskDates.add(d)
  }

  const activeDates = new Set(taskDates)
  let eodOnlyDays = 0
  for (const d of eodDates) {
    if (!eligible.has(d)) continue
    if (!taskDates.has(d)) eodOnlyDays++
    activeDates.add(d)
  }

  return { activeDays: activeDates.size, activeDates, eodOnlyDays }
}

// ─── EOD submission timing ────────────────────────────────────────────────────

/**
 * Hour (IST) by which an EOD is expected. After this it is late but still
 * counted as submitted; a day that ends with nothing at all is missed.
 *
 * There is no settings table in the schema to read a company cutoff from
 * (migration 20260706000000 records the same absence), so this is a documented
 * constant. It sits after the working-day cutoff so a normal end-of-day
 * write-up is never marked late.
 */
export const EOD_ONTIME_HOUR = 21

export type EodStatus = 'on_time' | 'late' | 'missed' | 'pending'

/**
 * Classify one expected EOD.
 *
 * `submittedAt` null means nothing was filed: missed once the day's cutoff has
 * passed, pending until then. A write-up filed the following morning for
 * yesterday is late, not on time — that is the behaviour the owner is asking
 * about.
 */
export function classifyEodSubmission(
  logDate: string,
  submittedAt: string | null,
  cutoffPassed: boolean,
  cutoffHour: number = EOD_ONTIME_HOUR,
): EodStatus {
  if (submittedAt === null) return cutoffPassed ? 'missed' : 'pending'
  const deadline = Date.parse(istDayStartUtc(logDate)) + cutoffHour * 3600_000
  return Date.parse(submittedAt) <= deadline ? 'on_time' : 'late'
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

/** One employee's measured period. Assembled server-side; never recomputed on the client. */
export type MemberMetrics = {
  userId:   string
  userName: string
  team:     string
  position: string | null

  // Period shape
  eligibleDays: number    // expected working days in the period
  activeDays:   number    // of those, days with meaningful system activity
  scoredDays:   number    // days that carried a score (excludes provisional today)
  /** Days where the only activity was an EOD write-up — no task was touched. */
  eodOnlyDays:  number

  // Previous-period shape. Carried so "improved / declined" can prove it compared
  // like with like: a 22-day month against a 4-day stub is not a comparison, and
  // without these two numbers the page could not show that it wasn't.
  prevEligibleDays: number
  prevScoredDays:   number

  // Score
  score:      number | null   // period average; null when nothing was measurable
  prevScore:  number | null
  breakdown:  ScoreBreakdown | null   // the most recent scored day, for drill-down
  /**
   * Best scored day minus worst scored day. Null when fewer than two days were
   * scored. Held on the metrics rather than passed alongside them, so the status
   * shown in the table cannot be computed from a different spread than the status
   * shown in the drawer.
   */
  scoreSpread: number | null

  /**
   * System Adoption. Reported beside the score, never inside it — see
   * lib/performanceAdoption.ts for why.
   */
  adoption: AdoptionMetrics

  // Task execution
  tasksCompleted:       number
  tasksCompletedOnTime: number
  tasksCompletedLate:   number
  tasksWithDueDate:     number   // denominator for the on-time rate
  tasksCreatedSelf:     number
  tasksCreatedDelegated: number
  prevTasksCompleted:   number

  // Current portfolio (state now, not period totals)
  activeTasks:          number
  overdueCount:         number
  highPriorityOverdue:  number
  oldestOverdueDays:    number   // 0 when nothing is overdue
  staleBlockedCount:    number
  waitingCount:         number
  blockedCount:         number

  // Acknowledgement
  acksTotal:   number
  acksOnTime:  number

  // EOD
  eodSubmitted: number
  eodOnTime:    number
  eodLate:      number
  eodMissed:    number
  eodStreak:    number

  // Momentum
  statusUpdates: number
}

// ─── Derived rates ────────────────────────────────────────────────────────────
// Each returns null rather than 0 when the denominator is empty. A person who
// completed no dated tasks has no on-time rate; showing them 0% would read as
// "never on time", which is a different and false claim.

export function onTimeCompletionRate(m: MemberMetrics): number | null {
  if (m.tasksWithDueDate === 0) return null
  return Math.round(m.tasksCompletedOnTime / m.tasksWithDueDate * 100)
}

export function eodOnTimeRate(m: MemberMetrics): number | null {
  const expected = m.eodOnTime + m.eodLate + m.eodMissed
  if (expected === 0) return null
  return Math.round(m.eodOnTime / expected * 100)
}

export function activeDayRate(m: MemberMetrics): number | null {
  if (m.eligibleDays === 0) return null
  return Math.round(m.activeDays / m.eligibleDays * 100)
}

export function ackOnTimeRate(m: MemberMetrics): number | null {
  if (m.acksTotal === 0) return null
  return Math.round(m.acksOnTime / m.acksTotal * 100)
}

export function scoreDelta(m: MemberMetrics): number | null {
  if (m.score === null || m.prevScore === null) return null
  return m.score - m.prevScore
}

export function tasksCreatedTotal(m: MemberMetrics): number {
  return m.tasksCreatedSelf + m.tasksCreatedDelegated
}

// ─── The minimum-data rule ────────────────────────────────────────────────────
/**
 * ONE threshold, used everywhere.
 *
 * Previously there were two — `THRESHOLDS.minDaysForVerdict` for the table status
 * and a separate `MIN_DAYS_FOR_RANKING` for the superlatives — which both happened
 * to be 3. Two constants that agree by coincidence are one edit away from a page
 * that calls someone "Insufficient Data" in the table and names them Best
 * Performer in the card above it. There is now a single value and a single
 * predicate, and the summary cards, the table status, the rankings, the drawer and
 * the "How ranking works" panel all read them.
 *
 * Three scored days is the floor because two days cannot show a trend and one day
 * cannot show anything: a single good Tuesday is not a verdict on a month.
 */
export const MIN_SCORED_DAYS_FOR_RANKING = 3

/**
 * Plain-language statement of the rule, rendered in the ranking-information
 * panel. Kept next to the constant so the two cannot disagree.
 */
export const MIN_DATA_RULE_TEXT =
  `An employee is ranked only after ${MIN_SCORED_DAYS_FOR_RANKING} scored working days in the `
  + `selected period. Fewer than that and they are shown as "Insufficient Data": still `
  + `listed, with their real figures, but not eligible to be named best, weakest, most `
  + `improved or most declined, and not placed in a top or bottom five.`

/**
 * Enough measured days in the selected period to draw a conclusion?
 *
 * Requires eligible days at all — someone who joined after the period ended, or
 * left before it began, has an empty period rather than a bad one — and a score,
 * which is null when no day was measurable.
 */
export function hasSufficientData(m: MemberMetrics): boolean {
  return m.eligibleDays > 0
      && m.score !== null
      && m.scoredDays >= MIN_SCORED_DAYS_FOR_RANKING
}

/** May this employee appear in a measured ranking? Identical to hasSufficientData, named for the call site. */
export function isRankable(m: MemberMetrics): boolean {
  return hasSufficientData(m)
}

/**
 * May this employee be compared against the previous period?
 *
 * Both periods must independently clear the minimum. A month measured against a
 * two-day stub of the previous month produces a spectacular delta that means
 * nothing, and "Most Improved" is exactly where that error would surface.
 */
export function isComparable(m: MemberMetrics): boolean {
  return isRankable(m)
      && m.prevScore !== null
      && m.prevScoredDays >= MIN_SCORED_DAYS_FOR_RANKING
}

/** Why this employee is not ranked, for display. Null when they are. */
export function insufficientDataReason(m: MemberMetrics): string | null {
  if (m.eligibleDays === 0) return 'No expected working days in this period'
  if (m.score === null || m.scoredDays === 0) return 'No scored working days in this period yet'
  if (m.scoredDays < MIN_SCORED_DAYS_FOR_RANKING) {
    return `Only ${m.scoredDays} scored day${m.scoredDays === 1 ? '' : 's'} `
         + `(${MIN_SCORED_DAYS_FOR_RANKING} needed to rank)`
  }
  return null
}

// ─── Official ranking order ───────────────────────────────────────────────────

/**
 * Weighted overdue severity — lower is better.
 *
 * A single tie-break number for overdue work, weighted so that the thing a
 * manager actually cares about dominates: a high-priority task three days late is
 * worse than three low-priority tasks one day late.
 *
 *   high-priority overdue   × 3
 *   other overdue           × 1
 *   oldest overdue, in days × 0.5
 *
 * Age is halved rather than counted whole so that one very old task cannot swamp
 * a genuinely larger backlog. This is a tie-breaker, not a score component — it
 * never touches the four pillar weights.
 */
export function overdueWeightedSeverity(m: MemberMetrics): number {
  const other = Math.max(0, m.overdueCount - m.highPriorityOverdue)
  return m.highPriorityOverdue * 3 + other + m.oldestOverdueDays * 0.5
}

/**
 * The official Overall Performance order, applied in exactly this sequence:
 *
 *   1. Period score                    highest first
 *   2. Meaningful active-day rate      highest first
 *   3. On-time completion rate         highest first, where available
 *   4. EOD on-time rate                highest first, where available
 *   5. Weighted overdue severity       lowest first
 *   6. Employee name                   A→Z, stable final tie-break only
 *
 * "Where available" is load-bearing. A tie-break step decides only when **both**
 * employees have that measurement; if either is missing it, the step is skipped
 * and the next one is tried. Two wrong alternatives were considered first:
 *
 *   Treat a missing rate as 0%   Then "completed no tasks with a due date" and
 *                                "missed every single deadline" become the same
 *                                claim. They are not, and only one is a criticism.
 *   Sort missing last            Then having no dated tasks ranks *below* missing
 *                                every deadline — worse than treating it as 0%,
 *                                and a straightforwardly false verdict.
 *
 * Skipping is the only option that avoids asserting something the data does not
 * say. An absent measurement is not evidence against anyone, so it is not used as
 * evidence in either direction.
 *
 * (The score at step 1 still sorts null last, purely defensively — a member with
 * no score is not rankable and never reaches this comparator through
 * `overallRanking`.)
 *
 * Raw task count is deliberately NOT a tie-breaker at any position. Creating
 * tasks is a signal the page reports, but making it break ties would reward
 * whoever types the most, which is the one incentive nobody wants.
 *
 * Step 6 guarantees determinism: two employees identical on steps 1–5 always come
 * out in the same order, so the same period never renders two different rankings.
 */
export const OVERALL_TIE_BREAKERS: readonly string[] = [
  'Period score, highest first',
  'Meaningful active-day rate, highest first',
  'On-time task completion rate, highest first — skipped when either employee has no dated tasks, never read as 0%',
  'EOD punctuality rate, highest first — skipped when either employee had no EOD expected, never read as 0%',
  'Weighted overdue severity, lowest first (high-priority ×3, other ×1, oldest-overdue days ×0.5)',
  'Employee name A–Z, only to keep the order stable for exact ties',
] as const

/** Descending comparator for a nullable value: higher first, null last. */
function descNullsLast(a: number | null, b: number | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return b - a
}

/**
 * Descending tie-break step that abstains when either side has no measurement.
 * Returns 0 — "this step cannot separate them" — rather than inventing an order.
 */
function descIfBothKnown(a: number | null, b: number | null): number {
  if (a === null || b === null) return 0
  return b - a
}

/**
 * Compare two employees by the official Overall order. Negative means `a` ranks
 * higher. Use this everywhere Overall rank is needed — the summary card, the
 * table, the rankings tab and the drawer all sort through this one function, so
 * they cannot disagree about who is first.
 */
export function compareOverall(a: MemberMetrics, b: MemberMetrics): number {
  return descNullsLast(a.score, b.score)
      || descIfBothKnown(activeDayRate(a), activeDayRate(b))
      || descIfBothKnown(onTimeCompletionRate(a), onTimeCompletionRate(b))
      || descIfBothKnown(eodOnTimeRate(a), eodOnTimeRate(b))
      || (overdueWeightedSeverity(a) - overdueWeightedSeverity(b))
      || a.userName.localeCompare(b.userName)
}

/**
 * Official Overall ranking: rankable employees only, best first.
 *
 * Insufficient-data employees are absent by construction rather than filtered out
 * later, which is what keeps them from appearing in a top or bottom five.
 */
export function overallRanking(members: readonly MemberMetrics[]): MemberMetrics[] {
  return members.filter(isRankable).sort(compareOverall)
}

/** 1-based Overall position, or null when the employee is not rankable. */
export function overallRankOf(members: readonly MemberMetrics[], userId: string): number | null {
  const idx = overallRanking(members).findIndex(m => m.userId === userId)
  return idx === -1 ? null : idx + 1
}

// ─── Operational status ───────────────────────────────────────────────────────

export type OperationalStatus =
  | 'strong'
  | 'performing_well'
  | 'improving'
  | 'stable'
  | 'inconsistent'
  | 'low_activity'
  | 'declining'
  | 'critical_attention'
  | 'insufficient_data'

export const STATUS_LABEL: Record<OperationalStatus, string> = {
  strong:             'Strong',
  performing_well:    'Performing Well',
  improving:          'Improving',
  stable:             'Stable',
  inconsistent:       'Inconsistent',
  low_activity:       'Low Activity',
  declining:          'Declining',
  critical_attention: 'Critical Attention',
  insufficient_data:  'Insufficient Data',
}

/** Ordered worst-first — drives the "needs attention" sort and the colour ramp. */
export const STATUS_SEVERITY: Record<OperationalStatus, number> = {
  critical_attention: 0,
  declining:          1,
  low_activity:       2,
  inconsistent:       3,
  insufficient_data:  4,
  stable:             5,
  improving:          6,
  performing_well:    7,
  strong:             8,
}

export type Classification = {
  status: OperationalStatus
  /** Plain-language evidence, e.g. "Up 14 points versus last month". */
  reason: string
}

/** Thresholds, named so the page and the tests agree on what the words mean. */
export const THRESHOLDS = {
  strongScore:        70,
  goodScore:          58,
  weakScore:          40,
  criticalScore:      30,
  movement:            8,   // points of change that count as improving/declining
  volatility:         25,   // score spread that counts as inconsistent
  lowActivityRate:    60,   // % of eligible days active
  /**
   * Not an independent number — the single minimum-data rule, aliased so the
   * existing call sites keep reading naturally. Changing the rule means changing
   * MIN_SCORED_DAYS_FOR_RANKING, and every consumer moves with it.
   */
  minDaysForVerdict: MIN_SCORED_DAYS_FOR_RANKING,
  overdueConcern:      3,
  /**
   * EOD punctuality at or above this is healthy, so a small number of misses is
   * not a finding on its own. Without this, 2 misses out of 25 read as a
   * discipline problem.
   */
  eodHealthyRate:     80,
  /** This many misses is a finding regardless of rate. */
  eodMissAlways:       4,
  staleConcern:        2,
  eodMissConcern:      2,
  lowOnTimeRate:      60,
} as const

/**
 * Classify an employee from the selected period and the one before it.
 *
 * Order matters: the most actionable finding wins. Someone who is barely using
 * the system is "Low Activity" even if the handful of days they did work scored
 * well — the score of three days is not a verdict on twenty.
 *
 * The insufficient-data test is the shared `hasSufficientData`, so an employee
 * labelled "Insufficient Data" here is exactly the set excluded from every
 * ranking. The score spread is read from the metrics rather than passed in
 * separately, which removes the last way the table and the drawer could disagree.
 */
export function classifyMember(m: MemberMetrics): Classification {
  const delta    = scoreDelta(m)
  const activePc = activeDayRate(m)
  const spread   = m.scoreSpread

  // Nothing measurable to judge. Same rule the rankings apply.
  if (!hasSufficientData(m)) {
    return {
      status: 'insufficient_data',
      reason: insufficientDataReason(m) ?? 'Not enough measured days in this period',
    }
  }

  // Not using the system is the finding, whatever the few active days scored.
  if (activePc !== null && activePc < THRESHOLDS.lowActivityRate) {
    return {
      status: 'low_activity',
      reason: `Active on only ${m.activeDays} of ${m.eligibleDays} eligible working days`,
    }
  }

  if (m.score! < THRESHOLDS.criticalScore) {
    return { status: 'critical_attention', reason: `Period score ${m.score}/100` }
  }

  if (delta !== null && isComparable(m) && delta <= -THRESHOLDS.movement) {
    return { status: 'declining', reason: `Down ${Math.abs(delta)} points versus the previous period` }
  }

  if (delta !== null && isComparable(m) && delta >= THRESHOLDS.movement) {
    return { status: 'improving', reason: `Up ${delta} points versus the previous period` }
  }

  if (m.score! >= THRESHOLDS.strongScore) {
    return { status: 'strong', reason: `Holding ${m.score}/100 across ${m.scoredDays} days` }
  }
  if (m.score! >= THRESHOLDS.goodScore) {
    return { status: 'performing_well', reason: `Steady at ${m.score}/100` }
  }
  if (m.score! < THRESHOLDS.weakScore) {
    return { status: 'critical_attention', reason: `Period score ${m.score}/100` }
  }

  // Day-to-day variation, checked LAST among the mid-range outcomes.
  //
  // It used to be checked before improving/strong/performing_well, which meant a
  // wide spread masked every stronger statement. On real data that labelled 7 of 10
  // employees "Inconsistent" — including the top performer at 76/100 and the most
  // improved at +36 — because the daily score naturally swings by 40-60 points
  // depending on how many high-priority tasks a day happened to contain.
  //
  // "Inconsistent" is a weaker claim than "Strong", "Improving" or "Declining", so
  // it must not pre-empt them. It now describes only mid-range performers with no
  // clearer story, in place of "Stable".
  if (spread !== null && spread > THRESHOLDS.volatility) {
    return { status: 'inconsistent', reason: `Score varied by ${spread} points across active days` }
  }
  return { status: 'stable', reason: `Steady at ${m.score}/100` }
}

// ─── Attention severity — ONE calculation ─────────────────────────────────────
/**
 * There is exactly one severity model, and four consumers read it:
 *
 *   - the "Needs Immediate Attention" summary card
 *   - the owner's attention briefing
 *   - the default table sort
 *   - the employee drawer's concerns list
 *
 * Before this, the briefing sorted by an ad-hoc `weight` number while the table
 * sorted by `STATUS_SEVERITY` and the card took whatever the briefing happened to
 * put first. Three orderings meant the card could name one person while the table
 * put someone else at the top — and an owner who spots that stops trusting the
 * page, correctly.
 *
 * Concern order, worst first. Ranks 1–8 are the management order the owner
 * specified:
 *
 *   1  Critical high-priority overdue work
 *   2  Long-duration overdue work
 *   3  Very low meaningful activity
 *   4  Repeated missed EOD
 *   5  Sharp period decline
 *   6  Low on-time completion
 *   7  Stale blocked or waiting work
 *   8  Low period score
 *
 * Ranks 9–12 are supplementary findings that pre-date this ordering and are worth
 * surfacing but are strictly less urgent than all eight above. They are ranked
 * below rather than interleaved, so the specified order is never disturbed.
 *
 *   9  Overdue backlog with nothing high-priority and nothing old
 *  10  Repeatedly late EOD
 *  11  EOD filed with no task activity
 *  12  Open tasks with no status updates
 */
export type AttentionCategory =
  | 'high_priority_overdue'
  | 'long_overdue'
  | 'very_low_activity'
  | 'repeated_missed_eod'
  | 'sharp_decline'
  | 'low_on_time'
  | 'stale_blocked'
  | 'low_score'
  | 'overdue_backlog'
  | 'late_eod'
  | 'eod_without_activity'
  | 'no_status_updates'

/** Index + 1 is the rank. Single source for the concern order. */
export const ATTENTION_CATEGORY_ORDER: readonly AttentionCategory[] = [
  'high_priority_overdue',
  'long_overdue',
  'very_low_activity',
  'repeated_missed_eod',
  'sharp_decline',
  'low_on_time',
  'stale_blocked',
  'low_score',
  'overdue_backlog',
  'late_eod',
  'eod_without_activity',
  'no_status_updates',
] as const

export function attentionRankOf(category: AttentionCategory): number {
  return ATTENTION_CATEGORY_ORDER.indexOf(category) + 1
}

export type AttentionSeverity = 'critical' | 'warning'

export type AttentionFinding = {
  category: AttentionCategory
  /** 1 = most concerning. Position in ATTENTION_CATEGORY_ORDER. */
  rank:     number
  /** Size of this instance, used only to order two people in the same category. */
  magnitude: number
  severity: AttentionSeverity
  /** The finding, in the owner's language. */
  issue:    string
  /** The number or duration behind it. Never a vague adjective. */
  evidence: string
  /** What to do about it. */
  action:   string
}

/**
 * Every finding for one employee, worst first.
 *
 * Each rule needs a hard number behind it. "Seems disengaged" is not a finding;
 * "active on 9 of 22 working days" is.
 *
 * Findings that depend on a previous-period comparison are gated on
 * `isComparable`, so a decline is never reported from a two-day previous stub.
 */
export function attentionFindings(m: MemberMetrics): AttentionFinding[] {
  const out: AttentionFinding[] = []
  const push = (
    category: AttentionCategory,
    magnitude: number,
    severity: AttentionSeverity,
    issue: string,
    evidence: string,
    action: string,
  ) => { out.push({ category, rank: attentionRankOf(category), magnitude, severity, issue, evidence, action }) }

  // 1 — high-priority work already past its date.
  if (m.highPriorityOverdue > 0) {
    push('high_priority_overdue',
      m.highPriorityOverdue * 10 + m.oldestOverdueDays, 'critical',
      'High-priority task overdue',
      `${m.highPriorityOverdue} high-priority task${m.highPriorityOverdue === 1 ? '' : 's'} overdue`
        + (m.oldestOverdueDays > 0 ? `, oldest by ${m.oldestOverdueDays} days` : ''),
      'Review the oldest high-priority overdue task')
  }

  // 2 — anything overdue long enough that the plan has stopped being a plan.
  if (m.oldestOverdueDays >= 7) {
    push('long_overdue', m.oldestOverdueDays, 'critical',
      'Task overdue beyond a week',
      `Oldest overdue task is ${m.oldestOverdueDays} days past its due date`,
      'Decide whether to reassign, re-scope or drop it')
  }

  // 3 — not using the system at all.
  const activePc = activeDayRate(m)
  if (activePc !== null
      && m.eligibleDays >= MIN_SCORED_DAYS_FOR_RANKING
      && activePc < THRESHOLDS.lowActivityRate) {
    const inactive = m.eligibleDays - m.activeDays
    push('very_low_activity', inactive, 'critical',
      'Not using Task Management',
      `No meaningful activity on ${inactive} of ${m.eligibleDays} eligible working days`,
      `Discuss low system usage across ${inactive} working days`)
  }

  // 4 — the daily write-up simply not arriving.
  //
  // Rate-aware, not just a raw count. On real data the bare `>= 2` test flagged
  // the top performer — 2 missed out of 25, i.e. 92% punctuality — and made
  // "Review repeated missed EOD submissions" her single recommended action. Two
  // misses in a month is not a discipline problem; two misses out of five is.
  // So a small absolute count only counts as a finding when the rate is also weak.
  const eodPunctuality = eodOnTimeRate(m)
  const eodRateIsWeak  = eodPunctuality === null || eodPunctuality < THRESHOLDS.eodHealthyRate
  if (m.eodMissed >= THRESHOLDS.eodMissConcern
      && (m.eodMissed >= THRESHOLDS.eodMissAlways || eodRateIsWeak)) {
    push('repeated_missed_eod', m.eodMissed, m.eodMissed >= 3 ? 'critical' : 'warning',
      'Missed EOD submissions',
      `${m.eodMissed} EOD${m.eodMissed === 1 ? '' : 's'} missed this period`
        + (eodPunctuality !== null ? ` (${eodPunctuality}% submitted on time)` : ''),
      'Review repeated missed EOD submissions')
  }

  // 5 — a real fall against a comparable previous period.
  const delta = isComparable(m) ? scoreDelta(m) : null
  if (delta !== null && delta <= -THRESHOLDS.movement) {
    const sharp = delta <= -THRESHOLDS.movement * 2
    push('sharp_decline', Math.abs(delta), sharp ? 'critical' : 'warning',
      sharp ? 'Sharp performance decline' : 'Performance declining',
      `Score ${sharp ? 'fell' : 'down'} ${Math.abs(delta)} points versus the previous period `
        + `(${m.prevScore} → ${m.score})`,
      sharp ? 'Ask what changed since the previous period' : 'Check for workload or blocker changes')
  }

  // 6 — deadlines being set and then missed.
  const onTime = onTimeCompletionRate(m)
  if (onTime !== null && m.tasksWithDueDate >= 3 && onTime < THRESHOLDS.lowOnTimeRate) {
    push('low_on_time', 100 - onTime, 'warning',
      'Low on-time completion',
      `${onTime}% of ${m.tasksWithDueDate} dated tasks finished on time`,
      'Review how due dates are being set and met')
  }

  // 7 — blocked or waiting work nobody is moving.
  if (m.staleBlockedCount >= THRESHOLDS.staleConcern) {
    push('stale_blocked', m.staleBlockedCount, 'warning',
      'Blocked work going stale',
      `${m.staleBlockedCount} blocked tasks with no update for over ${THRESHOLDS.staleConcern} days`,
      'Clear or escalate the blockers')
  }

  // 8 — a genuinely low measured score, once there is enough data to say so.
  if (hasSufficientData(m) && m.score! < THRESHOLDS.weakScore) {
    push('low_score', THRESHOLDS.weakScore - m.score!,
      m.score! < THRESHOLDS.criticalScore ? 'critical' : 'warning',
      'Low period score',
      `Period score ${m.score}/100 across ${m.scoredDays} scored days`,
      'Review workload and blockers together')
  }

  // 9 — a backlog that rules 1 and 2 did not already catch.
  if (m.overdueCount >= THRESHOLDS.overdueConcern) {
    push('overdue_backlog', m.overdueCount, m.overdueCount >= 5 ? 'critical' : 'warning',
      'Overdue backlog',
      `${m.overdueCount} tasks past their due date`,
      'Triage the overdue list with them')
  }

  // 10 — arriving, but always after the cutoff.
  if (m.eodLate >= 2 && m.eodMissed < THRESHOLDS.eodMissConcern) {
    push('late_eod', m.eodLate, 'warning',
      'Repeatedly late EOD',
      `${m.eodLate} EOD submissions filed late`,
      'Agree a submission time with them')
  }

  // 11 — a write-up with no task touched all day is presence without work,
  // invisible to any "did they log in" metric.
  if (m.eodOnlyDays >= 3) {
    push('eod_without_activity', m.eodOnlyDays, 'warning',
      'EOD filed without task activity',
      `${m.eodOnlyDays} days with an EOD but no task updated`,
      'Ask why the work is not reflected in Task Management')
  }

  // 12 — a full plate and silence on all of it.
  if (m.activeTasks >= 8 && m.statusUpdates === 0) {
    push('no_status_updates', m.activeTasks, 'warning',
      'Active tasks with no updates',
      `${m.activeTasks} open tasks and no status updates this period`,
      'Check workload allocation and ask for status')
  }

  return out.sort((a, b) => a.rank - b.rank || b.magnitude - a.magnitude)
}

/** One employee's overall concern level. `rank` Infinity means nothing to flag. */
export type MemberSeverity = {
  findings:  AttentionFinding[]
  primary:   AttentionFinding | null
  rank:      number
  magnitude: number
}

export function memberSeverity(m: MemberMetrics): MemberSeverity {
  const findings = attentionFindings(m)
  const primary  = findings[0] ?? null
  return {
    findings,
    primary,
    rank:      primary ? primary.rank : Number.POSITIVE_INFINITY,
    magnitude: primary ? primary.magnitude : 0,
  }
}

/**
 * Order two employees by management concern. Negative means `a` needs attention
 * more urgently.
 *
 * Worst category first; within a category the larger instance; then the lower
 * score (nulls last, because "no data" is not "worst"); then name for stability.
 */
export function compareSeverity(a: MemberMetrics, b: MemberMetrics): number {
  const sa = memberSeverity(a), sb = memberSeverity(b)
  if (sa.rank !== sb.rank) return sa.rank - sb.rank
  if (sa.magnitude !== sb.magnitude) return sb.magnitude - sa.magnitude
  const scoreCmp = ascNullsLast(a.score, b.score)
  if (scoreCmp !== 0) return scoreCmp
  return a.userName.localeCompare(b.userName)
}

/** Ascending comparator for a nullable value: lower first, null last. */
function ascNullsLast(a: number | null, b: number | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a - b
}

/**
 * Employees ordered by concern, most concerning first. Severity is computed once
 * per member rather than inside the comparator, which would recompute every
 * finding O(n log n) times.
 */
export function sortBySeverity(members: readonly MemberMetrics[]): MemberMetrics[] {
  return members
    .map(m => ({ m, s: memberSeverity(m) }))
    .sort((x, y) =>
      x.s.rank - y.s.rank
      || y.s.magnitude - x.s.magnitude
      || ascNullsLast(x.m.score, y.m.score)
      || x.m.userName.localeCompare(y.m.userName))
    .map(e => e.m)
}

/**
 * The single employee the owner should deal with first, or null when nobody has a
 * finding. Read by the "Needs Immediate Attention" card, so the card and the top
 * of the briefing are guaranteed to name the same person.
 */
export function pickMostConcerning(members: readonly MemberMetrics[]): MemberMetrics | null {
  const withFindings = members.filter(m => memberSeverity(m).primary !== null)
  if (withFindings.length === 0) return null
  return sortBySeverity(withFindings)[0]
}

export type AttentionItem = {
  userId:   string
  userName: string
  severity: AttentionSeverity
  issue:    string
  evidence: string
  action:   string
  category: AttentionCategory
  /** Position in the concern order — 1 is worst. Replaces the old ad-hoc weight. */
  rank:     number
}

/**
 * The owner's briefing: at most one item per employee, so five names appear
 * rather than one name five times, ordered by the same severity model as
 * everything else.
 */
export function buildAttentionItems(members: readonly MemberMetrics[], limit = 5): AttentionItem[] {
  const out: AttentionItem[] = []
  for (const m of sortBySeverity(members)) {
    const primary = memberSeverity(m).primary
    if (!primary) continue
    out.push({
      userId: m.userId, userName: m.userName,
      severity: primary.severity,
      issue:    primary.issue,
      evidence: primary.evidence,
      action:   primary.action,
      category: primary.category,
      rank:     primary.rank,
    })
    if (out.length >= limit) break
  }
  return out
}

// ─── Positive items ───────────────────────────────────────────────────────────

export type PositiveItem = {
  userId:   string
  userName: string
  headline: string
  evidence: string
  weight:   number
}

/**
 * Praise has to be earned by a number too. No "keeping it up" or "good effort" —
 * if there is nothing measurable to say about someone, they do not appear.
 */
export function buildPositiveItems(members: MemberMetrics[], limit = 5): PositiveItem[] {
  const items: PositiveItem[] = []

  for (const m of members) {
    const base = { userId: m.userId, userName: m.userName }

    const onTime = onTimeCompletionRate(m)
    if (onTime !== null && onTime >= 90 && m.tasksWithDueDate >= 3) {
      items.push({
        ...base,
        headline: 'Best on-time completion',
        evidence: `${onTime}% of ${m.tasksWithDueDate} dated tasks finished on time`,
        weight:   90 + onTime / 10,
      })
    }

    // Gated on isComparable: praising a rise measured against a two-day stub of
    // the previous period would be praising an artefact.
    const delta = isComparable(m) ? scoreDelta(m) : null
    if (delta !== null && delta >= THRESHOLDS.movement) {
      items.push({
        ...base,
        headline: 'Strongest improvement',
        evidence: `Score up ${delta} points versus the previous period (${m.prevScore} → ${m.score})`,
        weight:   85 + delta,
      })
    }

    if (m.eodStreak >= 5) {
      items.push({
        ...base,
        headline: 'EOD punctuality streak',
        evidence: `${m.eodStreak} consecutive working days with EOD submitted`,
        weight:   70 + m.eodStreak,
      })
    }

    const eodPc = eodOnTimeRate(m)
    if (eodPc === 100 && m.eodOnTime >= 5) {
      items.push({
        ...base,
        headline: 'Perfect EOD discipline',
        evidence: `All ${m.eodOnTime} EODs submitted on time`,
        weight:   80,
      })
    }

    if (m.score !== null && m.score >= THRESHOLDS.strongScore && m.scoredDays >= 5) {
      items.push({
        ...base,
        headline: 'Consistently strong score',
        evidence: `Averaged ${m.score}/100 across ${m.scoredDays} working days`,
        weight:   75 + (m.score - THRESHOLDS.strongScore),
      })
    }

    if (m.overdueCount === 0 && m.staleBlockedCount === 0 && m.activeTasks >= 3 && m.tasksCompleted >= 3) {
      items.push({
        ...base,
        headline: 'Clean task flow',
        evidence: `${m.tasksCompleted} completed, nothing overdue or stale across ${m.activeTasks} open tasks`,
        weight:   65 + m.tasksCompleted,
      })
    }

    const activePc = activeDayRate(m)
    if (activePc === 100 && m.eligibleDays >= 5) {
      items.push({
        ...base,
        headline: 'Full system usage',
        evidence: `Meaningful activity on all ${m.eligibleDays} eligible working days`,
        weight:   60,
      })
    }
  }

  const sorted = [...items].sort((a, b) =>
    b.weight - a.weight || a.userName.localeCompare(b.userName)
  )
  const seen = new Set<string>()
  const out: PositiveItem[] = []
  for (const item of sorted) {
    if (seen.has(item.userId)) continue
    seen.add(item.userId)
    out.push(item)
    if (out.length >= limit) break
  }
  return out
}

// ─── Superlatives ─────────────────────────────────────────────────────────────
// Each returns null when nobody qualifies — an empty team, or a team where nobody
// has enough measured days. Naming a "best performer" out of one scored day would
// be worse than naming nobody.
//
// All four read the shared pools (isRankable / isComparable) and the shared
// comparator (compareOverall), so the card at the top of the page and the ranking
// table further down cannot select different people.

export function rankablePool(members: readonly MemberMetrics[]): MemberMetrics[] {
  return members.filter(isRankable)
}

export function comparablePool(members: readonly MemberMetrics[]): MemberMetrics[] {
  return members.filter(isComparable)
}

/** Employees present but not ranked, with the reason. Shown, never hidden. */
export function unrankedPool(members: readonly MemberMetrics[]): { member: MemberMetrics; reason: string }[] {
  return members
    .filter(m => !isRankable(m))
    .map(m => ({ member: m, reason: insufficientDataReason(m) ?? 'Not enough measured days' }))
    .sort((a, b) => a.member.userName.localeCompare(b.member.userName))
}

/** Best by the official Overall order, including every documented tie-breaker. */
export function pickBestPerformer(members: readonly MemberMetrics[]): MemberMetrics | null {
  const pool = overallRanking(members)
  return pool.length === 0 ? null : pool[0]
}

/**
 * Weakest **measured** performer — the last place in the same official order, not
 * a separate "lowest score" rule. Using one order for both ends means the person
 * named weakest is always the person at the bottom of the Overall ranking.
 */
export function pickWeakestPerformer(members: readonly MemberMetrics[]): MemberMetrics | null {
  const pool = overallRanking(members)
  return pool.length === 0 ? null : pool[pool.length - 1]
}

/**
 * Most improved against the equivalent previous period.
 *
 * Requires the minimum data in *both* periods (isComparable). Ties break on the
 * higher current score — if two people both gained 12 points, the one now at 78
 * is the better story than the one now at 51 — then on name.
 */
export function pickMostImproved(members: readonly MemberMetrics[]): MemberMetrics | null {
  const pool = comparablePool(members).filter(m => scoreDelta(m)! > 0)
  if (pool.length === 0) return null
  return pool.sort((a, b) =>
    scoreDelta(b)! - scoreDelta(a)!
    || descNullsLast(a.score, b.score)
    || a.userName.localeCompare(b.userName))[0]
}

/** Most declined, same both-period requirement. Ties break on the lower current score. */
export function pickMostDeclined(members: readonly MemberMetrics[]): MemberMetrics | null {
  const pool = comparablePool(members).filter(m => scoreDelta(m)! < 0)
  if (pool.length === 0) return null
  return pool.sort((a, b) =>
    scoreDelta(a)! - scoreDelta(b)!
    || ascNullsLast(a.score, b.score)
    || a.userName.localeCompare(b.userName))[0]
}

/**
 * The period comparison, with the evidence that it was a fair one.
 *
 * The two day-counts are the point: without them "up 14 points" could be a
 * 22-day month against a 3-day stub, and the reader would have no way to tell.
 */
export type PeriodComparison = {
  score:            number | null
  prevScore:        number | null
  delta:            number | null
  eligibleDays:     number
  prevEligibleDays: number
  scoredDays:       number
  prevScoredDays:   number
  /** True when both periods clear the minimum-data rule. */
  comparable:       boolean
  /** Why not, when it isn't. */
  note:             string | null
}

export function periodComparison(m: MemberMetrics): PeriodComparison {
  const comparable = isComparable(m)
  let note: string | null = null
  if (!comparable) {
    if (!isRankable(m)) {
      note = insufficientDataReason(m) ?? 'Not enough measured days in this period'
    } else if (m.prevScore === null || m.prevScoredDays === 0) {
      note = 'No measured days in the previous period to compare against'
    } else {
      note = `Only ${m.prevScoredDays} scored day${m.prevScoredDays === 1 ? '' : 's'} in the `
           + `previous period (${MIN_SCORED_DAYS_FOR_RANKING} needed to compare)`
    }
  }
  return {
    score: m.score, prevScore: m.prevScore,
    delta: comparable ? scoreDelta(m) : null,
    eligibleDays: m.eligibleDays, prevEligibleDays: m.prevEligibleDays,
    scoredDays: m.scoredDays, prevScoredDays: m.prevScoredDays,
    comparable, note,
  }
}

// ─── Filtering, searching, sorting ────────────────────────────────────────────

export const SORT_KEYS = [
  'needs_attention', 'official_rank', 'best_score', 'lowest_score',
  'most_improved', 'most_declined',
  'highest_overdue', 'best_on_time', 'best_eod', 'least_active',
  'most_completed', 'most_created', 'lowest_adoption',
] as const
export type SortKey = typeof SORT_KEYS[number]

export const SORT_LABEL: Record<SortKey, string> = {
  needs_attention: 'Needs Attention',
  official_rank:   'Official Rank',
  best_score:      'Best Score',
  lowest_score:    'Lowest Score',
  most_improved:   'Most Improved',
  most_declined:   'Most Declined',
  highest_overdue: 'Highest Overdue',
  best_on_time:    'Best On-Time Completion',
  best_eod:        'Best EOD Punctuality',
  least_active:    'Least Active',
  most_completed:  'Most Tasks Completed',
  most_created:    'Most Tasks Created',
  lowest_adoption: 'Weakest Adoption',
}

export function filterMembers(
  members: MemberMetrics[],
  opts: { team?: string; search?: string },
): MemberMetrics[] {
  const needle = (opts.search ?? '').trim().toLowerCase()
  return members.filter(m => {
    if (opts.team && m.team !== opts.team) return false
    if (!needle) return true
    return m.userName.toLowerCase().includes(needle)
        || m.team.toLowerCase().includes(needle)
        || (m.position ?? '').toLowerCase().includes(needle)
  })
}

/** Members with no value for the sort key sink to the bottom rather than sorting as zero. */
function nullsLast(value: number | null, direction: 'asc' | 'desc'): number {
  if (value !== null) return value
  return direction === 'desc' ? -Infinity : Infinity
}

/**
 * Sort the employee table.
 *
 * Two of these are the load-bearing ones:
 *
 *   needs_attention  the default, and it delegates to `sortBySeverity` — the same
 *                    function behind the attention card and the briefing. It no
 *                    longer sorts by `STATUS_SEVERITY`, which was a *second*
 *                    ordering and the reason the card and the table could
 *                    disagree about who was worst.
 *   official_rank    the documented Overall order, with rankable employees first
 *                    and insufficient-data employees listed after them (visible,
 *                    but never occupying a rank).
 *
 * Every other key is a lens on one column. None of them changes a score.
 */
export function sortMembers(
  members: MemberMetrics[],
  key: SortKey,
): MemberMetrics[] {
  const byName = (a: MemberMetrics, b: MemberMetrics) => a.userName.localeCompare(b.userName)
  const copy = [...members]

  switch (key) {
    case 'needs_attention':
      return sortBySeverity(copy)

    case 'official_rank':
      return copy.sort((a, b) => {
        const ra = isRankable(a), rb = isRankable(b)
        if (ra !== rb) return ra ? -1 : 1        // unranked sink below every ranked row
        if (!ra) return byName(a, b)
        return compareOverall(a, b)
      })

    case 'best_score':
      return copy.sort((a, b) => nullsLast(b.score, 'desc') - nullsLast(a.score, 'desc') || byName(a, b))

    case 'lowest_score':
      return copy.sort((a, b) => nullsLast(a.score, 'asc') - nullsLast(b.score, 'asc') || byName(a, b))

    case 'most_improved':
      return copy.sort((a, b) => nullsLast(scoreDelta(b), 'desc') - nullsLast(scoreDelta(a), 'desc') || byName(a, b))

    case 'most_declined':
      return copy.sort((a, b) => nullsLast(scoreDelta(a), 'asc') - nullsLast(scoreDelta(b), 'asc') || byName(a, b))

    case 'highest_overdue':
      return copy.sort((a, b) => b.overdueCount - a.overdueCount || b.oldestOverdueDays - a.oldestOverdueDays || byName(a, b))

    case 'best_on_time':
      return copy.sort((a, b) => nullsLast(onTimeCompletionRate(b), 'desc') - nullsLast(onTimeCompletionRate(a), 'desc') || byName(a, b))

    case 'best_eod':
      return copy.sort((a, b) => nullsLast(eodOnTimeRate(b), 'desc') - nullsLast(eodOnTimeRate(a), 'desc') || byName(a, b))

    case 'least_active':
      return copy.sort((a, b) => nullsLast(activeDayRate(a), 'asc') - nullsLast(activeDayRate(b), 'asc') || byName(a, b))

    case 'most_completed':
      return copy.sort((a, b) => b.tasksCompleted - a.tasksCompleted || byName(a, b))

    case 'most_created':
      return copy.sort((a, b) => tasksCreatedTotal(b) - tasksCreatedTotal(a) || byName(a, b))

    case 'lowest_adoption':
      // Employees with no recordable adoption days sink to the bottom: they have
      // no adoption record, which is not the same as a poor one.
      return copy.sort((a, b) =>
        nullsLast(adoptionRate(a.adoption), 'asc') - nullsLast(adoptionRate(b.adoption), 'asc')
        || byName(a, b))
  }
}

// ─── Rankings ─────────────────────────────────────────────────────────────────

export const RANKING_KEYS = [
  'overall', 'on_time', 'eod', 'most_improved', 'completed', 'created', 'adoption',
] as const
export type RankingKey = typeof RANKING_KEYS[number]

export const RANKING_LABEL: Record<RankingKey, string> = {
  overall:       'Overall',
  on_time:       'On-Time Completion',
  eod:           'EOD Discipline',
  most_improved: 'Most Improved',
  completed:     'Task Completion',
  created:       'Task Creation',
  adoption:      'System Adoption',
}

export type RankingRow = { userId: string; userName: string; value: string; raw: number }

export type Ranking = {
  key:    RankingKey
  top:    RankingRow[]
  bottom: RankingRow[]
  /** Set when the metric could not be ranked at all. */
  note:   string | null
  /** How many employees were held out for insufficient data. Displayed, not hidden. */
  unrankedCount: number
}

const metricFor: Record<RankingKey, (m: MemberMetrics) => { raw: number | null; value: string }> = {
  overall:       m => ({ raw: m.score, value: m.score === null ? '—' : `${m.score}/100` }),
  on_time:       m => { const r = onTimeCompletionRate(m); return { raw: r, value: r === null ? '—' : `${r}%` } },
  eod:           m => { const r = eodOnTimeRate(m);        return { raw: r, value: r === null ? '—' : `${r}%` } },
  // Only a comparable member has a delta at all, so an incomparable one is
  // filtered out here rather than ranked from a stub previous period.
  most_improved: m => { const d = isComparable(m) ? scoreDelta(m) : null; return { raw: d, value: d === null ? '—' : `${d > 0 ? '+' : ''}${d} pts` } },
  completed:     m => ({ raw: m.tasksCompleted,      value: `${m.tasksCompleted}` }),
  created:       m => ({ raw: tasksCreatedTotal(m),  value: `${tasksCreatedTotal(m)}` }),
  adoption:      m => { const r = adoptionRate(m.adoption); return { raw: r, value: r === null ? '—' : `${r}%` } },
}

/**
 * Top five and bottom five for one metric. Both ends always, never just the
 * flattering half — the bottom of the list is the half the owner needs.
 *
 * **Only rankable employees appear.** Someone with two scored days is absent from
 * both ends rather than filling a bottom-five slot they did not earn, and
 * `unrankedCount` tells the reader how many were held out so the omission is
 * visible instead of silent.
 *
 * The `overall` ranking uses the full documented tie-break chain; the other
 * metrics are single-value lenses and break ties on name alone, since a "top five
 * by tasks completed" has no second criterion to appeal to.
 */
export function buildRanking(members: readonly MemberMetrics[], key: RankingKey, size = 5): Ranking {
  const pool = rankablePool(members)
  const unrankedCount = members.length - pool.length

  if (key === 'overall') {
    const ordered = pool.slice().sort(compareOverall).map(m => ({
      userId: m.userId, userName: m.userName,
      value: m.score === null ? '—' : `${m.score}/100`,
      raw:   m.score ?? 0,
    }))
    if (ordered.length === 0) {
      return { key, top: [], bottom: [], note: 'Not enough measured data to rank this metric', unrankedCount }
    }
    if (ordered.length <= size) {
      return { key, top: ordered, bottom: [], note: null, unrankedCount }
    }
    return {
      key,
      top:    ordered.slice(0, size),
      bottom: ordered.slice(-size).reverse(),
      note:   null,
      unrankedCount,
    }
  }

  const rows = pool
    .map(m => ({ m, ...metricFor[key](m) }))
    .filter(r => r.raw !== null)
    .map(r => ({ userId: r.m.userId, userName: r.m.userName, value: r.value, raw: r.raw as number }))

  if (rows.length === 0) {
    return { key, top: [], bottom: [], note: 'Not enough measured data to rank this metric', unrankedCount }
  }

  const desc = [...rows].sort((a, b) => b.raw - a.raw || a.userName.localeCompare(b.userName))
  const top    = desc.slice(0, size)
  const bottom = [...desc].reverse().slice(0, size)

  // With a handful of people the same names would fill both columns, which
  // reads as a bug. Show one list instead.
  if (rows.length <= size) {
    return { key, top: desc, bottom: [], note: null, unrankedCount }
  }
  return { key, top, bottom, note: null, unrankedCount }
}

// ─── Explainability ───────────────────────────────────────────────────────────
/**
 * Why an employee is where they are.
 *
 * Built from the *same functions* the table and the cards render, not a parallel
 * description of them. That is the whole point: if the drawer says "91% on-time"
 * and the table says 84%, the owner cannot use either number in a conversation.
 * Every bullet below calls `onTimeCompletionRate`, `activeDayRate`,
 * `eodOnTimeRate` or reads a field straight off `MemberMetrics`.
 *
 * No generic wording, no adjectives, no AI. Each line is a figure or it is absent.
 */
export type RankExplanation = {
  headline: string
  bullets:  string[]
}

/** A rate for display: "91%" or "—". Never "0%" for a missing value. */
function rateText(value: number | null, suffix = '%'): string {
  return value === null ? '—' : `${value}${suffix}`
}

/**
 * "Why this rank?" for a ranked employee.
 *
 * `rank` and `total` come from `overallRanking`, so the number quoted here is the
 * position actually rendered beside their name.
 */
export function rankExplanation(m: MemberMetrics, rank: number, total: number): RankExplanation {
  const bullets: string[] = []

  bullets.push(`Score: ${m.score ?? '—'}`)
  bullets.push(`Active on ${m.activeDays} of ${m.eligibleDays} eligible days`)

  const onTime = onTimeCompletionRate(m)
  if (onTime !== null) {
    bullets.push(`${onTime}% on-time task completion (${m.tasksCompletedOnTime} of ${m.tasksWithDueDate} dated tasks)`)
  } else {
    bullets.push('On-time completion: — (no tasks with a due date completed this period)')
  }

  const eodPc = eodOnTimeRate(m)
  if (eodPc !== null) {
    bullets.push(`${eodPc}% EOD punctuality (${m.eodOnTime} on time, ${m.eodLate} late, ${m.eodMissed} missed)`)
  } else {
    bullets.push('EOD punctuality: — (no EOD expected in this period)')
  }

  if (m.overdueCount === 0) {
    bullets.push('No overdue tasks')
  } else {
    bullets.push(
      `${m.overdueCount} overdue task${m.overdueCount === 1 ? '' : 's'}`
      + (m.highPriorityOverdue > 0 ? `, ${m.highPriorityOverdue} high-priority` : '')
      + (m.oldestOverdueDays > 0 ? `, oldest by ${m.oldestOverdueDays} days` : ''))
  }

  const cmp = periodComparison(m)
  if (cmp.comparable && cmp.delta !== null) {
    bullets.push(
      `Previous period: ${cmp.prevScore} → ${cmp.score} (${cmp.delta > 0 ? '+' : ''}${cmp.delta} pts), `
      + `${cmp.scoredDays} scored days versus ${cmp.prevScoredDays}`)
  } else if (cmp.note) {
    bullets.push(`Previous period: not compared — ${cmp.note.charAt(0).toLowerCase()}${cmp.note.slice(1)}`)
  }

  return {
    headline: `Ranked #${rank} of ${total} because:`,
    bullets,
  }
}

/** "Why is this employee not ranked?" — the same rule the rankings apply. */
export function unrankedExplanation(m: MemberMetrics): RankExplanation {
  return {
    headline: 'Not ranked because:',
    bullets: [
      insufficientDataReason(m) ?? 'Not enough measured days',
      `${m.eligibleDays} eligible working day${m.eligibleDays === 1 ? '' : 's'} in this period`,
      `${m.scoredDays} of those carried a score`,
      MIN_DATA_RULE_TEXT,
    ],
  }
}

/**
 * "Requires attention because:" — the findings, in concern order, each with its
 * own figure. Null when the employee has no findings, so the drawer shows nothing
 * rather than a reassuring sentence nobody asked for.
 */
export function attentionExplanation(m: MemberMetrics): RankExplanation | null {
  const findings = attentionFindings(m)
  if (findings.length === 0) return null
  return {
    headline: 'Requires attention because:',
    bullets: findings.map(f => f.evidence),
  }
}

/**
 * The improvement/decline explanation, always carrying both day counts so the
 * reader can see the two periods were equivalent.
 */
export function movementExplanation(m: MemberMetrics): RankExplanation {
  const cmp = periodComparison(m)
  if (!cmp.comparable) {
    return {
      headline: 'Period comparison unavailable:',
      bullets: [
        cmp.note ?? 'Not enough measured days in both periods',
        `This period: ${cmp.scoredDays} scored of ${cmp.eligibleDays} eligible days`,
        `Previous period: ${cmp.prevScoredDays} scored of ${cmp.prevEligibleDays} eligible days`,
      ],
    }
  }
  const direction = cmp.delta! > 0 ? 'Improved' : cmp.delta! < 0 ? 'Declined' : 'Unchanged'
  return {
    headline: `${direction} versus the previous equivalent period:`,
    bullets: [
      `Current score: ${cmp.score}`,
      `Previous score: ${cmp.prevScore}`,
      `Change: ${cmp.delta! > 0 ? '+' : ''}${cmp.delta} points`,
      `Current eligible days: ${cmp.eligibleDays} (${cmp.scoredDays} scored)`,
      `Previous eligible days: ${cmp.prevEligibleDays} (${cmp.prevScoredDays} scored)`,
    ],
  }
}

/** System Adoption, explained. Never blended into the rank explanation. */
export function adoptionExplanation(m: MemberMetrics): RankExplanation {
  const a = m.adoption
  if (!hasAdoptionData(a)) {
    return {
      headline: 'System Adoption: no data yet',
      bullets: [
        a.expectedDays === 0
          ? 'No eligible working days in this period'
          : `All ${a.unrecordedDays} eligible day${a.unrecordedDays === 1 ? '' : 's'} in this period pre-date first-open recording`,
        'Adoption is reported separately and does not affect the performance score',
      ],
    }
  }
  const bullets = [
    `Opened Task Management on ${a.openedDays} of ${a.expectedDays - a.unrecordedDays} recordable eligible days`,
    `Within the start window on ${a.withinWindowDays}, after it on ${a.lateDays}`,
    `Average first open: ${rateText(a.avgFirstOpenMinutes === null ? null : a.avgFirstOpenMinutes, '')} `
      + (avgFirstOpenLabel(a) ? `(${avgFirstOpenLabel(a)} IST)` : ''),
    `Expected start: ${Math.floor(a.window.startMinutes / 60)}:${String(a.window.startMinutes % 60).padStart(2, '0')}`
      + ` +${a.window.graceMinutes} min grace`
      + (a.window.provisional ? ' — provisional, no shift configured' : ` (${a.window.source})`),
  ]
  if (a.streak > 0) bullets.push(`Current adoption streak: ${a.streak} consecutive eligible days`)
  if (a.unrecordedDays > 0) bullets.push(`${a.unrecordedDays} eligible day${a.unrecordedDays === 1 ? '' : 's'} pre-date recording and are excluded`)
  return { headline: 'System Adoption:', bullets }
}

/**
 * The "How ranking works" content, in plain language.
 *
 * Deliberately short and formula-free. The owner needs to know who is in, what
 * decides the order, and what does *not* — not the pillar arithmetic. The full
 * tie-break chain is available as OVERALL_TIE_BREAKERS for the expandable detail.
 */
export const HOW_RANKING_WORKS: readonly { heading: string; body: string }[] = [
  {
    heading: 'Who is included',
    body: 'Active employees with Performance tracking enabled. Administrative and '
        + 'test accounts are excluded and cannot affect any figure on this page. '
        + 'Employees who joined or left partway through the period are measured only '
        + 'over the days they were employed.',
  },
  {
    heading: 'Minimum data to be ranked',
    body: MIN_DATA_RULE_TEXT,
  },
  {
    heading: 'What decides the order',
    body: 'The period score first — the average of each expected working day. Days '
        + 'nobody was expected to work (Sundays, recorded company holidays, dates '
        + 'before joining or after leaving) are not counted at all. A working day '
        + 'with no activity counts as zero, on purpose.',
  },
  {
    heading: 'Tie-breakers, in order',
    body: OVERALL_TIE_BREAKERS.map((t, i) => `${i + 1}. ${t}`).join('  '),
  },
  {
    heading: 'Creating tasks does not improve rank',
    body: 'Task creation is reported and ranked as a separate signal, and is never '
        + 'a tie-breaker. Typing more tasks cannot move anyone up this list.',
  },
  {
    heading: 'Why some employees are not ranked',
    body: 'Below the minimum they are shown as "Insufficient Data" with their real '
        + 'figures, but are not eligible to be named best, weakest, most improved or '
        + 'most declined, and do not appear in a top or bottom five. Ranking someone '
        + 'on two days would be a guess presented as a measurement.',
  },
  {
    heading: 'What this ranking is not',
    body: 'Approved leave is not yet recorded anywhere in the system, so a day taken '
        + 'as leave still counts as an expected working day. Treat this as a '
        + 'management view, not a payroll-ready measurement.',
  },
]

// ─── Recommended action ───────────────────────────────────────────────────────

/**
 * One concrete instruction for the owner.
 *
 * Reads the **worst finding from the shared severity model** rather than
 * re-deriving its own priority order. The previous version had its own if-chain,
 * which meant the drawer could recommend acting on stale blockers while the
 * briefing above it flagged the same person for missed EODs. Now the action is
 * always the action attached to the finding the rest of the page is showing.
 */
export function recommendedAction(m: MemberMetrics, status: OperationalStatus): string {
  const primary = memberSeverity(m).primary
  if (primary) return `${primary.action} — ${primary.evidence}.`

  if (m.activeTasks >= 8 && m.tasksCompleted <= 2) {
    return `Check workload allocation — ${m.activeTasks} open tasks against ${m.tasksCompleted} completed.`
  }
  if (status === 'strong' || status === 'performing_well') {
    return 'No action needed. Worth acknowledging.'
  }
  if (status === 'insufficient_data') {
    return 'Not enough measured days yet to recommend an action.'
  }
  return 'No specific issue flagged. Keep monitoring.'
}

/** Per-employee strengths for the drawer. Same evidence rule as the briefing. */
export function memberStrengths(m: MemberMetrics): string[] {
  const out: string[] = []
  const onTime = onTimeCompletionRate(m)
  const eodPc  = eodOnTimeRate(m)
  const active = activeDayRate(m)
  const delta  = scoreDelta(m)

  if (onTime !== null && onTime >= 80 && m.tasksWithDueDate >= 2) out.push(`${onTime}% on-time completion across ${m.tasksWithDueDate} dated tasks`)
  if (eodPc  !== null && eodPc  >= 90) out.push(`${eodPc}% of EODs submitted on time`)
  if (active === 100 && m.eligibleDays >= 3) out.push(`Active on all ${m.eligibleDays} eligible working days`)
  if (delta !== null && isComparable(m) && delta > 0) out.push(`Score up ${delta} points versus the previous period`)
  if (m.tasksCompleted >= 5) out.push(`${m.tasksCompleted} tasks completed this period`)
  if (m.overdueCount === 0 && m.activeTasks > 0) out.push('Nothing currently overdue')
  if (m.staleBlockedCount === 0 && m.blockedCount > 0) out.push('All blockers have recent updates')
  if (m.eodStreak >= 3) out.push(`${m.eodStreak}-day EOD streak`)
  if (hasAdoptionData(m.adoption) && adoptionRate(m.adoption) === 100) {
    out.push(`Opened Task Management on every recordable eligible day`)
  }
  return out
}

/**
 * Per-employee concerns for the drawer.
 *
 * The shared findings come first, in concern order and word-for-word as the
 * briefing states them, so the drawer and the briefing quote identical evidence.
 * A few lower-signal observations follow that are worth seeing in a one-person
 * view but do not warrant a place in the team briefing.
 */
export function memberConcerns(m: MemberMetrics): string[] {
  const out = attentionFindings(m).map(f => f.evidence)

  // Not findings in their own right, but useful context once you are already
  // looking at one person.
  if (m.overdueCount > 0 && m.highPriorityOverdue === 0 && m.overdueCount < THRESHOLDS.overdueConcern) {
    out.push(`${m.overdueCount} task${m.overdueCount === 1 ? '' : 's'} past due`
      + (m.oldestOverdueDays > 0 ? `, oldest by ${m.oldestOverdueDays} days` : ''))
  }
  // Any missed EOD is worth seeing in a one-person view, including the small
  // healthy-rate counts that deliberately do not qualify as a team-level finding.
  const alreadyFlagged = attentionFindings(m).some(f => f.category === 'repeated_missed_eod')
  if (m.eodMissed > 0 && !alreadyFlagged) {
    out.push(`${m.eodMissed} EOD${m.eodMissed === 1 ? '' : 's'} missed`)
  }
  if (m.waitingCount >= 3) out.push(`${m.waitingCount} tasks waiting on someone else`)
  if (m.eodOnlyDays === 2) out.push('2 days with an EOD but no task activity')
  if (hasAdoptionData(m.adoption) && m.adoption.lateDays > 0) {
    out.push(`Opened Task Management after the start window on ${m.adoption.lateDays} day${m.adoption.lateDays === 1 ? '' : 's'}`)
  }
  return out
}

// ─── Response contract ────────────────────────────────────────────────────────
// Shared by the endpoint and the page so the two cannot drift apart. The page
// renders these numbers; it never recomputes a score from raw rows.

export type EodDetail = {
  date:        string
  status:      EodStatus
  submittedAt: string | null
  summary:     string | null
  selfScore:   number | null
}

export type MemberEvidence = {
  stuckTasks: StuckTask[]
  trend:      TrendDay[]
  eodRows:    EodDetail[]
  /**
   * The eligible dates on which meaningful activity happened, and the ones on
   * which none did. Sent rather than derived on the client: `TrendDay.inputs` is a
   * narrowed Pick that omits several action types the server counts, so a
   * client-side derivation would print a date list that contradicts the
   * "active on N of M" figure beside it.
   */
  activeDates: string[]
  idleDates:   string[]
}

export type Superlative = {
  userId:   string
  userName: string
  score:    number | null
  detail:   string
  /** The same explanation the drawer shows, so a card can be justified in place. */
  explanation: RankExplanation | null
}

/**
 * Performance Coverage — the answer to "who is in this?", stated before any
 * ranking is read.
 *
 * `excluded` is admin-only and omitted entirely for a manager; `excludedCount` is
 * always present, because knowing that some accounts are held out is not
 * sensitive — knowing management's reason for each is.
 */
export type CoverageSummary = {
  /** Active employees measured this period. */
  trackedCount:    number
  /** Held out by performance_tracking_enabled = false. */
  excludedCount:   number
  /** Of the tracked, how many cleared the minimum-data rule. */
  sufficientCount: number
  insufficientCount: number
  /** Named list of unranked employees with the reason, so the gap is visible. */
  insufficient:    { userId: string; userName: string; reason: string }[]
  /** Eligible working days in the period — the maximum any employee could have. */
  maxEligibleDays: number
  holidayCoverage: HolidayCoverage
  /** 'full' only when the holiday calendar covers the period. */
  confidence:      'full' | 'limited'
  /** Present for admins only. */
  excluded?:       ExcludedUser[]
  /** The approved-leave / attendance limitation, verbatim, for display. */
  attendanceNote:  string
}

/** Team-wide System Adoption. Always reported apart from the score. */
export type AdoptionSummary = {
  /** Employees with at least one recordable eligible day. */
  measuredEmployees:  number
  /** Of those, employees with at least one recorded first open. */
  openedEmployees:    number
  /** Total recorded opens across the period. */
  totalOpens:         number
  totalWithinWindow:  number
  totalLate:          number
  /** Recordable eligible days with no open. */
  totalMissing:       number
  /** Mean first-open time across all opens, in minutes past IST midnight. */
  avgFirstOpenMinutes: number | null
  /** First business date for which a missing row means anything. Null = table empty. */
  recordingFrom:      string | null
  /** True when no reliable adoption data exists yet, so the section must say so. */
  noDataYet:          boolean
  /** True when any measured employee fell back to the provisional start window. */
  anyProvisionalWindow: boolean
}

export type TeamSummary = {
  employeeCount:        number
  teamAverage:          number | null
  prevTeamAverage:      number | null
  teamAverageDelta:     number | null
  best:                 Superlative | null
  weakest:              Superlative | null
  improved:             Superlative | null
  declined:             Superlative | null
  eodOnTimeRate:        number | null
  eodLate:              number
  eodMissed:            number
  onTimeCompletionRate: number | null
  lateCompletions:      number
  totalCompleted:       number
  totalOverdue:         number
}

export type ActivitySummary = {
  activeInPeriod: number
  fullyActive:   number
  lowActivity:   number
  noCompletions: number
  noCreations:   number
  eodOnly:       number
}

export type TeamDataset = {
  period:          ResolvedPeriod
  generatedAt:     string
  teamSummary:     TeamSummary
  activitySummary: ActivitySummary
  coverage:        CoverageSummary
  adoptionSummary: AdoptionSummary
  metrics:         MemberMetrics[]
  classifications: Record<string, Classification>
  /** 1-based official Overall position per user id. Absent for unranked employees. */
  ranks:           Record<string, number>
  /** The "why this rank?" text per user id, built server-side from the same values. */
  explanations:    Record<string, RankExplanation>
  attention:       AttentionItem[]
  positives:       PositiveItem[]
  rankings:        Ranking[]
  evidence:        Record<string, MemberEvidence>
}

/**
 * Build the rank map and the explanations together, from one ordering.
 *
 * Doing both in one pass is what guarantees test 31: the rank in the table, the
 * rank quoted inside the explanation, the rank behind the summary card and the
 * rank in the drawer are all this single array's index.
 */
export function buildRanksAndExplanations(members: readonly MemberMetrics[]): {
  ranks: Record<string, number>
  explanations: Record<string, RankExplanation>
} {
  const ordered = overallRanking(members)
  const ranks: Record<string, number> = {}
  const explanations: Record<string, RankExplanation> = {}

  ordered.forEach((m, i) => {
    ranks[m.userId] = i + 1
    explanations[m.userId] = rankExplanation(m, i + 1, ordered.length)
  })

  // Unranked employees still get an explanation — of why they are unranked.
  for (const m of members) {
    if (explanations[m.userId] === undefined) {
      explanations[m.userId] = unrankedExplanation(m)
    }
  }

  return { ranks, explanations }
}
