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
 * Days are Asia/Kolkata business days throughout (see lib/istDate).
 *
 * Risk is reconstructed per day rather than measured once and copied across the
 * window, so a historical day's score no longer changes when today's portfolio
 * changes. See buildDailyRiskSeries in lib/performance for the method and its
 * limits.
 *
 * Every period uses one set of range queries; the window is 7 / 14 / 30 days
 * for daily / weekly / monthly, or an explicit from–to when supplied.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import type { DayInputs, TrendDay } from '@/lib/types'

// No generated Database type in this project — matches the untyped-client
// pattern used elsewhere (e.g. lib/payroll/store.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = SupabaseClient<any, any, any>

import {
  computeBreakdown, scoreRating, analyzeTrend, trendDayFromInputs,
  buildDailyRiskSeries, periodAverageScore,
  type RiskTask, type RiskEvent,
} from '@/lib/performance'
import {
  expectedWorkingDates, eligiblePerformanceDates, resolveExitDate,
  parseDateRangeParams, canViewPerformanceOf, parsePeriod, isValidBusinessDate,
  PERFORMANCE_ROLLOUT_DATE,
  type WorkingDayContext,
} from '@/lib/performanceCalendar'
import { EXCLUDED_SELF_NOTICE } from '@/lib/performanceEligibility'
import { fetchAllRows } from '@/lib/supabasePaging'
import {
  istToday, istDateOf, istDayStartUtc, istDayEndUtc, istAddDays,
} from '@/lib/istDate'

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

// ─── Row shapes ───────────────────────────────────────────────────────────────

type TaskRow = {
  id: string; priority: string; due_date: string | null
  created_at: string; status: string; last_update_at: string | null
  completed_at?: string | null
}
type ActivityRow = {
  action: string; from_status: string | null; to_status: string | null
  task_id: string; created_at: string
  old_val: string | null; new_val: string | null
}
type EodRow = Record<string, unknown> & { log_date: string }

type DayResult = { inputs: DayInputs; eodLog: Record<string, unknown> | null }

const EMPTY_INPUTS: DayInputs = {
  completedHigh: 0, completedMedium: 0, completedLow: 0,
  statusUpdates: 0, blockerResolutions: 0,
  hasEodLog: false, wasActiveToday: false, timelyAcks: 0,
  overdueCount: 0, staleBlockedCount: 0, activeTasks: 0, blockedCount: 0,
}

// ─── Window fetch ─────────────────────────────────────────────────────────────
/**
 * One pass over the whole window: 4 range queries (+1 lookup only when a task
 * was acknowledged in-window but closed before it). Replaces the old per-day
 * fetch, which issued 4 queries per day — up to 120 for a monthly view.
 */
