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

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import type { DayInputs } from '@/lib/types'

// No generated Database type in this project — matches the untyped-client
// pattern used elsewhere (e.g. lib/payroll/store.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = SupabaseClient<any, any, any>
import {
  computeBreakdown, scoreRating, analyzeTrend, trendDayFromInputs,
} from '@/lib/performance'

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

// ─── Current-state snapshot (not date-specific) ───────────────────────────────
// These four metrics reflect the user's task portfolio right now. They are
// identical regardless of which historical date is being scored, so they are
// fetched once per request and injected into every fetchDayInputs call.
type CurrentTaskSnapshot = {
  overdueCount:      number
  staleBlockedCount: number
  blockedCount:      number
  activeTasks:       number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchCurrentTaskSnapshot(client: any, userId: string): Promise<CurrentTaskSnapshot> {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()

  const [
    { count: overdueCount },
    { count: staleBlockedCount },
    { count: blockedCount },
    { count: activeTasks },
  ] = await Promise.all([
    // Overdue: not completed/cancelled and past due date
    client.from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('assigned_to', userId)
      .neq('status', 'completed')
      .neq('status', 'cancelled')
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

    // Active portfolio size (excludes completed and cancelled)
    client.from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('assigned_to', userId)
      .neq('status', 'completed')
      .neq('status', 'cancelled')
      .eq('is_deleted', false),
  ])

  return {
    overdueCount:      overdueCount      ?? 0,
    staleBlockedCount: staleBlockedCount ?? 0,
    blockedCount:      blockedCount      ?? 0,
    activeTasks:       activeTasks       ?? 0,
  }
}

// ─── Single-day data fetching ─────────────────────────────────────────────────
async function fetchDayInputs(client: Svc, userId: string, date: string, snapshot: CurrentTaskSnapshot): Promise<{ inputs: DayInputs; eodLog: null | Record<string, unknown> }> {
  const dayStart = `${date}T00:00:00.000Z`
  const dayEnd   = `${date}T23:59:59.999Z`

  const [
    { data: completedTasks },
    { data: activityToday },
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
    overdueCount:       snapshot.overdueCount,
    staleBlockedCount:  snapshot.staleBlockedCount,
    activeTasks:        snapshot.activeTasks,
    blockedCount:       snapshot.blockedCount,
  }

  return { inputs, eodLog: eodLog ?? null }
}

// ─── Batched range fetch for 7-day trend (period=daily) ──────────────────────
// Replaces 7 × fetchDayInputs (28 queries) with 4 range queries + 1 optional
// task-creation lookup, then groups results by date in memory.
async function fetchRangeInputs(
  client: Svc,
  userId: string,
  dateList: string[],
  snapshot: CurrentTaskSnapshot,
): Promise<{ inputs: DayInputs; eodLog: Record<string, unknown> | null }[]> {
  const rangeStart = `${dateList[0]}T00:00:00.000Z`
  const rangeEnd   = `${dateList[dateList.length - 1]}T23:59:59.999Z`

  const [
    { data: completedTasks },
    { data: activityLog },
    { data: eodLogs },
    { data: acksAll },
  ] = await Promise.all([
    client.from('tasks')
      .select('id, priority, completed_at')
      .eq('assigned_to', userId)
      .eq('status', 'completed')
      .gte('completed_at', rangeStart)
      .lte('completed_at', rangeEnd),

    client.from('task_activity_log')
      .select('action, from_status, task_id, created_at')
      .eq('actor_id', userId)
      .gte('created_at', rangeStart)
      .lte('created_at', rangeEnd),

    client.from('daily_work_logs')
      .select('id, summary, highlights, blockers, self_score, created_at, updated_at, log_date, user_id')
      .eq('user_id', userId)
      .gte('log_date', dateList[0])
      .lte('log_date', dateList[dateList.length - 1]),

    client.from('task_activity_log')
      .select('task_id, created_at')
      .eq('actor_id', userId)
      .eq('action', 'acknowledged')
      .gte('created_at', rangeStart)
      .lte('created_at', rangeEnd),
  ])

  // Batch-fetch task creation times for timely-ack calculation (one query instead of up to 7)
  const allAckedIds = [...new Set(
    (acksAll ?? [] as { task_id: string }[]).map((a: { task_id: string }) => a.task_id)
  )]
  let taskCreationMap = new Map<string, string>()
  if (allAckedIds.length > 0) {
    const { data: taskTimes } = await client
      .from('tasks')
      .select('id, created_at')
      .in('id', allAckedIds)
    if (taskTimes) {
      taskCreationMap = new Map(
        (taskTimes as { id: string; created_at: string }[]).map(t => [t.id, t.created_at])
      )
    }
  }

  return dateList.map(date => {
    const dayStart = `${date}T00:00:00.000Z`
    const dayEnd   = `${date}T23:59:59.999Z`
    const inDay    = (ts: string) => ts >= dayStart && ts <= dayEnd

    const tasks = (completedTasks ?? [] as { priority: string; completed_at: string }[])
      .filter((t: { completed_at: string }) => inDay(t.completed_at)) as { priority: string }[]
    const completedHigh   = tasks.filter(t => t.priority === 'high').length
    const completedMedium = tasks.filter(t => t.priority === 'medium').length
    const completedLow    = tasks.filter(t => t.priority === 'low').length

    const activity = (activityLog ?? [] as { action: string; from_status: string | null; task_id: string; created_at: string }[])
      .filter((a: { created_at: string }) => inDay(a.created_at)) as { action: string; from_status: string | null; task_id: string; created_at: string }[]
    const statusUpdates      = activity.filter(a => a.action === 'status_changed').length
    const blockerResolutions = activity.filter(a => a.action === 'status_changed' && a.from_status === 'blocked').length

    const eodLog = ((eodLogs ?? []) as { log_date: string }[]).find(l => l.log_date === date) ?? null

    const wasActiveToday = activity.length > 0 || eodLog !== null

    const acksDay = (acksAll ?? [] as { task_id: string; created_at: string }[])
      .filter((a: { created_at: string }) => inDay(a.created_at)) as { task_id: string; created_at: string }[]
    let timelyAcks = 0
    for (const ack of acksDay) {
      const taskCreated = taskCreationMap.get(ack.task_id)
      if (!taskCreated) continue
      if (new Date(ack.created_at).getTime() - new Date(taskCreated).getTime() <= 4 * 60 * 60 * 1000) {
        timelyAcks++
      }
    }

    const inputs: DayInputs = {
      completedHigh,
      completedMedium,
      completedLow,
      statusUpdates,
      blockerResolutions,
      hasEodLog:         eodLog !== null,
      wasActiveToday,
      timelyAcks,
      overdueCount:      snapshot.overdueCount,
      staleBlockedCount: snapshot.staleBlockedCount,
      activeTasks:       snapshot.activeTasks,
      blockedCount:      snapshot.blockedCount,
    }

    return { inputs, eodLog: eodLog as Record<string, unknown> | null }
  })
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
  const period = (searchParams.get('period') ?? 'daily') as 'daily' | 'weekly' | 'monthly' | 'today'
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

  // ── Today-only fast path (no trend window) ──────────────────────────────────
  if (period === 'today') {
    const snapshot = await fetchCurrentTaskSnapshot(client, userId)
    const { inputs, eodLog } = await fetchDayInputs(client, userId, today, snapshot)
    const breakdown = computeBreakdown(inputs)
    return NextResponse.json({
      period:   'daily',
      date:     today,
      userId,
      userName,
      score:    breakdown.total,
      rating:   scoreRating(breakdown.total),
      breakdown,
      inputs,
      trend:    [],
      trendAnalysis: {
        classification:    'insufficient_data',
        direction:         'flat',
        streak:            0,
        weekOverWeekDelta: 0,
        description:       'Loading trend…',
      },
      eodLog,
    })
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

  // Fetch current-state snapshot once — shared across all historical day calculations
  const snapshot = await fetchCurrentTaskSnapshot(client, userId)

  let capturedToday: { inputs: DayInputs; eodLog: Record<string, unknown> | null } | null = null
  let dayResults: ReturnType<typeof trendDayFromInputs>[]

  if (period === 'daily') {
    // Optimised path: 4 range queries + 1 optional task-creation lookup (≤5 total)
    // instead of 7 × 4 = 28 per-day queries.
    const rangeResults = await fetchRangeInputs(client, userId, dateList, snapshot)
    dayResults = rangeResults.map((r, i) => trendDayFromInputs(dateList[i], r.inputs))
    const todayIdx = dateList.indexOf(today)
    if (todayIdx !== -1) capturedToday = rangeResults[todayIdx]
  } else {
    // Weekly / monthly: keep existing per-day parallel fetch (14 or 30 days)
    dayResults = await Promise.all(
      dateList.map(async (d) => {
        const result = await fetchDayInputs(client, userId, d, snapshot)
        if (d === today) capturedToday = result
        return trendDayFromInputs(d, result.inputs)
      })
    )
  }

  // Fall back to a fresh fetch only when a historical date was explicitly requested
  const todayData = capturedToday ?? await fetchDayInputs(client, userId, today, snapshot)

  const trendAnalysis = analyzeTrend(dayResults)

  // ── Daily response ───────────────────────────────────────────────────────────
  if (period === 'daily') {
    // If a specific historical date was requested, fetch that day; otherwise reuse captured data
    const { inputs, eodLog } = (date === today)
      ? todayData
      : await fetchDayInputs(client, userId, date, snapshot)
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
  const { inputs: todayInputs, eodLog } = todayData
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
