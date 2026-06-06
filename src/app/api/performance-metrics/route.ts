/**
 * Performance Metrics API
 *
 * Score model — 4 pillars, max 100 pts:
 *
 *  OUTPUT     (0–50)  Weighted completions: High×22 + Med×15 + Low×8, cap 50
 *  MOMENTUM   (0–20)  Status updates ×4 (cap 16) + blocker-cleared ×4 (cap 4)
 *  DISCIPLINE (0–20)  EOD log +12, was active today +5, timely ack ×3 (cap 3)
 *  RISK       (0→−40) Overdue ×−5 (cap −25) + stale-blocked ×−8 (cap −16)
 *
 *  TOTAL = clamp(Output + Momentum + Discipline + Risk, 0, 100)
 *
 * Ratings:
 *   75+  → excellent
 *   58+  → good
 *   38+  → average
 *   20+  → needs_improvement
 *   <20  → critical
 *
 * Trend is always returned (7 days for daily, full window for weekly/monthly).
 * TrendAnalysis classifies trajectory and gives week-over-week delta.
 */

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import type {
  ScoreBreakdown, DayInputs, TrendDay,
  TrendAnalysis, TrendClassification, PerformanceRating,
} from '@/lib/types'

// ─── Supabase ─────────────────────────────────────────────────────────────────

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

async function getCallerProfile(token: string) {
  const client = sb()
  const { data: { user }, error } = await client.auth.getUser(token)
  if (error || !user) return null
  const { data } = await client
    .from('users')
    .select('id, role, full_name, team, position')
    .eq('id', user.id)
    .single()
  return data as { id: string; role: string; full_name: string; team: string; position: string | null } | null
}

// ─── Score computation ────────────────────────────────────────────────────────

function computeBreakdown(inputs: DayInputs): ScoreBreakdown {
  // Output: priority-weighted completions
  const output = Math.min(
    50,
    inputs.completedHigh   * 22 +
    inputs.completedMedium * 15 +
    inputs.completedLow    * 8
  )

  // Momentum: progress signals
  const momentum = Math.min(20,
    Math.min(16, inputs.statusUpdates * 4) +
    Math.min(4,  inputs.blockerResolutions * 4)
  )

  // Discipline: behavioural habits
  const discipline = Math.min(20,
    (inputs.hasEodLog    ? 12 : 0) +
    (inputs.wasActiveToday ? 5 : 0) +
    Math.min(3, inputs.timelyAcks * 3)
  )

  // Risk: active penalties (stored negative)
  const risk = -(
    Math.min(25, inputs.overdueCount      * 5) +
    Math.min(16, inputs.staleBlockedCount * 8)
  )

  const total = Math.max(0, Math.min(100, output + momentum + discipline + risk))

  return { output, momentum, discipline, risk, total }
}

function scoreRating(score: number): PerformanceRating {
  if (score >= 75) return 'excellent'
  if (score >= 58) return 'good'
  if (score >= 38) return 'average'
  if (score >= 20) return 'needs_improvement'
  return 'critical'
}

// ─── Trend analysis ───────────────────────────────────────────────────────────

function analyzeTrend(trendDays: TrendDay[]): TrendAnalysis {
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

  const n    = scores.length
  const avg  = scores.reduce((s, v) => s + v, 0) / n
  const variance = scores.reduce((s, v) => s + (v - avg) ** 2, 0) / n
  const stddev   = Math.sqrt(variance)

  // Direction via half-period comparison
  const firstHalf  = scores.slice(0, Math.floor(n / 2))
  const secondHalf = scores.slice(Math.floor(n / 2))
  const firstAvg   = firstHalf.reduce((s, v) => s + v, 0)  / firstHalf.length
  const secondAvg  = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length
  const halfDelta  = secondAvg - firstAvg

  // Consecutive-day streak in the current direction
  const lastDir = scores[n - 1] >= scores[n - 2] ? 'up' : 'down'
  let streak = 1
  for (let i = n - 2; i > 0; i--) {
    const dir = scores[i] >= scores[i - 1] ? 'up' : 'down'
    if (dir === lastDir) streak++
    else break
  }

  // Week-over-week: current 7 days vs prev 7 days (if enough data)
  let weekOverWeekDelta = Math.round(halfDelta)
  if (scores.length >= 14) {
    const prevWeekAvg = scores.slice(-14, -7).reduce((s, v) => s + v, 0) / 7
    const thisWeekAvg = scores.slice(-7).reduce((s, v) => s + v, 0) / 7
    weekOverWeekDelta = Math.round(thisWeekAvg - prevWeekAvg)
  }

  // Classify
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

  return {
    classification,
    direction,
    streak,
    weekOverWeekDelta,
    description: descriptions[classification],
  }
}