async function fetchWindow(
  client: Svc,
  userId: string,
  dateList: string[],
): Promise<Map<string, DayResult>> {
  const rangeStart = istDayStartUtc(dateList[0])
  const rangeEnd   = istDayEndUtc(dateList[dateList.length - 1])

  const TASK_COLS = 'id, priority, due_date, created_at, status, last_update_at'

  // All four reads are paged. PostgREST silently caps a single response at 1000
  // rows (see lib/supabasePaging.ts), and one busy employee already reaches 824
  // activity rows in a 30-day window — so a slightly busier month would start
  // losing days with no error anywhere. `.order('id')` gives the total order that
  // LIMIT/OFFSET paging needs to avoid skipping or duplicating rows.
  const [openRes, closedRes, activityRes, eodRes] = await Promise.all([
    // Still-open tasks — they were open on every day of the window they existed.
    fetchAllRows<TaskRow>((from, to) => client.from('tasks')
      .select(TASK_COLS)
      .eq('assigned_to', userId)
      .neq('status', 'completed')
      .neq('status', 'cancelled')
      .order('id')
      .range(from, to)),

    // Tasks completed inside the window: open for part of it, so they can carry
    // overdue days of their own before the completion date.
    fetchAllRows<TaskRow>((from, to) => client.from('tasks')
      .select(`${TASK_COLS}, completed_at`)
      .eq('assigned_to', userId)
      .eq('status', 'completed')
      .gte('completed_at', rangeStart)
      .lte('completed_at', rangeEnd)
      .order('id')
      .range(from, to)),

    // old_val/new_val carry the before/after deadline on due_date_changed, which
    // is what makes historical due dates reconstructable.
    fetchAllRows<ActivityRow>((from, to) => client.from('task_activity_log')
      .select('action, from_status, to_status, task_id, created_at, old_val, new_val, id')
      .eq('actor_id', userId)
      .gte('created_at', rangeStart)
      .lte('created_at', rangeEnd)
      .order('id')
      .range(from, to)),

    fetchAllRows<EodRow>((from, to) => client.from('daily_work_logs')
      .select('id, summary, highlights, blockers, self_score, created_at, updated_at, log_date, user_id')
      .eq('user_id', userId)
      .gte('log_date', dateList[0])
      .lte('log_date', dateList[dateList.length - 1])
      .order('id')
      .range(from, to)),
  ])

  // Thrown rather than returned: this helper's contract is a Map, and swallowing a
  // failed read would silently produce a window with missing days — the same class
  // of bug the paging fixes. GET turns this into a 500.
  const readError = openRes.error ?? closedRes.error ?? activityRes.error ?? eodRes.error
  if (readError) throw new Error(`performance window read failed: ${readError}`)

  const open     = openRes.rows
  const closed   = closedRes.rows
  const activity = activityRes.rows
  const eods     = eodRes.rows

  // ── Per-day risk state ──────────────────────────────────────────────────────
  const riskTasks: RiskTask[] = [...open, ...closed].map(t => ({
    id:             t.id,
    due_date:       t.due_date,
    created_at:     t.created_at,
    status:         t.status,
    last_update_at: t.last_update_at,
  }))
  const riskEvents: RiskEvent[] = activity.map(a => ({
    task_id:     a.task_id,
    created_at:  a.created_at,
    action:      a.action,
    from_status: a.from_status,
    to_status:   a.to_status,
    old_val:     a.old_val,
    new_val:     a.new_val,
  }))
  const riskSeries = buildDailyRiskSeries(dateList, riskTasks, riskEvents)

  // ── Current-portfolio counts (display only — not score inputs) ───────────────
  const activeTaskCount = open.length
  const blockedCount    = open.filter(t => t.status === 'blocked').length

  // ── Completions by IST day ──────────────────────────────────────────────────
  const completionsByDate = new Map<string, string[]>()
  for (const t of closed) {
    if (!t.completed_at) continue
    const d = istDateOf(t.completed_at)
    const arr = completionsByDate.get(d)
    if (arr) arr.push(t.priority)
    else completionsByDate.set(d, [t.priority])
  }

  // ── Task creation times, for the timely-ack test ────────────────────────────
  const createdAt = new Map<string, string>()
  for (const t of [...open, ...closed]) createdAt.set(t.id, t.created_at)

  const missingAckIds = [...new Set(
    activity.filter(a => a.action === 'acknowledged' && !createdAt.has(a.task_id))
            .map(a => a.task_id)
  )]
  if (missingAckIds.length > 0) {
    const { data: extra } = await client
      .from('tasks').select('id, created_at').in('id', missingAckIds)
    for (const t of (extra ?? []) as { id: string; created_at: string }[]) {
      createdAt.set(t.id, t.created_at)
    }
  }

  // ── Assemble each day ───────────────────────────────────────────────────────
  const results = new Map<string, DayResult>()

  for (const date of dateList) {
    const dayStart = istDayStartUtc(date)
    const dayEnd   = istDayEndUtc(date)
    const inDay    = (ts: string) => ts >= dayStart && ts <= dayEnd

    const priorities      = completionsByDate.get(date) ?? []
    const completedHigh   = priorities.filter(p => p === 'high').length
    const completedMedium = priorities.filter(p => p === 'medium').length
    const completedLow    = priorities.filter(p => p === 'low').length

    const dayActivity        = activity.filter(a => inDay(a.created_at))
    const statusUpdates      = dayActivity.filter(a => a.action === 'status_changed').length
    const blockerResolutions = dayActivity.filter(
      a => a.action === 'status_changed' && a.from_status === 'blocked'
    ).length

    let timelyAcks = 0
    for (const a of dayActivity) {
      if (a.action !== 'acknowledged') continue
      const created = createdAt.get(a.task_id)
      if (!created) continue
      if (Date.parse(a.created_at) - Date.parse(created) <= 4 * 60 * 60 * 1000) timelyAcks++
    }

    const eodLog = eods.find(l => l.log_date === date) ?? null
    const risk   = riskSeries.get(date) ?? { overdueCount: 0, staleBlockedCount: 0 }

    results.set(date, {
      inputs: {
        completedHigh, completedMedium, completedLow,
        statusUpdates, blockerResolutions,
        hasEodLog:         eodLog !== null,
        wasActiveToday:    dayActivity.length > 0 || eodLog !== null,
        timelyAcks,
        overdueCount:      risk.overdueCount,
        staleBlockedCount: risk.staleBlockedCount,
        // Portfolio size is current-state; it describes the task list now, not
        // on a past date, and does not feed the score.
        activeTasks:       activeTaskCount,
        blockedCount,
      },
      eodLog: eodLog as Record<string, unknown> | null,
    })
  }

  return results
}

