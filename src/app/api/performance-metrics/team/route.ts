/**
 * Team Performance — management dataset.
 *
 * GET /api/performance-metrics/team
 *   ?period=today|this_week|last_week|this_month|last_month|custom
 *   &from=YYYY-MM-DD&to=YYYY-MM-DD      (custom only)
 *
 * Admin/manager only.
 *
 * One request returns everything the Team Performance page renders: the
 * resolved period, the previous equivalent period, per-employee metrics for
 * both, the attention briefing, the positives, rankings, EOD and activity
 * summaries. The page does no scoring of its own — if the cards, the table, the
 * rankings and the drawer each derived their own numbers they would eventually
 * disagree, and the owner would stop trusting all of them.
 *
 * Query plan — fixed count, independent of team size:
 *
 *   Round 1:  users (with joining/exit dates and Performance eligibility)
 *
 *   Round 2 (parallel, all scoped to the *tracked* user IDs):
 *     2. Non-completed tasks        current portfolio state
 *     3. Completed tasks            priority/due-date lookup for completions
 *     4. Activity log over the combined span (previous period → now)
 *     5. EOD work-logs over the combined span
 *     6. Tasks created in the span  (created_by — task-creation metric)
 *     7. payroll_holidays           company calendar
 *     8. performance_app_opens      System Adoption first-open events
 *
 * Eligibility is applied in round 1, before anything is fetched or computed, so
 * an excluded account cannot reach a total, an average, a ranking or a rate by
 * any path. Filtering later — or, worse, in the browser — would leave every
 * server-computed aggregate contaminated.
 *
 * Why we avoid selecting completed_at:
 *   PostgREST returns a 400 when you SELECT a column absent from its schema
 *   cache, even if the column exists in the DB. Completion timing is derived
 *   from the activity log's to_status = 'completed' + created_at instead.
 */

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import type { DayInputs, MemberPerfEntry, PerformanceRating, StuckTask, TrendDay } from '@/lib/types'
import {
  scoreRating, analyzeTrend, trendDayFromInputs,
  buildDailyRiskSeries, periodAverageScore, dueDateAsOf,
  STALE_BLOCKED_DAYS,
  type RiskTask, type RiskEvent,
} from '@/lib/performance'
import {
  expectedWorkingDates, eligiblePerformanceDates, resolveExitDate,
  resolvePeriod, isPeriodKey, parseDateRangeParams, hasDayCutoffPassed,
  canViewTeamPerformance, holidayCalendarCoverage, calendarConfidence,
  PERFORMANCE_ROLLOUT_DATE,
  type WorkingDayContext, type PeriodKey, type ResolvedPeriod,
} from '@/lib/performanceCalendar'
import {
  meaningfulActiveDays, classifyEodSubmission, classifyMember,
  buildAttentionItems, buildPositiveItems, buildRanking,
  pickBestPerformer, pickWeakestPerformer, pickMostImproved, pickMostDeclined,
  onTimeCompletionRate, scoreDelta, isRankable, unrankedPool,
  buildRanksAndExplanations, movementExplanation, overallRanking,
  MIN_SCORED_DAYS_FOR_RANKING,
  RANKING_KEYS,
  type MemberMetrics, type EodDetail, type RankExplanation,
  type CoverageSummary, type AdoptionSummary, type MemberEvidence,
} from '@/lib/teamPerformance'
import {
  partitionByTracking, canViewExcludedDetails,
  type ExcludedUser,
} from '@/lib/performanceEligibility'
import {
  resolveWorkdayStart, computeAdoption, adoptionRecordingFrom, hasAdoptionData,
  type AppOpenRecord,
} from '@/lib/performanceAdoption'
import { ATTENDANCE_LIMITATION_NOTE } from '@/lib/performanceAttendance'
import { fetchAllRows, PAGED_FETCH_ROW_CAP } from '@/lib/supabasePaging'
import { istToday, istDateOf, istDayStartUtc, istDayEndUtc, istMinutesOfDay } from '@/lib/istDate'

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
  joining_date: string | null; exit_date: string | null
  deleted_at: string | null; is_deleted: boolean | null
  office_timing: string | null
  performance_tracking_enabled: boolean | null
  performance_tracking_note: string | null
}
type AppOpenRow = {
  user_id: string; business_date: string; first_opened_at: string
}
type ActiveTaskRow = {
  id: string; assigned_to: string; priority: string; status: string
  due_date: string | null; last_update_at: string | null; created_at: string
  acknowledged_at: string | null
  title: string
  waiting_on_type: 'team_member' | 'external' | null
  waiting_on_text: string | null
  waiting_on_user_id: string | null
  blocker_reason: string | null
  note: string | null
}
type CompletedTaskRow = {
  id: string; assigned_to: string; priority: string; created_at: string
  status: string; due_date: string | null; last_update_at: string | null
  acknowledged_at: string | null
}
type ActivityRow = {
  actor_id: string; action: string
  from_status: string | null; to_status: string | null
  task_id: string; created_at: string
  old_val: string | null; new_val: string | null
}
type EodRow = {
  user_id: string; log_date: string; summary: string | null
  highlights: string | null; self_score: number | null; created_at: string
}
type CreatedTaskRow = {
  id: string; created_by: string; assigned_to: string; created_at: string
}

