/**
 * Batch team performance endpoint.
 *
 * GET /api/performance-metrics/team?period=daily|weekly|monthly
 *
 * Query plan (2 sequential rounds, 5 total queries):
 *
 *   Round 1:  users  — fetch all active members first so we can scope
 *                      every subsequent query to their IDs only.
 *
 *   Round 2 (parallel):
 *     2. Non-completed tasks for those users  (overdue / blocked / active state)
 *     3. Completed tasks for those users      (priority lookup; NO completed_at select
 *                                              — completion dates come from activity log)
 *     4. Activity log for those users         (includes to_status for completion events)
 *     5. EOD work-logs for those users
 *
 * Why we avoid selecting completed_at:
 *   PostgREST returns a 400 when you SELECT a column absent from its schema
 *   cache, even if the column exists in the DB.  Filtering on the column
 *   (gte/lte) is silently ignored in that case, so the individual route that
 *   only FILTERS on completed_at works fine.  We derive completion timing
 *   from the activity log's to_status = 'completed' + created_at instead.
 */

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import type { DayInputs, MemberPerfEntry, PerformanceRating, StuckTask } from '@/lib/types'
import { scoreRating, analyzeTrend, trendDayFromInputs } from '@/lib/performance'

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
    .from('users').select('id, role').eq('id', user.id).single()
  return data as { id: string; role: string } | null
}

// ─── Row types ────────────────────────────────────────────────────────────────