// ─── Route ────────────────────────────────────────────────────────────────────
// GET /api/performance-metrics
//   ?period=today|daily|weekly|monthly   window preset (default daily)
//   &from=YYYY-MM-DD&to=YYYY-MM-DD       explicit window, overrides period
//   &userId=…                            admin/manager only
//   &date=YYYY-MM-DD                     which day the daily response describes

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const caller = await getCallerProfile(token)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const userId  = searchParams.get('userId') ?? caller.id
  const today   = istToday()
  const rawDate = searchParams.get('date')
  const from    = searchParams.get('from')
  const to      = searchParams.get('to')

  // Authorisation is decided here, on the server, from the caller's own token —
  // never from anything the client sends about itself.
  if (!canViewPerformanceOf(caller, userId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const period = parsePeriod(searchParams.get('period'))
  if (period === null) {
    return NextResponse.json({ error: 'Invalid period' }, { status: 400 })
  }

  if (rawDate !== null && !isValidBusinessDate(rawDate)) {
    return NextResponse.json({ error: `Invalid date: ${rawDate}` }, { status: 400 })
  }
  const date = rawDate ?? today

  // Validate the explicit range before it reaches any date arithmetic.
  let rangeFrom: string | null = null
  let rangeTo:   string | null = null
  if (from !== null || to !== null) {
    const parsed = parseDateRangeParams(from, to)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    rangeFrom = parsed.from
    rangeTo   = parsed.to
  }

  const client = sb()

  // ── Target employee's working calendar ──────────────────────────────────────
  const { data: targetUser } = await client
    .from('users')
    .select('full_name, joining_date, exit_date, deleted_at, is_deleted, performance_tracking_enabled')
    .eq('id', userId)
    .maybeSingle()

  const userName = (targetUser?.full_name as string | undefined)
    ?? (userId === caller.id ? caller.full_name : userId)

  // Whether this employee is counted in team Performance reporting. The personal
  // page stays fully available either way — an administrator still wants to see
  // their own activity — but it has to say plainly when these figures appear in no
  // team comparison. Silently showing a score that exists nowhere in the team
  // report is how two different sets of numbers end up in the same conversation.
  const performanceTrackingEnabled =
    (targetUser as { performance_tracking_enabled?: boolean | null } | null)
      ?.performance_tracking_enabled !== false

  // ── Build the window ────────────────────────────────────────────────────────
  // The raw span first; holidays only ever remove days from a known span, so
  // they can be fetched once the span is known.
  const windowDays = period === 'monthly' ? 30 : period === 'weekly' ? 14 : 7
  const spanFrom = rangeFrom ?? (period === 'today' ? today : istAddDays(today, -(windowDays - 1)))
  const spanTo   = rangeTo   ?? today

  const holidaySpanFrom = spanFrom < date ? spanFrom : date
  const { data: holidayRows } = await client
    .from('payroll_holidays')
    .select('holiday_date')
    .gte('holiday_date', holidaySpanFrom < PERFORMANCE_ROLLOUT_DATE ? PERFORMANCE_ROLLOUT_DATE : holidaySpanFrom)
    .lte('holiday_date', spanTo)

  const calendar: WorkingDayContext = {
    holidays:    new Set(((holidayRows ?? []) as { holiday_date: string }[]).map(h => h.holiday_date)),
    joiningDate: (targetUser?.joining_date as string | null) ?? null,
    exitDate:    targetUser ? resolveExitDate(targetUser) : null,
  }

  // Two sets, deliberately different:
  //   dateList  — what gets fetched and returned as the trend (includes today
  //               while today is still running, so the daily view stays live)
  //   scoringSet— what counts toward the average (today joins only once its
  //               end-of-day cutoff has passed)
  let dateList = expectedWorkingDates(spanFrom, spanTo, today, calendar)
  const scoringSet = new Set(eligiblePerformanceDates(spanFrom, spanTo, today, calendar))

  // The 'today' view and an explicitly requested day must always be fetched,
  // even on a Sunday or holiday — the page still has to render that day.
  //
  // Not for an explicit from/to range though: `date` defaults to today, and
  // forcing it in would append today to a last-month window.
  const forced = period === 'today' ? today : (rangeFrom === null ? date : null)
  if (forced !== null
      && !dateList.includes(forced)
      && forced >= PERFORMANCE_ROLLOUT_DATE
      && forced <= today) {
    dateList = [...dateList, forced].sort()
  }

  if (dateList.length === 0) {
    return NextResponse.json({
      period, date, userId, userName,
      score: 0, rating: scoreRating(0),
      breakdown: computeBreakdown(EMPTY_INPUTS), inputs: EMPTY_INPUTS,
      trend: [], trendAnalysis: {
        classification: 'insufficient_data', direction: 'flat',
        streak: 0, weekOverWeekDelta: 0, description: 'No trackable days in range',
      },
      eodLog: null,
    })
  }

  // A failed or truncated read must surface as a 500, not as a window with holes
  // in it. The message stays server-side; the client gets a generic error.
  let windowData
  try {
    windowData = await fetchWindow(client, userId, dateList)
  } catch (e) {
    console.error('performance-metrics window fetch failed:', e)
    return NextResponse.json({ error: 'Failed to load performance data' }, { status: 500 })
  }
  const dayResults: TrendDay[] = dateList.map(d => trendDayFromInputs(d, windowData.get(d)!.inputs))

  // ── Today-only fast path ────────────────────────────────────────────────────
  if (period === 'today') {
    const { inputs, eodLog } = windowData.get(today)!
    const breakdown = computeBreakdown(inputs)
    return NextResponse.json({
      period: 'daily', date: today, userId, userName,
      score:  breakdown.total,
      rating: scoreRating(breakdown.total),
      breakdown, inputs,
      trend: [],
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

  const trendAnalysis = analyzeTrend(dayResults)

  // ── Daily response ──────────────────────────────────────────────────────────
  if (period === 'daily' && rangeFrom === null) {
    const day       = windowData.get(date) ?? windowData.get(today)!
    const breakdown = computeBreakdown(day.inputs)

    return NextResponse.json({
      period, date, userId, userName,
      score:  breakdown.total,
      rating: scoreRating(breakdown.total),
      breakdown,
      inputs: day.inputs,
      trend:  dayResults,
      trendAnalysis,
      eodLog: day.eodLog,
    })
  }

  // ── Weekly / monthly / explicit-range aggregate ─────────────────────────────
  const todayDay       = windowData.get(today) ?? windowData.get(dateList[dateList.length - 1])!
  const todayBreakdown = computeBreakdown(todayDay.inputs)

  // Average over scoring days only. The trend still carries today so the page
  // can show a live figure, but today does not drag the average down until its
  // end-of-day cutoff has passed.
  const scoredDays = dayResults.filter(d => scoringSet.has(d.date))
  const avgScore   = periodAverageScore(scoredDays) ?? 0

  const aggregate = {
    totalCompletedHigh:   dayResults.reduce((s, d) => s + d.inputs.completedHigh,   0),
    totalCompletedMedium: dayResults.reduce((s, d) => s + d.inputs.completedMedium, 0),
    totalCompletedLow:    dayResults.reduce((s, d) => s + d.inputs.completedLow,    0),
    totalCompleted:       dayResults.reduce((s, d) => s + d.inputs.completedHigh + d.inputs.completedMedium + d.inputs.completedLow, 0),
    totalStatusUpdates:   dayResults.reduce((s, d) => s + d.inputs.statusUpdates,   0),
    eodLogRate:           scoredDays.length > 0
      ? Math.round(scoredDays.filter(d => d.inputs.hasEodLog).length / scoredDays.length * 100)
      : 0,
    avgScore,
    daysCounted:          scoredDays.length,
    rangeFrom:            dateList[0],
    rangeTo:              dateList[dateList.length - 1],
    bestDay:  dayResults.reduce((best,  d) => d.score > best.score  ? d : best,  dayResults[0]),
    worstDay: dayResults.reduce((worst, d) => d.score < worst.score ? d : worst, dayResults[0]),
  }

  return NextResponse.json({
    period, date: today, userId, userName,
    score:  avgScore,
    rating: scoreRating(avgScore),
    breakdown: todayBreakdown,
    inputs:    todayDay.inputs,
    trend:     dayResults,
    trendAnalysis,
    eodLog:    todayDay.eodLog,
    aggregate,
    performanceTrackingEnabled,
    // Null when tracked, so the page renders the notice only when there is one.
    exclusionNotice: performanceTrackingEnabled ? null : EXCLUDED_SELF_NOTICE,
  })
}