// ─── Single-day data fetching ─────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchDayInputs(client: any, userId: string, date: string): Promise<{ inputs: DayInputs; eodLog: null | Record<string, unknown> }> {
  const dayStart = `${date}T00:00:00.000Z`
  const dayEnd   = `${date}T23:59:59.999Z`

  // 2-day threshold for stale-blocked detection
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()

  const [
    { data: completedTasks },
    { data: activityToday },
    { count: overdueCount },
    { count: staleBlockedCount },
    { count: blockedCount },
    { count: activeTasks },
    { data: eodLog },
    { data: acksToday },
  ] = await Promise.all([
    // Completed tasks today — need priority for weighting
    client.from('tasks')
      .select('id, priority')
      .eq('assigned_to', userId)
      .eq('status', 'completed')
      .gte('completed_at', dayStart)
      .lte('completed_at', dayEnd),

    // All activity log entries today (status changes, acks)
    client.from('task_activity_log')
      .select('action, from_status, task_id, created_at')
      .eq('actor_id', userId)
      .gte('created_at', dayStart)
      .lte('created_at', dayEnd),

    // Overdue: not completed and past due date
    client.from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('assigned_to', userId)
      .neq('status', 'completed')
      .eq('is_deleted', false)
      .lt('due_date', new Date().toISOString().slice(0, 10)),

    // Stale-blocked: blocked with no update in >2 days
    client.from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('assigned_to', userId)
      .eq('status', 'blocked')
      .eq('is_deleted', false)
      .lt('last_update_at', twoDaysAgo),

    // All currently blocked (includes recent blocks)
    client.from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('assigned_to', userId)
      .eq('status', 'blocked')
      .eq('is_deleted', false),

    // Active portfolio size
    client.from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('assigned_to', userId)
      .neq('status', 'completed')
      .eq('is_deleted', false),

    // EOD log for this date
    client.from('daily_work_logs')
      .select('id, summary, highlights, blockers, self_score, created_at, updated_at, log_date, user_id')
      .eq('user_id', userId)
      .eq('log_date', date)
      .maybeSingle(),

    // Acknowledgements today — for timely-ack calculation
    client.from('task_activity_log')
      .select('task_id, created_at')
      .eq('actor_id', userId)
      .eq('action', 'acknowledged')
      .gte('created_at', dayStart)
      .lte('created_at', dayEnd),
  ])

  // Priority breakdown for completions
  const tasks  = (completedTasks ?? []) as { priority: string }[]
  const completedHigh   = tasks.filter(t => t.priority === 'high').length
  const completedMedium = tasks.filter(t => t.priority === 'medium').length
  const completedLow    = tasks.filter(t => t.priority === 'low').length

  // Momentum: status_changed today (excluding completions = handled in output)
  const activity = (activityToday ?? []) as { action: string; from_status: string | null; task_id: string; created_at: string }[]
  const statusUpdates = activity.filter(a => a.action === 'status_changed').length
  const blockerResolutions = activity.filter(
    a => a.action === 'status_changed' && a.from_status === 'blocked'
  ).length

  // Was active: any activity today at all
  const wasActiveToday = activity.length > 0 || eodLog !== null

  // Timely acks: acknowledged tasks where ack happened within 4h of task creation
  // We fetch the task created_at for each acked task_id and compare
  let timelyAcks = 0
  if (acksToday && acksToday.length > 0) {
    const taskIds = (acksToday as { task_id: string; created_at: string }[]).map(a => a.task_id)
    const { data: taskCreationTimes } = await client
      .from('tasks')
      .select('id, created_at')
      .in('id', taskIds)

    if (taskCreationTimes) {
      const creationMap = new Map(
        (taskCreationTimes as { id: string; created_at: string }[]).map(t => [t.id, t.created_at])
      )
      for (const ack of acksToday as { task_id: string; created_at: string }[]) {
        const taskCreated = creationMap.get(ack.task_id)
        if (!taskCreated) continue
        const delta = new Date(ack.created_at).getTime() - new Date(taskCreated).getTime()
        if (delta <= 4 * 60 * 60 * 1000) timelyAcks++
      }
    }
  }

  const inputs: DayInputs = {
    completedHigh,
    completedMedium,
    completedLow,
    statusUpdates,
    blockerResolutions,
    hasEodLog:          eodLog !== null,
    wasActiveToday,
    timelyAcks,
    overdueCount:       overdueCount ?? 0,
    staleBlockedCount:  staleBlockedCount ?? 0,
    activeTasks:        activeTasks ?? 0,
    blockedCount:       blockedCount ?? 0,
  }

  return { inputs, eodLog: eodLog ?? null }
}