/** Tasks acknowledged within this long of being created count as timely. */
const ACK_WINDOW_MS = 4 * 60 * 60 * 1000

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const caller = await getCallerProfile(token)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // Server-side gate. The page also hides itself from other roles, but that is
  // cosmetic — this is the check that matters.
  if (!canViewTeamPerformance(caller)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const today = istToday()

  // ── Resolve the one period that drives the whole page ───────────────────────
  const rawPeriod = searchParams.get('period') ?? 'this_month'
  if (!isPeriodKey(rawPeriod)) {
    return NextResponse.json({ error: `Invalid period: ${rawPeriod}` }, { status: 400 })
  }
  const periodKey: PeriodKey = rawPeriod

  let custom: { from: string; to: string } | undefined
  if (periodKey === 'custom') {
    const parsed = parseDateRangeParams(searchParams.get('from'), searchParams.get('to'))
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    custom = { from: parsed.from, to: parsed.to }
  }

  const period: ResolvedPeriod = resolvePeriod(periodKey, today, custom)

  // Everything is fetched across one contiguous span covering both periods, so
  // the previous-period comparison costs no extra round trips.
  const spanStart = period.previous.from < PERFORMANCE_ROLLOUT_DATE
    ? PERFORMANCE_ROLLOUT_DATE
    : period.previous.from
  const spanEnd = period.to

  const client = sb()

  // ── Round 1: users ──────────────────────────────────────────────────────────
  // IS NOT TRUE so rows where is_deleted is NULL are also included.
  const { data: usersRaw, error: e1 } = await client
    .from('users')
    .select('id, full_name, team, position, joining_date, exit_date, deleted_at, is_deleted, '
          + 'office_timing, performance_tracking_enabled, performance_tracking_note')
    .eq('is_active', true)
    .not('is_deleted', 'is', true)
    .order('full_name')

  if (e1) return NextResponse.json({ error: `users: ${e1.message}` }, { status: 500 })

  // `as unknown` first: the multi-line select string defeats PostgREST's literal
  // type inference, so it widens to GenericStringError[] and TS refuses the direct
  // cast. The runtime shape is checked by the select list itself.
  const allActive = (usersRaw ?? []) as unknown as UserRow[]

  // ── Performance eligibility, applied before anything is measured ────────────
  // Excluded accounts are dropped here, so they are absent from every query
  // below, from every per-employee metric, and therefore from every total,
  // average, rate, ranking and briefing item. There is no later filter to forget.
  const { tracked: userRows, excluded } = partitionByTracking(allActive)
  const showExcludedDetails = canViewExcludedDetails(caller)

  if (userRows.length === 0) {
    return NextResponse.json(emptyResponse(period, excluded, showExcludedDetails))
  }

  const userIds = userRows.map(u => u.id)

  // ── Round 2 ─────────────────────────────────────────────────────────────────
  const [
    activeRes,
    completedRes,
    activityRes,
    eodRes,
    createdRes,
    { data: holidayRows },
    appOpenRes,
    { data: firstEverOpen, error: eFirstOpen },
  ] = await Promise.all([
    // Every read below goes through fetchAllRows because PostgREST caps a single
    // response at 1000 rows (POSTGREST_MAX_ROWS) and does so SILENTLY — `.limit()`
    // is reduced without an error. This route previously asked for 50000/100000
    // and received 1000, losing 75% of the activity log and, because the survivors
    // were the oldest rows in the window, the entire current month. See
    // lib/supabasePaging.ts for the measurements.
    //
    // Each page carries `.order('id')`: LIMIT/OFFSET without a total order can
    // skip or duplicate rows across page boundaries. `id` is the primary key, so
    // it is always unique. Ordering by it is safe here because every consumer
    // either groups by key or sorts by `created_at` itself.
    fetchAllRows<ActiveTaskRow>((from, to) => client.from('tasks')
      .select('id, assigned_to, priority, status, due_date, last_update_at, created_at, acknowledged_at, title, waiting_on_type, waiting_on_text, waiting_on_user_id, blocker_reason, note')
      .in('assigned_to', userIds)
      .neq('status', 'completed')
      .neq('status', 'cancelled')
      .order('id')
      .range(from, to)),

    fetchAllRows<CompletedTaskRow>((from, to) => client.from('tasks')
      .select('id, assigned_to, priority, created_at, status, due_date, last_update_at, acknowledged_at')
      .in('assigned_to', userIds)
      .eq('status', 'completed')
      .order('id')
      .range(from, to)),

    fetchAllRows<ActivityRow>((from, to) => client.from('task_activity_log')
      .select('actor_id, action, from_status, to_status, task_id, created_at, old_val, new_val, id')
      .in('actor_id', userIds)
      .gte('created_at', istDayStartUtc(spanStart))
      .lte('created_at', istDayEndUtc(spanEnd))
      .order('id')
      .range(from, to)),

    fetchAllRows<EodRow>((from, to) => client.from('daily_work_logs')
      .select('user_id, log_date, summary, highlights, self_score, created_at, id')
      .in('user_id', userIds)
      .gte('log_date', spanStart)
      .lte('log_date', spanEnd)
      .order('id')
      .range(from, to)),

    // Task creation is a real signal: tasks.created_by tells us who planned the
    // work, and comparing it with assigned_to separates self-tasks from
    // delegation.
    fetchAllRows<CreatedTaskRow>((from, to) => client.from('tasks')
      .select('id, created_by, assigned_to, created_at')
      .in('created_by', userIds)
      .gte('created_at', istDayStartUtc(spanStart))
      .lte('created_at', istDayEndUtc(spanEnd))
      .order('id')
      .range(from, to)),

    // Holidays cannot approach the cap — one row per company holiday per period.
    client.from('payroll_holidays')
      .select('holiday_date')
      .gte('holiday_date', spanStart)
      .lte('holiday_date', spanEnd),

    // System Adoption. Read over the current period only — the previous period
    // needs no adoption comparison, and adoption is not part of the score.
    // Paged too: one row per employee per working day reaches 1000 in about four
    // months for a team of ten.
    fetchAllRows<AppOpenRow>((from, to) => client.from('performance_app_opens')
      .select('user_id, business_date, first_opened_at, id')
      .in('user_id', userIds)
      .gte('business_date', period.from)
      .lte('business_date', period.to)
      .order('id')
      .range(from, to)),

    // The earliest open ever recorded, for anybody. This is what makes a missing
    // row meaningful: before this date nothing was being recorded for anyone, so
    // absence proves nothing and must not be reported as a missed open. Scoped to
    // the whole table rather than the period, because deriving it from the period
    // alone would mark a period in which nobody opened the app as "no data yet"
    // and quietly hide genuine total non-use. One row, so no paging.
    client.from('performance_app_opens')
      .select('business_date')
      .order('business_date', { ascending: true })
      .limit(1),
  ])

  const err = activeRes.error ?? completedRes.error ?? activityRes.error
           ?? eodRes.error ?? createdRes.error
  if (err) return NextResponse.json({ error: `data: ${err}` }, { status: 500 })

  // A paged read that hit the row cap would under-report, which is the exact
  // failure this route was built to stop hiding. Refuse rather than mislead.
  const capped = [
    ['tasks', activeRes], ['completed tasks', completedRes],
    ['activity log', activityRes], ['EOD logs', eodRes], ['created tasks', createdRes],
  ].find(([, r]) => (r as { truncated: boolean }).truncated)
  if (capped) {
    return NextResponse.json({
      error: `data: ${capped[0]} exceeded the ${PAGED_FETCH_ROW_CAP}-row read cap for this period; narrow the date range`,
    }, { status: 500 })
  }

  const activeTasks    = activeRes.rows
  const completedTasks = completedRes.rows
  const activityLogs   = activityRes.rows
  const eodLogs        = eodRes.rows
  const createdTasks   = createdRes.rows
  const appOpenRows    = appOpenRes.rows
  const eOpens         = appOpenRes.error

  // Adoption is deliberately NOT fatal. If performance_app_opens is missing or
  // unreadable the page must still render every score, ranking and briefing item
  // — a supplementary metric failing has no business taking down the report.
  const adoptionError = eOpens ?? eFirstOpen?.message ?? null
  if (adoptionError) {
    console.error('performance_app_opens read failed; adoption omitted:', adoptionError)
  }
  const adoptionAvailable = !adoptionError
  const appOpens: AppOpenRecord[] = (adoptionAvailable ? appOpenRows : [])
    .map(r => ({ userId: r.user_id, businessDate: r.business_date, firstOpenedAt: r.first_opened_at }))

  // Earliest row in the whole table, falling back to the earliest in this period
  // if the lookup returned nothing but the period did.
  const openRecordingFrom = adoptionAvailable
    ? (((firstEverOpen ?? []) as { business_date: string }[])[0]?.business_date
       ?? adoptionRecordingFrom(appOpens))
    : null
  const opensByUser = groupBy(appOpens, r => r.userId)

  // ── Index everything once ───────────────────────────────────────────────────

  const userIdSet   = new Set(userIds)
  const userNameMap = new Map<string, string>(userRows.map(u => [u.id, u.full_name]))
  const holidaySet  = new Set(((holidayRows ?? []) as { holiday_date: string }[]).map(h => h.holiday_date))

  // Already typed and fully paged by fetchAllRows — no cast, and no `?? []`.
  const active    = activeTasks
  const completed = completedTasks
  const activity  = activityLogs
  const eods      = eodLogs
  const created   = createdTasks

  const taskInfoMap = new Map<string, { assigned_to: string; priority: string; due_date: string | null }>()
  for (const t of active)    taskInfoMap.set(t.id, { assigned_to: t.assigned_to, priority: t.priority, due_date: t.due_date })
  for (const t of completed) taskInfoMap.set(t.id, { assigned_to: t.assigned_to, priority: t.priority, due_date: t.due_date })

  const activeByUser = groupBy(active, t => t.assigned_to)
  const completedByUser = groupBy(completed, t => t.assigned_to)
  const activityByUser  = groupBy(activity, a => a.actor_id)
  const createdByUser   = groupBy(created,  t => t.created_by)

  // Activity per task, for due-date reconstruction at completion time.
  const activityByTask = groupBy(activity, a => a.task_id)

  // Completion events with the date they landed on and the deadline that
  // applied at that moment.
  type Completion = { userId: string; date: string; priority: string; onTime: boolean | null }
  const completionsByUser = new Map<string, Completion[]>()
  for (const a of activity) {
    if (a.action !== 'status_changed' || a.to_status !== 'completed') continue
    const info = taskInfoMap.get(a.task_id)
    if (!info || !userIdSet.has(info.assigned_to)) continue

    const due = dueDateAsOf(info.due_date, (activityByTask.get(a.task_id) ?? []) as RiskEvent[], a.created_at)
    const completedOn = istDateOf(a.created_at)

    const arr = completionsByUser.get(info.assigned_to) ?? []
    arr.push({
      userId:   info.assigned_to,
      date:     completedOn,
      priority: info.priority,
      // Null means the task carried no deadline, so it cannot be on or off time.
      onTime:   due === null ? null : completedOn <= due,
    })
    completionsByUser.set(info.assigned_to, arr)
  }

  const taskCreatedAt = new Map<string, string>()
  for (const t of [...active, ...completed]) taskCreatedAt.set(t.id, t.created_at)

  const eodByUser = new Map<string, Map<string, EodRow>>()
  for (const e of eods) {
    const m = eodByUser.get(e.user_id) ?? new Map<string, EodRow>()
    m.set(e.log_date, e)
    eodByUser.set(e.user_id, m)
  }

  const now = new Date()

  // ── Per-employee computation ────────────────────────────────────────────────

  const metrics: MemberMetrics[] = []
  const legacy:  MemberPerfEntry[] = []
  /** Kept out of MemberMetrics so the pure logic stays free of UI payloads. */
  const evidence = new Map<string, MemberEvidence>()

  for (const user of userRows) {
    const uid = user.id

    const calendar: WorkingDayContext = {
      holidays:    holidaySet,
      joiningDate: user.joining_date,
      exitDate:    resolveExitDate(user),
    }

    const curDates  = expectedWorkingDates(period.from, period.to, today, calendar)
    const curScored = new Set(eligiblePerformanceDates(period.from, period.to, today, calendar, now))
    const prevDates = expectedWorkingDates(period.previous.from, period.previous.to, today, calendar)
    const prevScored = new Set(eligiblePerformanceDates(period.previous.from, period.previous.to, today, calendar, now))

    const userActivity   = activityByUser.get(uid) ?? []
    const userEods       = eodByUser.get(uid) ?? new Map<string, EodRow>()
    const userActiveTsk  = activeByUser.get(uid) ?? []
    const userCompleted  = completedByUser.get(uid) ?? []
    const userCreations  = createdByUser.get(uid) ?? []
    const userCompletions = completionsByUser.get(uid) ?? []

    // ── Current portfolio state (now, not period totals) ──────────────────────
    const twoDaysAgo = new Date(now.getTime() - STALE_BLOCKED_DAYS * 86_400_000).toISOString()
    const overdueTasks = userActiveTsk.filter(t => t.due_date && t.due_date < today)
    const staleBlockedTasks = userActiveTsk.filter(
      t => t.status === 'blocked' && t.last_update_at && t.last_update_at < twoDaysAgo
    )
    const waitingTasks = userActiveTsk.filter(t => t.status === 'waiting')

    const oldestOverdueDays = overdueTasks.reduce((max, t) => {
      const days = Math.floor(
        (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${t.due_date}T00:00:00Z`)) / 86_400_000
      )
      return days > max ? days : max
    }, 0)

    const stuckTasks: StuckTask[] = [...waitingTasks, ...staleBlockedTasks].map(t => ({
      id: t.id, title: t.title, status: t.status, priority: t.priority,
      due_date: t.due_date, last_update_at: t.last_update_at,
      waiting_on_type: t.waiting_on_type, waiting_on_text: t.waiting_on_text,
      waiting_on_name: t.waiting_on_user_id ? (userNameMap.get(t.waiting_on_user_id) ?? null) : null,
      blocker_reason: t.blocker_reason, note: t.note,
    }))

    // ── Scores for both windows ───────────────────────────────────────────────
    const riskTasks: RiskTask[] = [...userActiveTsk, ...userCompleted].map(t => ({
      id: t.id, due_date: t.due_date, created_at: t.created_at,
      status: t.status, last_update_at: t.last_update_at,
    }))
    const riskEvents: RiskEvent[] = userActivity.map(a => ({
      task_id: a.task_id, created_at: a.created_at, action: a.action,
      from_status: a.from_status, to_status: a.to_status,
      old_val: a.old_val, new_val: a.new_val,
    }))

    const buildTrend = (dates: string[]): TrendDay[] => {
      if (dates.length === 0) return []
      const risk = buildDailyRiskSeries(dates, riskTasks, riskEvents, now)
      return dates.map(date => {
        const dayStart = istDayStartUtc(date)
        const dayEnd   = istDayEndUtc(date)
        const inDay    = (ts: string) => ts >= dayStart && ts <= dayEnd

        const dayCompletions = userCompletions.filter(c => c.date === date)
        const dayActivity    = userActivity.filter(a => inDay(a.created_at))
        const dayRisk        = risk.get(date) ?? { overdueCount: 0, staleBlockedCount: 0 }

        let timelyAcks = 0
        for (const a of dayActivity) {
          if (a.action !== 'acknowledged') continue
          const createdIso = taskCreatedAt.get(a.task_id)
          if (!createdIso) continue
          if (Date.parse(a.created_at) - Date.parse(createdIso) <= ACK_WINDOW_MS) timelyAcks++
        }

        const hasEodLog = userEods.has(date)
        const inputs: DayInputs = {
          completedHigh:   dayCompletions.filter(c => c.priority === 'high').length,
          completedMedium: dayCompletions.filter(c => c.priority === 'medium').length,
          completedLow:    dayCompletions.filter(c => c.priority === 'low').length,
          statusUpdates:      dayActivity.filter(a => a.action === 'status_changed').length,
          blockerResolutions: dayActivity.filter(a => a.action === 'status_changed' && a.from_status === 'blocked').length,
          hasEodLog,
          wasActiveToday: dayActivity.length > 0 || hasEodLog,
          timelyAcks,
          overdueCount:      dayRisk.overdueCount,
          staleBlockedCount: dayRisk.staleBlockedCount,
          activeTasks:       userActiveTsk.length,
          blockedCount:      userActiveTsk.filter(t => t.status === 'blocked').length,
        }
        return trendDayFromInputs(date, inputs)
      })
    }

    const curTrend  = buildTrend(curDates)
    const prevTrend = buildTrend(prevDates)

    const curScoredDays  = curTrend.filter(d => curScored.has(d.date))
    const prevScoredDays = prevTrend.filter(d => prevScored.has(d.date))

    const score     = periodAverageScore(curScoredDays)
    const prevScore = periodAverageScore(prevScoredDays)

    // ── Meaningful activity ───────────────────────────────────────────────────
    const inPeriod = (ts: string) => {
      const d = istDateOf(ts)
      return d >= period.from && d <= period.to
    }
    const periodActivity = userActivity.filter(a => inPeriod(a.created_at))
    const periodEodDates = new Set([...userEods.keys()].filter(d => d >= period.from && d <= period.to))
    const { activeDays, activeDates, eodOnlyDays } = meaningfulActiveDays(curDates, periodActivity, periodEodDates)
    // Sent to the client as evidence. Derived here, from the same call that
    // produced activeDays, so the date list and the count cannot disagree.
    const activeDateList = curDates.filter(d => activeDates.has(d))
    const idleDateList   = curDates.filter(d => !activeDates.has(d))

    // Spread across the days the employee actually WORKED — best active day minus
    // worst active day.
    //
    // Deliberately not "best minus worst scored day". Idle days score 0, so any
    // employee with one idle day and one decent day showed a spread equal to their
    // best day: measured against real data that labelled 7 of 10 employees
    // "Inconsistent", including the top performer at 76/100 whose "volatility" was
    // just two days off. That is not inconsistency, it is non-use — which already
    // has its own metric (active-day rate) and its own status (Low Activity).
    // Counting it twice made the status column say nothing at all.
    //
    // Computed from the scored set only, so a provisional today cannot inflate it
    // mid-morning.
    const activeScoredDays = curScoredDays.filter(d => activeDates.has(d.date))
    const scoreSpread = activeScoredDays.length >= 2
      ? Math.max(...activeScoredDays.map(d => d.score)) - Math.min(...activeScoredDays.map(d => d.score))
      : null

    // ── EOD timing ────────────────────────────────────────────────────────────
    let eodOnTime = 0, eodLate = 0, eodMissed = 0, eodSubmitted = 0
    const eodRows: EodDetail[] = []
    for (const date of curDates) {
      const row = userEods.get(date) ?? null
      const status = classifyEodSubmission(date, row?.created_at ?? null, hasDayCutoffPassed(date, now))
      if (status === 'on_time') { eodOnTime++; eodSubmitted++ }
      else if (status === 'late') { eodLate++; eodSubmitted++ }
      else if (status === 'missed') eodMissed++
      eodRows.push({
        date, status,
        submittedAt: row?.created_at ?? null,
        summary:     row?.summary ?? null,
        selfScore:   row?.self_score ?? null,
      })
    }
    // Streak counted backwards from the most recent eligible day.
    let eodStreak = 0
    for (let i = eodRows.length - 1; i >= 0; i--) {
      const s = eodRows[i].status
      if (s === 'pending') continue
      if (s === 'on_time' || s === 'late') eodStreak++
      else break
    }

    // ── Completions and creations in the period ───────────────────────────────
    const periodCompletions = userCompletions.filter(c => c.date >= period.from && c.date <= period.to)
    const prevCompletions   = userCompletions.filter(c => c.date >= period.previous.from && c.date <= period.previous.to)
    const dated             = periodCompletions.filter(c => c.onTime !== null)

    const periodCreations = userCreations.filter(t => inPeriod(t.created_at))

    // ── Acknowledgement ───────────────────────────────────────────────────────
    // tasks.acknowledged_at is authoritative; the activity log is only a proxy.
    const ackable = [...userActiveTsk, ...userCompleted].filter(
      t => t.acknowledged_at && inPeriod(t.acknowledged_at)
    )
    const acksOnTime = ackable.filter(
      t => Date.parse(t.acknowledged_at!) - Date.parse(t.created_at) <= ACK_WINDOW_MS
    ).length

    // ── System Adoption ───────────────────────────────────────────────────────
    // Never folded into the score.
    //
    // Measured over the expected working days, INCLUDING today — but today only
    // once its start window has closed. Adoption asks "did they open the app near
    // the start of the day", which is decidable by 10:30, so waiting for the 19:00
    // scoring cutoff would leave "Today" permanently empty. Before the window
    // closes, today is not yet a miss, so it is left out entirely rather than
    // counted against anyone.
    const window = resolveWorkdayStart(user.office_timing)
    const adoptionWindowClosedToday =
      istMinutesOfDay(now) > window.windowEndMinutes
    const adoptionDates = curDates.filter(
      d => d !== today || adoptionWindowClosedToday
    )
    const adoption = adoptionAvailable
      ? computeAdoption(adoptionDates, opensByUser.get(uid) ?? [], window, openRecordingFrom)
      : computeAdoption([], [], window, null)

    const m: MemberMetrics = {
      userId: uid, userName: user.full_name, team: user.team, position: user.position,
      eligibleDays: curDates.length,
      activeDays,
      scoredDays:   curScoredDays.length,
      eodOnlyDays,
      prevEligibleDays: prevDates.length,
      prevScoredDays:   prevScoredDays.length,
      score, prevScore, scoreSpread, adoption,
      breakdown: curScoredDays.length > 0 ? curScoredDays[curScoredDays.length - 1].breakdown : null,
      tasksCompleted:        periodCompletions.length,
      tasksCompletedOnTime:  dated.filter(c => c.onTime === true).length,
      tasksCompletedLate:    dated.filter(c => c.onTime === false).length,
      tasksWithDueDate:      dated.length,
      tasksCreatedSelf:      periodCreations.filter(t => t.assigned_to === uid).length,
      tasksCreatedDelegated: periodCreations.filter(t => t.assigned_to !== uid).length,
      prevTasksCompleted:    prevCompletions.length,
      activeTasks:         userActiveTsk.length,
      overdueCount:        overdueTasks.length,
      highPriorityOverdue: overdueTasks.filter(t => t.priority === 'high').length,
      oldestOverdueDays,
      staleBlockedCount:   staleBlockedTasks.length,
      waitingCount:        waitingTasks.length,
      blockedCount:        userActiveTsk.filter(t => t.status === 'blocked').length,
      acksTotal:  ackable.length,
      acksOnTime,
      eodSubmitted, eodOnTime, eodLate, eodMissed, eodStreak,
      statusUpdates: periodActivity.filter(a => a.action === 'status_changed').length,
    }
    metrics.push(m)
    evidence.set(uid, {
      stuckTasks, trend: curTrend, eodRows,
      activeDates: activeDateList, idleDates: idleDateList,
    })

    // ── Legacy entry, so the existing stuck-task modal keeps working ──────────
    const todayTrend = curTrend.length > 0 ? curTrend[curTrend.length - 1] : null
    const trendResult = analyzeTrend(curTrend)
    const riskScore = (todayTrend ? Math.abs(todayTrend.breakdown.risk) : 0) + staleBlockedTasks.length * 4
    const todayEod = userEods.get(today)

    legacy.push({
      userId: uid, userName: user.full_name, team: user.team, position: user.position,
      score:     todayTrend?.score ?? 0,
      rating:    scoreRating(todayTrend?.score ?? 0) as PerformanceRating,
      breakdown: todayTrend?.breakdown ?? { output: 0, momentum: 0, discipline: 0, risk: 0, total: 0 },
      overdueCount:      overdueTasks.length,
      staleBlockedCount: staleBlockedTasks.length,
      riskLevel: riskScore >= 20 ? 'high' : riskScore >= 8 ? 'medium' : 'low',
      trendClassification: trendResult.classification,
      weekOverWeekDelta:   trendResult.weekOverWeekDelta,
      hasEodLogToday: userEods.has(today),
      eodLogStreak:   eodStreak,
      activeTasks:    userActiveTsk.length,
      completedThisWeek: periodCompletions.length,
      updatesCount:      m.statusUpdates,
      latestAchievement: todayEod?.summary    ?? null,
      latestHighlight:   todayEod?.highlights ?? null,
      monthlyAvgScore:   score ?? 0,
      submittedDays: eodSubmitted,
      missedDays:    eodMissed,
      pendingDays:   eodRows.filter(r => r.status === 'pending').length,
      lowScoreDays:  curScoredDays.filter(d => d.score < 60).length,
      selfScoreToday: todayEod?.self_score ?? null,
      eodSubmittedAt: todayEod?.created_at ?? null,
      waitingCount:   waitingTasks.length,
      timelyAcksToday: acksOnTime,
      stuckTasks,
    })
  }

  // ── Team-level conclusions ──────────────────────────────────────────────────

  const best     = pickBestPerformer(metrics)
  const weakest  = pickWeakestPerformer(metrics)
  const improved = pickMostImproved(metrics)
  const declined = pickMostDeclined(metrics)

  // Rank map and "why this rank?" text, built from one ordering so the cards, the
  // table, the rankings tab and the drawer all quote the same position.
  const ordered = overallRanking(metrics)
  const { ranks, explanations } = buildRanksAndExplanations(metrics)

  const classifications = Object.fromEntries(
    metrics.map(m => [m.userId, classifyMember(m)])
  )

  // ── Team average: measured employees only ──────────────────────────────────
  // Restricted to the rankable pool rather than "anyone with a score". A team
  // average that includes someone's single scored day is not the team's average,
  // and it is the number the owner quotes most often.
  const rankableMetrics = metrics.filter(isRankable)
  const teamAverage = rankableMetrics.length > 0
    ? Math.round(rankableMetrics.reduce((s, m) => s + m.score!, 0) / rankableMetrics.length)
    : null
  const prevComparable = metrics.filter(
    m => m.prevScore !== null && m.prevScoredDays >= MIN_SCORED_DAYS_FOR_RANKING
  )
  const prevTeamAverage = prevComparable.length > 0
    ? Math.round(prevComparable.reduce((s, m) => s + m.prevScore!, 0) / prevComparable.length)
    : null

  const totalEodExpected = metrics.reduce((s, m) => s + m.eodOnTime + m.eodLate + m.eodMissed, 0)
  const totalEodOnTime   = metrics.reduce((s, m) => s + m.eodOnTime, 0)
  const totalDated       = metrics.reduce((s, m) => s + m.tasksWithDueDate, 0)
  const totalOnTime      = metrics.reduce((s, m) => s + m.tasksCompletedOnTime, 0)

  // ── Performance Coverage ───────────────────────────────────────────────────
  const holidayCoverage = holidayCalendarCoverage(period.from, period.to, [...holidaySet])
  const unranked = unrankedPool(metrics)
  const coverage: CoverageSummary = {
    trackedCount:      metrics.length,
    excludedCount:     excluded.length,
    sufficientCount:   rankableMetrics.length,
    insufficientCount: unranked.length,
    insufficient: unranked.map(u => ({
      userId: u.member.userId, userName: u.member.userName, reason: u.reason,
    })),
    maxEligibleDays: metrics.reduce((max, m) => Math.max(max, m.eligibleDays), 0),
    holidayCoverage,
    confidence: calendarConfidence(holidayCoverage),
    // Admin only. A manager gets the count but not the reasons.
    ...(showExcludedDetails ? { excluded } : {}),
    attendanceNote: ATTENDANCE_LIMITATION_NOTE,
  }

  // ── System Adoption ────────────────────────────────────────────────────────
  const measured = metrics.filter(m => hasAdoptionData(m.adoption))
  const totalOpens = measured.reduce((s, m) => s + m.adoption.openedDays, 0)
  const openMinuteTotal = measured.reduce(
    (s, m) => s + (m.adoption.avgFirstOpenMinutes ?? 0) * m.adoption.openedDays, 0)
  const adoptionSummary: AdoptionSummary = {
    measuredEmployees: measured.length,
    openedEmployees:   measured.filter(m => m.adoption.openedDays > 0).length,
    totalOpens,
    totalWithinWindow: measured.reduce((s, m) => s + m.adoption.withinWindowDays, 0),
    totalLate:         measured.reduce((s, m) => s + m.adoption.lateDays, 0),
    totalMissing:      measured.reduce((s, m) => s + (m.adoption.missingDays - m.adoption.unrecordedDays), 0),
    avgFirstOpenMinutes: totalOpens > 0 ? Math.round(openMinuteTotal / totalOpens) : null,
    recordingFrom: openRecordingFrom,
    // The honest state until the event has been collecting for a while: there is
    // nothing to show, and the section says so rather than reporting 0%.
    noDataYet: !adoptionAvailable || measured.length === 0,
    anyProvisionalWindow: metrics.some(m => m.adoption.window.provisional),
  }

  const explain = (m: MemberMetrics | null): RankExplanation | null => {
    if (m === null) return null
    return explanations[m.userId] ?? null
  }

  return NextResponse.json({
    period,
    generatedAt: now.toISOString(),
    coverage,
    adoptionSummary,
    ranks,
    explanations,
    teamSummary: {
      employeeCount: metrics.length,
      teamAverage,
      prevTeamAverage,
      teamAverageDelta: teamAverage !== null && prevTeamAverage !== null ? teamAverage - prevTeamAverage : null,
      best:     summarise(best,     m => `${m.score}/100 · ${labelRate(onTimeCompletionRate(m))} on time`, explain(best)),
      weakest:  summarise(weakest,  m => `${m.score}/100 · rank ${ranks[m.userId]} of ${ordered.length}`, explain(weakest)),
      improved: summarise(improved, m => `${plus(scoreDelta(m))} points versus last period`, improved ? movementExplanation(improved) : null),
      declined: summarise(declined, m => `${scoreDelta(m)} points versus last period`, declined ? movementExplanation(declined) : null),
      eodOnTimeRate: totalEodExpected > 0 ? Math.round(totalEodOnTime / totalEodExpected * 100) : null,
      eodLate:       metrics.reduce((s, m) => s + m.eodLate, 0),
      eodMissed:     metrics.reduce((s, m) => s + m.eodMissed, 0),
      onTimeCompletionRate: totalDated > 0 ? Math.round(totalOnTime / totalDated * 100) : null,
      lateCompletions:      metrics.reduce((s, m) => s + m.tasksCompletedLate, 0),
      totalCompleted:       metrics.reduce((s, m) => s + m.tasksCompleted, 0),
      totalOverdue:         metrics.reduce((s, m) => s + m.overdueCount, 0),
    },
    activitySummary: {
      activeInPeriod: metrics.filter(m => m.eligibleDays > 0 && m.activeDays > 0).length,
      fullyActive:  metrics.filter(m => m.eligibleDays > 0 && m.activeDays === m.eligibleDays).length,
      lowActivity:  metrics.filter(m => classifications[m.userId].status === 'low_activity').length,
      noCompletions: metrics.filter(m => m.tasksCompleted === 0 && m.eligibleDays > 0).length,
      noCreations:   metrics.filter(m => m.tasksCreatedSelf + m.tasksCreatedDelegated === 0 && m.eligibleDays > 0).length,
      eodOnly:       metrics.filter(m => m.eodOnlyDays > 0).length,
    },
    metrics,
    classifications,
    attention: buildAttentionItems(metrics),
    positives: buildPositiveItems(metrics),
    rankings:  RANKING_KEYS.map(k => buildRanking(metrics, k)),
    evidence:  Object.fromEntries(evidence),
    members:   legacy,
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const row of rows) {
    const k = key(row)
    const arr = out.get(k)
    if (arr) arr.push(row)
    else out.set(k, [row])
  }
  return out
}

function summarise(
  m: MemberMetrics | null,
  detail: (m: MemberMetrics) => string,
  explanation: RankExplanation | null,
): { userId: string; userName: string; score: number | null; detail: string; explanation: RankExplanation | null } | null {
  return m === null
    ? null
    : { userId: m.userId, userName: m.userName, score: m.score, detail: detail(m), explanation }
}

function labelRate(rate: number | null): string {
  return rate === null ? 'no dated tasks' : `${rate}%`
}

function plus(n: number | null): string {
  return n === null ? '—' : `${n > 0 ? '+' : ''}${n}`
}

/**
 * Nobody to measure. Reached when every active employee is excluded from
 * Performance tracking, as well as when the team is genuinely empty — so the
 * coverage block still carries the exclusion count, otherwise the page would show
 * "no employees" while nine accounts sat quietly held out of view.
 */
function emptyResponse(
  period: ResolvedPeriod,
  excluded: ExcludedUser[],
  showExcludedDetails: boolean,
) {
  const holidayCoverage = holidayCalendarCoverage(period.from, period.to, [])
  return {
    period,
    generatedAt: new Date().toISOString(),
    coverage: {
      trackedCount: 0,
      excludedCount: excluded.length,
      sufficientCount: 0,
      insufficientCount: 0,
      insufficient: [],
      maxEligibleDays: 0,
      holidayCoverage,
      confidence: calendarConfidence(holidayCoverage),
      ...(showExcludedDetails ? { excluded } : {}),
      attendanceNote: ATTENDANCE_LIMITATION_NOTE,
    },
    adoptionSummary: {
      measuredEmployees: 0, openedEmployees: 0, totalOpens: 0,
      totalWithinWindow: 0, totalLate: 0, totalMissing: 0,
      avgFirstOpenMinutes: null, recordingFrom: null,
      noDataYet: true, anyProvisionalWindow: false,
    },
    ranks: {}, explanations: {},
    teamSummary: {
      employeeCount: 0, teamAverage: null, prevTeamAverage: null, teamAverageDelta: null,
      best: null, weakest: null, improved: null, declined: null,
      eodOnTimeRate: null, eodLate: 0, eodMissed: 0,
      onTimeCompletionRate: null, lateCompletions: 0, totalCompleted: 0, totalOverdue: 0,
    },
    activitySummary: { activeInPeriod: 0, fullyActive: 0, lowActivity: 0, noCompletions: 0, noCreations: 0, eodOnly: 0 },
    metrics: [], classifications: {}, attention: [], positives: [],
    rankings: [], evidence: {}, members: [],
  }
}