type UserRow = {
  id: string; full_name: string; team: string; position: string | null
}
type ActiveTaskRow = {
  id: string; assigned_to: string; priority: string; status: string
  due_date: string | null; last_update_at: string | null; created_at: string
  title: string
  waiting_on_type: 'team_member' | 'external' | null
  waiting_on_text: string | null
  waiting_on_user_id: string | null
  blocker_reason: string | null
  note: string | null
}
type CompletedTaskRow = {
  id: string; assigned_to: string; priority: string; created_at: string
}
type ActivityRow = {
  actor_id: string; action: string
  from_status: string | null; to_status: string | null
  task_id: string; created_at: string
}
type EodRow = { user_id: string; log_date: string; summary: string | null; highlights: string | null; self_score: number | null; created_at: string }

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const caller = await getCallerProfile(token)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!['admin', 'manager'].includes(caller.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const period = (searchParams.get('period') ?? 'daily') as 'daily' | 'weekly' | 'monthly'

  const today      = new Date().toISOString().slice(0, 10)
  const windowDays = period === 'monthly' ? 30 : period === 'weekly' ? 14 : 7
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()

  // BOE app rollout date — no task/EOD data exists before this so pre-rollout
  // days must be excluded from all metrics (missed EOD, averages, trend, etc.)
  const ROLLOUT_DATE = '2026-06-08'

  const rawDateList: string[] = []
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    rawDateList.push(d.toISOString().slice(0, 10))
  }
  // Drop any dates before rollout so phantom "missed" days are never scored
  const dateList  = rawDateList.filter(d => d >= ROLLOUT_DATE)
  const windowStart = dateList.length > 0 ? dateList[0] : rawDateList[0]

  const client = sb()

  // ── Round 1: fetch users ──────────────────────────────────────────────────
  // Use IS NOT TRUE so that rows where is_deleted is NULL are also included
  const { data: usersRaw, error: e1 } = await client
    .from('users')
    .select('id, full_name, team, position')
    .eq('is_active', true)
    .not('is_deleted', 'is', true)
    .order('full_name')

  if (e1) return NextResponse.json({ error: `users: ${e1.message}` }, { status: 500 })

  const userRows = (usersRaw ?? []) as UserRow[]
  if (userRows.length === 0) return NextResponse.json({ members: [], period, date: today })

  const userIds = userRows.map(u => u.id)

  // ── Round 2: 4 bulk queries scoped to our user IDs ────────────────────────
  const [
    { data: activeTasks,    error: e2 },
    { data: completedTasks, error: e3 },
    { data: activityLogs,   error: e4 },
    { data: eodLogs,        error: e5 },
  ] = await Promise.all([
    // Active tasks (excludes completed and cancelled) — gives current-state metrics
    // No is_deleted filter: column does not exist on tasks table
    client.from('tasks')
      .select('id, assigned_to, priority, status, due_date, last_update_at, created_at, title, waiting_on_type, waiting_on_text, waiting_on_user_id, blocker_reason, note')
      .in('assigned_to', userIds)
      .neq('status', 'completed')
      .neq('status', 'cancelled')
      .limit(50000),

    // Completed tasks — priority + assignee lookup only; NO completed_at column
    // (completion timing comes from activity log to_status events)
    client.from('tasks')
      .select('id, assigned_to, priority, created_at')
      .in('assigned_to', userIds)
      .eq('status', 'completed')
      .limit(50000),

    // Activity log in window — includes to_status so we can detect completions
    client.from('task_activity_log')
      .select('actor_id, action, from_status, to_status, task_id, created_at')
      .in('actor_id', userIds)
      .gte('created_at', `${windowStart}T00:00:00.000Z`)
      .limit(100000),

    // EOD work-logs in window (include summary/highlights/self_score for management view)
    client.from('daily_work_logs')
      .select('user_id, log_date, summary, highlights, self_score, created_at')
      .in('user_id', userIds)
      .gte('log_date', windowStart)
      .limit(10000),
  ])

  if (e2 || e3 || e4 || e5) {
    const err = e2 ?? e3 ?? e4 ?? e5
    return NextResponse.json({ error: `data: ${err!.message}` }, { status: 500 })
  }

  // ── Index all data by user for O(1) lookup ────────────────────────────────

  const userIdSet   = new Set(userIds)
  const userNameMap = new Map<string, string>(userRows.map(u => [u.id, u.full_name]))

  // Task priority + assignee map (covers both active and completed tasks)
  const taskInfoMap = new Map<string, { assigned_to: string; priority: string }>()
  for (const t of (activeTasks ?? []) as ActiveTaskRow[]) {
    taskInfoMap.set(t.id, { assigned_to: t.assigned_to, priority: t.priority })
  }
  for (const t of (completedTasks ?? []) as CompletedTaskRow[]) {
    taskInfoMap.set(t.id, { assigned_to: t.assigned_to, priority: t.priority })
  }

  // Active tasks grouped by assigned_to
  const activeByUser = new Map<string, ActiveTaskRow[]>()
  for (const t of (activeTasks ?? []) as ActiveTaskRow[]) {
    const arr = activeByUser.get(t.assigned_to) ?? []
    arr.push(t)
    activeByUser.set(t.assigned_to, arr)
  }

  // Activity grouped by actor_id  (for momentum + discipline signals)
  const activityByUser = new Map<string, ActivityRow[]>()
  for (const a of (activityLogs ?? []) as ActivityRow[]) {
    const arr = activityByUser.get(a.actor_id) ?? []
    arr.push(a)
    activityByUser.set(a.actor_id, arr)
  }

  // Completions indexed by assigned_to + date (derived from activity log)
  // Key: userId → array of { date: YYYY-MM-DD, priority }
  const completionsByUser = new Map<string, { date: string; priority: string }[]>()
  for (const a of (activityLogs ?? []) as ActivityRow[]) {
    if (a.action !== 'status_changed' || a.to_status !== 'completed') continue
    const info = taskInfoMap.get(a.task_id)
    if (!info || !userIdSet.has(info.assigned_to)) continue
    const arr = completionsByUser.get(info.assigned_to) ?? []
    arr.push({ date: a.created_at.slice(0, 10), priority: info.priority })
    completionsByUser.set(info.assigned_to, arr)
  }

  // Task creation-time map — for timely-ack calculation
  const taskCreatedAt = new Map<string, string>()
  for (const t of (activeTasks ?? []) as ActiveTaskRow[]) taskCreatedAt.set(t.id, t.created_at)
  for (const t of (completedTasks ?? []) as CompletedTaskRow[]) taskCreatedAt.set(t.id, t.created_at)

  // EOD log dates per user + today's entry for analysis table
  const eodByUser    = new Map<string, Set<string>>()
  const eodTodayByUser = new Map<string, { summary: string | null; highlights: string | null; self_score: number | null; created_at: string }>()
  for (const e of (eodLogs ?? []) as EodRow[]) {
    const s = eodByUser.get(e.user_id) ?? new Set<string>()
    s.add(e.log_date)
    eodByUser.set(e.user_id, s)
    if (e.log_date === today) {
      eodTodayByUser.set(e.user_id, { summary: e.summary ?? null, highlights: e.highlights ?? null, self_score: e.self_score, created_at: e.created_at })
    }
  }

  // ── Compute each member's scores in memory ────────────────────────────────

  const members: MemberPerfEntry[] = []

  for (const user of userRows) {
    const uid = user.id

    // Current-state metrics (same for every trend day)
    const userActive = activeByUser.get(uid) ?? []
    const overdueCount      = userActive.filter(t => t.due_date && t.due_date < today).length
    const staleBlockedTasks = userActive.filter(
      t => t.status === 'blocked' && t.last_update_at && t.last_update_at < twoDaysAgo
    )
    const staleBlockedCount = staleBlockedTasks.length
    const blockedCount  = userActive.filter(t => t.status === 'blocked').length
    const waitingTasks  = userActive.filter(t => t.status === 'waiting')
    const waitingCount  = waitingTasks.length

    const stuckTasks: StuckTask[] = [...waitingTasks, ...staleBlockedTasks].map(t => ({
      id:              t.id,
      title:           t.title,
      status:          t.status,
      priority:        t.priority,
      due_date:        t.due_date,
      last_update_at:  t.last_update_at,
      waiting_on_type: t.waiting_on_type,
      waiting_on_text: t.waiting_on_text,
      waiting_on_name: t.waiting_on_user_id
        ? (userNameMap.get(t.waiting_on_user_id) ?? null)
        : null,
      blocker_reason:  t.blocker_reason,
      note:            t.note,
    }))
    const activeTaskCnt = userActive.length

    const userActivity   = activityByUser.get(uid)   ?? []
    const userCompletions = completionsByUser.get(uid) ?? []
    const userEodDates   = eodByUser.get(uid)         ?? new Set<string>()

    // Build trend days
    const trendDays = dateList.map(date => {
      const dayStart = `${date}T00:00:00.000Z`
      const dayEnd   = `${date}T23:59:59.999Z`

      // Completions attributed to this user on this date
      const dayCompletions = userCompletions.filter(c => c.date === date)
      const completedHigh   = dayCompletions.filter(c => c.priority === 'high').length
      const completedMedium = dayCompletions.filter(c => c.priority === 'medium').length
      const completedLow    = dayCompletions.filter(c => c.priority === 'low').length

      // Activity the user performed on this day
      const dayActivity = userActivity.filter(
        a => a.created_at >= dayStart && a.created_at <= dayEnd
      )
      const statusUpdates      = dayActivity.filter(a => a.action === 'status_changed').length
      const blockerResolutions = dayActivity.filter(
        a => a.action === 'status_changed' && a.from_status === 'blocked'
      ).length

      const hasEodLog      = userEodDates.has(date)
      const wasActiveToday = dayActivity.length > 0 || hasEodLog

      // Timely acks: acknowledged within 4h of task creation
      let timelyAcks = 0
      for (const a of dayActivity) {
        if (a.action !== 'acknowledged') continue
        const taskCreated = taskCreatedAt.get(a.task_id)
        if (!taskCreated) continue
        const delta = new Date(a.created_at).getTime() - new Date(taskCreated).getTime()
        if (delta <= 4 * 60 * 60 * 1000) timelyAcks++
      }

      const inputs: DayInputs = {
        completedHigh, completedMedium, completedLow,
        statusUpdates, blockerResolutions,
        hasEodLog, wasActiveToday, timelyAcks,
        overdueCount, staleBlockedCount,
        activeTasks: activeTaskCnt,
        blockedCount,
      }

      return trendDayFromInputs(date, inputs)
    })

    // Today's status updates count (for analysis table)
    const todayStart = `${today}T00:00:00.000Z`
    const todayEnd   = `${today}T23:59:59.999Z`
    const updatesCount = userActivity.filter(
      a => a.action === 'status_changed' && a.created_at >= todayStart && a.created_at <= todayEnd
    ).length

    // timelyAcksToday: tasks acknowledged within 4h of creation, today only
    let timelyAcksToday = 0
    for (const a of userActivity) {
      if (a.created_at < todayStart || a.created_at > todayEnd) continue
      if (a.action !== 'acknowledged') continue
      const taskCreated = taskCreatedAt.get(a.task_id)
      if (!taskCreated) continue
      const delta = new Date(a.created_at).getTime() - new Date(taskCreated).getTime()
      if (delta <= 4 * 60 * 60 * 1000) timelyAcksToday++
    }

    const todayTrend  = trendDays[trendDays.length - 1]
    const trendResult = analyzeTrend(trendDays)

    const riskScore = Math.abs(todayTrend.breakdown.risk) + staleBlockedCount * 4
    const riskLevel: MemberPerfEntry['riskLevel'] =
      riskScore >= 20 ? 'high' : riskScore >= 8 ? 'medium' : 'low'

    let eodLogStreak = 0
    for (let i = trendDays.length - 1; i >= 0; i--) {
      if (trendDays[i].inputs.hasEodLog) eodLogStreak++
      else break
    }

    const completedThisWeek = trendDays.reduce(
      (s, d) => s + d.inputs.completedHigh + d.inputs.completedMedium + d.inputs.completedLow,
      0
    )

    // Monthly health stats (derived from trendDays, no extra DB queries)
    const submittedDays   = trendDays.filter(d => d.inputs.hasEodLog).length
    const pendingDays     = userEodDates.has(today) ? 0 : 1
    const missedDays      = trendDays.length - submittedDays - pendingDays
    const lowScoreDays    = trendDays.filter(d => d.score < 60).length
    const monthlyAvgScore = Math.round(trendDays.reduce((s, d) => s + d.score, 0) / trendDays.length)

    members.push({
      userId:   uid,
      userName: user.full_name,
      team:     user.team,
      position: user.position,
      score:       todayTrend.score,
      rating:      scoreRating(todayTrend.score) as PerformanceRating,
      breakdown:   todayTrend.breakdown,
      overdueCount,
      staleBlockedCount,
      riskLevel,
      trendClassification: trendResult.classification,
      weekOverWeekDelta:   trendResult.weekOverWeekDelta,
      hasEodLogToday:      userEodDates.has(today),
      eodLogStreak,
      activeTasks: activeTaskCnt,
      completedThisWeek,
      updatesCount,
      latestAchievement:  eodTodayByUser.get(uid)?.summary    ?? null,
      latestHighlight:    eodTodayByUser.get(uid)?.highlights ?? null,
      monthlyAvgScore,
      submittedDays,
      missedDays,
      pendingDays,
      lowScoreDays,
      selfScoreToday:  eodTodayByUser.get(uid)?.self_score  ?? null,
      eodSubmittedAt:  eodTodayByUser.get(uid)?.created_at  ?? null,
      waitingCount,
      timelyAcksToday,
      stuckTasks,
    })
  }

  return NextResponse.json({ members, period, date: today })
}