function trendDayFromDayInputs(date: string, inputs: DayInputs): TrendDay {
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

// ─── Route ────────────────────────────────────────────────────────────────────
// GET /api/performance-metrics?period=daily|weekly|monthly&userId=optional&date=YYYY-MM-DD

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const caller = await getCallerProfile(token)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const period = (searchParams.get('period') ?? 'daily') as 'daily' | 'weekly' | 'monthly'
  const userId = searchParams.get('userId') ?? caller.id
  const today  = new Date().toISOString().slice(0, 10)
  const date   = searchParams.get('date') ?? today

  if (userId !== caller.id && !['admin', 'manager'].includes(caller.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const client = sb()

  // Resolve target user name
  let userName = caller.full_name
  if (userId !== caller.id) {
    const { data } = await client.from('users').select('full_name').eq('id', userId).single()
    userName = data?.full_name ?? userId
  }

  // ── How many days back to fetch ─────────────────────────────────────────────
  // Daily view: always include 7 days of trend context.
  // Weekly view: 14 days (current + previous week for w-o-w delta).
  // Monthly view: 30 days.
  const windowDays = period === 'monthly' ? 30 : period === 'weekly' ? 14 : 7

  // Build date list: oldest → newest
  const dateList: string[] = []
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    dateList.push(d.toISOString().slice(0, 10))
  }

  // Fetch all days in parallel
  const dayResults = await Promise.all(
    dateList.map(async (d) => {
      const { inputs } = await fetchDayInputs(client, userId, d)
      return trendDayFromDayInputs(d, inputs)
    })
  )

  const trendAnalysis = analyzeTrend(dayResults)

  // ── Daily response ───────────────────────────────────────────────────────────
  if (period === 'daily') {
    const { inputs, eodLog } = await fetchDayInputs(client, userId, date)
    const breakdown = computeBreakdown(inputs)

    return NextResponse.json({
      period,
      date,
      userId,
      userName,
      score:    breakdown.total,
      rating:   scoreRating(breakdown.total),
      breakdown,
      inputs,
      trend:    dayResults,
      trendAnalysis,
      eodLog,
    })
  }

  // ── Weekly / Monthly aggregate response ─────────────────────────────────────
  const { inputs: todayInputs, eodLog } = await fetchDayInputs(client, userId, today)
  const todayBreakdown = computeBreakdown(todayInputs)

  // Use the full window for the period summary
  const aggregate = {
    totalCompletedHigh:   dayResults.reduce((s, d) => s + d.inputs.completedHigh,   0),
    totalCompletedMedium: dayResults.reduce((s, d) => s + d.inputs.completedMedium, 0),
    totalCompletedLow:    dayResults.reduce((s, d) => s + d.inputs.completedLow,    0),
    totalCompleted:       dayResults.reduce((s, d) => s + d.inputs.completedHigh + d.inputs.completedMedium + d.inputs.completedLow, 0),
    totalStatusUpdates:   dayResults.reduce((s, d) => s + d.inputs.statusUpdates,   0),
    eodLogRate:           Math.round(dayResults.filter(d => d.inputs.hasEodLog).length / dayResults.length * 100),
    avgScore:             Math.round(dayResults.reduce((s, d) => s + d.score, 0) / dayResults.length),
    bestDay:  dayResults.reduce((best, d) => d.score > best.score ? d : best, dayResults[0]),
    worstDay: dayResults.reduce((worst, d) => d.score < worst.score ? d : worst, dayResults[0]),
  }

  return NextResponse.json({
    period,
    date:     today,
    userId,
    userName,
    score:    aggregate.avgScore,
    rating:   scoreRating(aggregate.avgScore),
    breakdown: todayBreakdown,
    inputs:    todayInputs,
    trend:     dayResults,
    trendAnalysis,
    eodLog,
    aggregate,
  })
}
