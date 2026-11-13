// THE BOE SCOREBOARD: reading the facts and working out everybody's score (owner, 2026-11-12). Service role,
// server only. The rules are in ./score.ts; this file only gathers what they need, in a fixed number of batched
// reads for the whole team (never one read per person), paged where a month can pass 1,000 rows.
//
// Who is scored: active people with performance_tracking_enabled (the existing measured-population flag,
// module 13), never an administrator.

import type { Caller, ServiceClient } from '@/lib/security/attendancePayrollApiAuth'
import { fetchAllRows, unwrapPagedRows } from '@/lib/supabasePaging'
import { istAddDays, istDayEndUtc, istDayStartUtc, istToday } from '@/lib/istDate'
import { buildMachineDay, machineDateOf, MACHINE_ATTENDANCE_FROM } from '@/lib/minop/machineDay'
import { isPlausiblePunchTime } from '@/lib/minop/punches'
import { fetchActiveSettings } from '@/lib/payroll/settingsStore'
import { readSettings as readDayCloseSettings } from '@/lib/dayClose/server'
import { dayCloseSince } from '@/lib/dayClose/rules'
import { monthMessages } from './reviewServer'
import {
  closesAt, lastDayOf, ratingWindow, validateRating, validateVotes, voteWindow,
} from './vote'
import {
  BAND_LABEL, computeScore, fastestTip, pillarTotals,
  type Band, type ScoreFacts, type ScoreResult, type ScoreTask, type Track,
} from './score'

export type Result = { status: number; body: Record<string, unknown> }
const ok = (body: Record<string, unknown>, status = 200): Result => ({ status, body })
const fail = (status: number, error: string): Result => ({ status, body: { error } })

const CHUNK = 150
const chunks = <T,>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK))
const monthStartOf = (date: string) => `${date.slice(0, 7)}-01`
function monthEndOf(date: string): string {
  const [y, m] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}
function datesBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to; d = istAddDays(d, 1)) out.push(d)
  return out
}
const isSunday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() === 0

type Person = {
  id: string
  full_name: string | null
  role: string | null
  joining_date: string | null
  minop_user_id: string | null
}

export type PersonScore = { id: string; name: string; track: Track; result: ScoreResult }

export async function scoredPeople(svc: ServiceClient): Promise<Person[]> {
  const { data, error } = await svc.from('users')
    .select('id, full_name, role, joining_date, minop_user_id, is_active, is_deleted, performance_tracking_enabled')
    .eq('is_active', true)
  if (error) throw new Error(error.message)
  return ((data ?? []) as (Person & { is_deleted: boolean | null; performance_tracking_enabled: boolean | null })[])
    .filter(u => !u.is_deleted && u.performance_tracking_enabled !== false && u.role !== 'admin')
}

/**
 * Everybody's month-to-date score as of `date` (IST). `dayComplete` is true for the nightly record, false for
 * the live score during the day. Every fact is read as it stood by the end of `date`.
 */
export async function scoreEveryone(svc: ServiceClient, date: string, dayComplete: boolean): Promise<PersonScore[]> {
  const people = await scoredPeople(svc)
  if (people.length === 0) return []
  const ids = people.map(p => p.id)
  const month = monthStartOf(date)
  const monthEnd = monthEndOf(date)
  // The team switch (20270704000000): while it is off nobody is judged on Day Close; once on, days count from the day it was turned on.
  const dayCloseSettings = await readDayCloseSettings(svc)
  const fromUtc = istDayStartUtc(month)
  const toUtc = istDayEndUtc(date)
  const minopIds = people.map(p => p.minop_user_id).filter((v): v is string => !!v)

  // The vote counts only in the month's final record (its last day, once over); ratings count once given.
  const voteClosed = date === lastDayOf(month) && dayComplete
  const [targetsR, holidaysR, settings, requestsR, membersR, strikesR, salesR, leadsR, visitsR, votesR, ratingsR] = await Promise.all([
    svc.from('scoreboard_targets').select('employee_id, track, sales_target, role_target, role_kind, role_label').eq('month', month).in('employee_id', ids),
    svc.from('payroll_holidays').select('holiday_date').gte('holiday_date', month).lte('holiday_date', monthEnd),
    fetchActiveSettings(svc),
    svc.from('attendance_requests').select('employee_id, request_type, start_date, end_date, status, informed_before_shift')
      .in('employee_id', ids).lte('start_date', date).gte('end_date', month).neq('status', 'cancelled'),
    svc.from('day_close_members').select('employee_id, active, added_at').in('employee_id', ids),
    svc.from('day_strikes').select('employee_id, work_date, kind, status').in('employee_id', ids).gte('work_date', month).lte('work_date', date).neq('status', 'waived'),
    svc.from('order_submissions').select('salesperson_id, total_before_gst, approved_at')
      .in('salesperson_id', ids).eq('status', 'approved').gte('approved_at', fromUtc).lte('approved_at', toUtc),
    svc.from('sales_leads').select('assigned_to, assigned_at, first_attempt_at').in('assigned_to', ids).gte('assigned_at', fromUtc).lte('assigned_at', toUtc),
    svc.from('vendor_visits').select('visited_by, visited_at, kind').in('visited_by', ids).gte('visited_at', fromUtc).lte('visited_at', toUtc),
    voteClosed ? svc.from('scoreboard_votes').select('voter_id, nominee_id').eq('month', month) : Promise.resolve({ data: null, error: null }),
    svc.from('scoreboard_ratings').select('employee_id, rating, reason, rated_at').eq('month', month).lte('rated_at', toUtc),
  ])
  for (const r of [targetsR, holidaysR, requestsR, membersR, strikesR, votesR, ratingsR]) if (r.error) throw new Error(r.error.message)
  const votes = voteClosed ? (votesR.data ?? []) as { voter_id: string; nominee_id: string }[] : null
  const ratings = new Map(((ratingsR.data ?? []) as { employee_id: string; rating: number; reason: string }[]).map(r => [r.employee_id, r]))
  // Sales, leads and vendor visits belong to other modules: if one cannot be read, that part is left out
  // rather than scored as zero.
  const salesRows = salesR.error ? null : (salesR.data ?? []) as { salesperson_id: string; total_before_gst: number | null }[]
  const leadRows = leadsR.error ? null : (leadsR.data ?? []) as { assigned_to: string; assigned_at: string; first_attempt_at: string | null }[]
  const visitRows = visitsR.error ? [] : (visitsR.data ?? []) as { visited_by: string; kind: string }[]

  const punches = minopIds.length ? unwrapPagedRows('scoreboard punches', await fetchAllRows<{ id: string; minop_user_id: string; punch_at: string; punch_local: string; first_seen_at: string }>(
    (a, b) => svc.from('minop_punches').select('id, minop_user_id, punch_at, punch_local, first_seen_at')
      .in('minop_user_id', minopIds).gte('punch_at', fromUtc).lte('punch_at', toUtc).order('id').range(a, b),
  )) : []

  const tasks = unwrapPagedRows('scoreboard tasks', await fetchAllRows<{ id: string; assigned_to: string; priority: string | null; due_date: string | null; status: string }>(
    (a, b) => svc.from('tasks').select('id, assigned_to, priority, due_date, status')
      .in('assigned_to', ids).neq('status', 'cancelled')
      // Due this month, or handed in recently (a role target counts tasks finished this month whatever their due date).
      .or(`and(due_date.gte.${month},due_date.lte.${date}),and(status.in.(pending_approval,completed),last_update_at.gte."${fromUtc}")`)
      .order('id').range(a, b),
  ))
  // When each task was first handed in (submitted or completed), up to the end of the scored day.
  const handedIn = new Map<string, string>()
  for (const part of chunks(tasks.map(t => t.id))) {
    const rows = unwrapPagedRows('scoreboard task history', await fetchAllRows<{ id: string; task_id: string; created_at: string }>(
      (a, b) => svc.from('task_activity_log').select('id, task_id, created_at')
        .in('task_id', part).eq('action', 'status_changed').in('to_status', ['pending_approval', 'completed'])
        .lte('created_at', toUtc).order('id').range(a, b),
    ))
    for (const r of rows) {
      const prev = handedIn.get(r.task_id)
      if (!prev || r.created_at < prev) handedIn.set(r.task_id, r.created_at)
    }
  }

  // ── Shared facts ──
  const holidays = new Set(((holidaysR.data ?? []) as { holiday_date: string }[]).map(h => h.holiday_date))
  const monthWorking = datesBetween(month, monthEnd).filter(d => !isSunday(d) && !holidays.has(d))
  const graceEnd = settings.settings.grace_end_minutes

  const arrivalsByMinop = new Map<string, Map<string, number | null>>()
  const byPersonDay = new Map<string, typeof punches>()
  for (const p of punches) {
    if (!isPlausiblePunchTime(p.punch_at, p.first_seen_at)) continue
    const key = `${p.minop_user_id}|${machineDateOf(p.punch_local)}`
    byPersonDay.set(key, [...(byPersonDay.get(key) ?? []), p])
  }
  for (const [key, list] of byPersonDay) {
    const [mid, day] = key.split('|')
    if (day > date || day < month) continue
    const row = buildMachineDay(list)
    const inAt = row?.check_in_at ?? null
    const minutes = inAt ? (() => { const d = new Date(Date.parse(inAt) + 330 * 60_000); return d.getUTCHours() * 60 + d.getUTCMinutes() })() : null
    if (!arrivalsByMinop.has(mid)) arrivalsByMinop.set(mid, new Map())
    arrivalsByMinop.get(mid)!.set(day, minutes)
  }

  const targets = new Map(((targetsR.data ?? []) as { employee_id: string; track: Track; sales_target: number | null; role_target: number | null; role_kind: string | null; role_label: string | null }[]).map(t => [t.employee_id, t]))
  const requests = (requestsR.data ?? []) as { employee_id: string; request_type: string; start_date: string; end_date: string; status: string; informed_before_shift: boolean }[]
  const members = new Map(((membersR.data ?? []) as { employee_id: string; active: boolean; added_at: string }[]).map(m => [m.employee_id, m]))
  const strikes = (strikesR.data ?? []) as { employee_id: string; work_date: string; kind: string }[]

  return people.map(p => {
    const t = targets.get(p.id)
    const track: Track = t?.track === 'sales' ? 'sales' : 'general'
    const firstDay = [month, p.joining_date ?? month, MACHINE_ATTENDANCE_FROM].sort().at(-1) as string
    const workingDates = monthWorking.filter(d => d >= firstDay && d <= date)

    const leaveDates = new Set<string>()
    for (const r of requests) {
      if (r.employee_id !== p.id || r.status !== 'approved' || r.request_type !== 'full_day_leave') continue
      for (const d of datesBetween(r.start_date > month ? r.start_date : month, r.end_date < date ? r.end_date : date)) leaveDates.add(d)
    }

    const myTasks: ScoreTask[] = tasks
      .filter(x => x.assigned_to === p.id && x.due_date && x.due_date >= month && x.due_date <= date)
      .map(x => ({ priority: x.priority, due_date: x.due_date as string, handed_in_at: handedIn.get(x.id) ?? null }))

    let role: ScoreFacts['role'] = null
    if (t?.role_target && t.role_kind) {
      const actual = t.role_kind === 'vendor_visits'
        ? visitRows.filter(v => v.visited_by === p.id && v.kind === 'site_visit').length
        : tasks.filter(x => x.assigned_to === p.id && (() => { const h = handedIn.get(x.id); return !!h && h >= istDayStartUtc(month) })()).length
      role = { target: t.role_target, actual, label: t.role_label ?? (t.role_kind === 'vendor_visits' ? 'vendor visits' : 'tasks finished') }
    }

    const member = members.get(p.id)
    const since = member
      ? dayCloseSince({ active: member.active, addedAt: member.added_at, month, teamLive: dayCloseSettings.team_live, liveSince: dayCloseSettings.live_since })
      : null
    const mine = strikes.filter(s => s.employee_id === p.id)

    const facts: ScoreFacts = {
      track,
      date,
      dayComplete,
      workingDates,
      monthWorkingDates: monthWorking.filter(d => d >= firstDay),
      leaveDates,
      arrivals: (p.minop_user_id && arrivalsByMinop.get(p.minop_user_id)) || new Map(),
      graceEndMinutes: graceEnd,
      tasks: myTasks,
      role,
      sales: track === 'sales' && t?.sales_target && salesRows
        ? { target: Number(t.sales_target), value: salesRows.filter(s => s.salesperson_id === p.id).reduce((sum, s) => sum + Number(s.total_before_gst ?? 0), 0) }
        : null,
      leads: track === 'sales' && leadRows ? leadRows.filter(l => l.assigned_to === p.id) : [],
      dayClose: {
        since,
        planStrikeDates: new Set(mine.filter(s => s.kind === 'no_plan' || s.kind === 'plan_late').map(s => s.work_date)),
        closeStrikeDates: new Set(mine.filter(s => s.kind === 'day_not_closed' || s.kind === 'closed_after_leaving').map(s => s.work_date)),
      },
      requestsInformed: requests.filter(r => r.employee_id === p.id && r.start_date >= month && r.start_date <= date).map(r => !!r.informed_before_shift),
      years: p.joining_date ? Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${p.joining_date}T00:00:00Z`)) / (365.25 * 86_400_000)) : null,
      vote: votes ? { received: votes.filter(v => v.nominee_id === p.id).length, voted: votes.some(v => v.voter_id === p.id) } : null,
      rating: ratings.has(p.id) ? { value: ratings.get(p.id)!.rating, reason: ratings.get(p.id)!.reason } : null,
    }
    return { id: p.id, name: p.full_name ?? 'Unknown', track, result: computeScore(facts) }
  })
}

// ─── The nightly record ──────────────────────────────────────────────────────

/** Writes the day's scores once. A day already written is left exactly as it was (the table refuses changes). */
export async function snapshotDay(svc: ServiceClient, date: string): Promise<{ date: string; written: number }> {
  // Paused (20270704000000): no record is written. The days can be filled in later with ?from=&to= once it is live.
  if (!(await readDayCloseSettings(svc)).team_live) return { date, written: 0 }
  const scores = await scoreEveryone(svc, date, true)
  if (scores.length === 0) return { date, written: 0 }
  const rows = scores.map(s => ({
    employee_id: s.id, score_date: date, month: monthStartOf(date), track: s.track,
    score: s.result.score, earned: s.result.earned, possible: s.result.possible, parts: s.result.parts,
  }))
  const { data, error } = await svc.from('scoreboard_daily')
    .upsert(rows, { onConflict: 'employee_id,score_date', ignoreDuplicates: true }).select('employee_id')
  if (error) throw new Error(error.message)
  return { date, written: (data ?? []).length }
}

// ─── What a person sees: the morning card, and the evening line after Close my day ───

export async function loadMyScore(caller: Caller, now: Date = new Date()): Promise<Result> {
  const svc = caller.svc
  const today = istToday(now)
  const month = monthStartOf(today)
  // Paused (20270704000000): the card draws nothing, and nothing is worked out. An unreadable switch throws: the card stays hidden.
  if (!(await readDayCloseSettings(svc)).team_live) return ok({ today, month, scored: false, top5: [], mostImproved: null, paused: true })
  const everyone = await scoreEveryone(svc, today, false)
  const me = everyone.find(s => s.id === caller.id) ?? null

  const history = await svc.from('scoreboard_daily').select('employee_id, score_date, score')
    .eq('month', month).lt('score_date', today).order('score_date', { ascending: true })
  if (history.error) throw new Error(history.error.message)
  const rows = (history.data ?? []) as { employee_id: string; score_date: string; score: number | null }[]

  // The top 5 by today's score (only names, never anybody's rank). Ties: alphabetical.
  const ranked = everyone.filter(s => s.result.score !== null)
    .sort((a, b) => (b.result.score as number) - (a.result.score as number) || a.name.localeCompare(b.name))
  const top5 = ranked.slice(0, 5).map(s => ({ name: s.name, score: s.result.score, band: s.result.band, bandLabel: BAND_LABEL[s.result.band as Band] }))

  // Most improved: the biggest rise since the first recorded day of the month (at least 3 days in).
  const firstByPerson = new Map<string, number>()
  for (const r of rows) if (r.score !== null && !firstByPerson.has(r.employee_id)) firstByPerson.set(r.employee_id, r.score)
  const days = new Set(rows.map(r => r.score_date)).size
  const improved = days >= 3
    ? ranked.map(s => ({ name: s.name, rise: (s.result.score as number) - (firstByPerson.get(s.id) ?? (s.result.score as number)) }))
        .filter(x => x.rise > 0).sort((a, b) => b.rise - a.rise)[0] ?? null
    : null

  // Last month's champions (once announced) and the person's own private goals. Never a failure of the card.
  const messages = await monthMessages(svc, caller.id, today).catch(() => ({ champions: null, championsMonth: null, myGoals: null }))

  if (!me) return ok({ today, month, scored: false, top5, mostImproved: improved, ...messages })

  const mine = rows.filter(r => r.employee_id === caller.id)
  const yesterday = mine.at(-1)?.score ?? null
  return ok({
    today,
    month,
    scored: true,
    track: me.track,
    score: me.result.score,
    band: me.result.band,
    bandLabel: me.result.band ? BAND_LABEL[me.result.band] : null,
    change: me.result.score !== null && yesterday !== null ? me.result.score - yesterday : null,
    trend: [...mine.map(r => r.score), me.result.score],
    pillars: pillarTotals(me.result.parts),
    parts: me.result.parts,
    tip: fastestTip(me.result.parts),
    top5,
    mostImproved: improved,
    ...messages,
  })
}

// ─── The owner's monthly settings: tracks and targets ────────────────────────

const MONTH_RE = /^\d{4}-\d{2}-01$/

export async function loadTargets(caller: Caller, monthParam: string | null, now: Date = new Date()): Promise<Result> {
  if (!caller.isAdmin) return fail(403, 'Forbidden')
  const month = monthParam && MONTH_RE.test(monthParam) ? monthParam : monthStartOf(istToday(now))
  const people = await scoredPeople(caller.svc)
  const { data, error } = await caller.svc.from('scoreboard_targets').select('employee_id, track, sales_target, role_target, role_kind, role_label').eq('month', month)
  if (error) throw new Error(error.message)
  const byId = new Map(((data ?? []) as { employee_id: string }[]).map(t => [t.employee_id, t]))
  return ok({
    month,
    people: people.map(p => ({ id: p.id, name: p.full_name ?? 'Unknown', target: byId.get(p.id) ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  })
}

export async function saveTarget(caller: Caller, body: Record<string, unknown>, now: Date = new Date()): Promise<Result> {
  if (!caller.isAdmin) return fail(403, 'Forbidden')
  const month = typeof body.month === 'string' && MONTH_RE.test(body.month) ? body.month : monthStartOf(istToday(now))
  const id = typeof body.employee_id === 'string' ? body.employee_id : ''
  const track = body.track === 'sales' ? 'sales' : 'general'
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v))
  const salesTarget = num(body.sales_target)
  const roleTarget = num(body.role_target)
  const roleKind = body.role_kind === 'vendor_visits' ? 'vendor_visits' : body.role_kind === 'tasks_done' ? 'tasks_done' : null
  const roleLabel = typeof body.role_label === 'string' && body.role_label.trim().length >= 2 ? body.role_label.trim().slice(0, 80) : null
  if (salesTarget !== null && !(Number.isFinite(salesTarget) && salesTarget > 0)) return fail(400, 'The sales target must be a positive amount.')
  if (roleTarget !== null && !(Number.isInteger(roleTarget) && roleTarget >= 1 && roleTarget <= 10000)) return fail(400, 'The role target must be a whole number from 1.')
  if ((roleTarget === null) !== (roleKind === null)) return fail(400, 'Give the role target a number and what counts, or neither.')
  const people = await scoredPeople(caller.svc)
  if (!people.some(p => p.id === id)) return fail(404, 'Person not found.')
  const { error } = await caller.svc.from('scoreboard_targets').upsert({
    month, employee_id: id, track,
    sales_target: track === 'sales' ? salesTarget : null,
    role_target: track === 'general' ? roleTarget : null,
    role_kind: track === 'general' ? roleKind : null,
    role_label: track === 'general' ? roleLabel : null,
    updated_by: caller.id, updated_at: now.toISOString(),
  }, { onConflict: 'month,employee_id' })
  if (error) throw new Error(error.message)
  return ok({ saved: true })
}

// ─── The monthly vote ────────────────────────────────────────────────────────
//
// SECRET: nothing here returns who voted for whom. A voter sees only their own three; the owner sees totals
// and the lines, never the voters.

export async function loadVote(caller: Caller, now: Date = new Date()): Promise<Result> {
  const w = voteWindow(now)
  // Paused (20270704000000): no vote card, because the vote feeds a score nobody has been shown yet.
  if (!(await readDayCloseSettings(caller.svc)).team_live) return ok({ month: w.month, open: false, opensOn: w.opensOn, closesAt: w.closesAt, canVote: false })
  const people = await scoredPeople(caller.svc)
  const canVote = people.some(p => p.id === caller.id)
  const base = { month: w.month, open: w.open, opensOn: w.opensOn, closesAt: w.closesAt, canVote }
  if (!canVote) return ok(base)
  const mine = await caller.svc.from('scoreboard_votes').select('nominee_id').eq('month', w.month).eq('voter_id', caller.id)
  if (mine.error) throw new Error(mine.error.message)
  return ok({
    ...base,
    voted: (mine.data ?? []).length > 0,
    myVotes: (mine.data ?? []).map(v => String(v.nominee_id)),
    candidates: w.open
      ? people.filter(p => p.id !== caller.id).map(p => ({ id: p.id, name: p.full_name ?? 'Unknown' })).sort((a, b) => a.name.localeCompare(b.name))
      : [],
  })
}

export async function castVote(caller: Caller, body: Record<string, unknown>, now: Date = new Date()): Promise<Result> {
  const w = voteWindow(now)
  if (!(await readDayCloseSettings(caller.svc)).team_live) return fail(409, 'The Scoreboard has not been switched on yet.')
  if (!w.open) return fail(409, w.closed ? 'This month’s vote has closed.' : `The vote opens on ${w.opensOn}.`)
  const people = await scoredPeople(caller.svc)
  if (!people.some(p => p.id === caller.id)) return fail(403, 'Only people on the Scoreboard vote.')
  const v = validateVotes(body, caller.id, new Set(people.map(p => p.id)))
  if (!v.ok) return fail(400, v.error)
  const existing = await caller.svc.from('scoreboard_votes').select('nominee_id').eq('month', w.month).eq('voter_id', caller.id)
  if (existing.error) throw new Error(existing.error.message)
  if ((existing.data ?? []).length > 0) return fail(409, 'You have already voted this month.')
  const { error } = await caller.svc.from('scoreboard_votes')
    .insert(v.value.map(x => ({ month: w.month, voter_id: caller.id, nominee_id: x.nominee_id, note: x.note })))
  if (error) {
    if (error.code === '23505' || /SCOREBOARD_VOTE_LIMIT/.test(error.message)) return fail(409, 'You have already voted this month.')
    throw new Error(error.message)
  }
  return ok({ voted: true }, 201)
}

// ─── The owner's rating (the Day Close reviewer seat: the owner alone) ───────

export async function isReviewer(caller: Caller): Promise<boolean> {
  const { data, error } = await caller.svc.from('day_close_settings').select('reviewer_id').eq('singleton', true).maybeSingle()
  if (error) throw new Error(error.message)
  return !!data?.reviewer_id && data.reviewer_id === caller.id
}

export async function loadRatings(caller: Caller, now: Date = new Date()): Promise<Result> {
  if (!(await isReviewer(caller))) return fail(403, 'Only the owner rates.')
  const w = ratingWindow(now)
  const people = await scoredPeople(caller.svc)
  const [ratings, votes] = await Promise.all([
    caller.svc.from('scoreboard_ratings').select('employee_id, rating, reason').eq('month', w.month),
    caller.svc.from('scoreboard_votes').select('nominee_id, note').eq('month', w.month),
  ])
  if (ratings.error) throw new Error(ratings.error.message)
  if (votes.error) throw new Error(votes.error.message)
  const byId = new Map(((ratings.data ?? []) as { employee_id: string; rating: number; reason: string }[]).map(r => [r.employee_id, r]))
  const voteRows = (votes.data ?? []) as { nominee_id: string; note: string | null }[]
  // Totals and lines only once the vote has closed, so the count cannot steer anybody while it is open.
  const show = w.closed || now.toISOString() >= closesAt(w.month)
  return ok({
    month: w.month, open: w.open, opensOn: w.opensOn, closesAt: w.closesAt, votesShown: show,
    people: people.map(p => ({
      id: p.id,
      name: p.full_name ?? 'Unknown',
      rating: byId.get(p.id) ?? null,
      votes: show ? voteRows.filter(v => v.nominee_id === p.id).length : null,
      lines: show ? voteRows.filter(v => v.nominee_id === p.id && v.note).map(v => v.note as string) : [],
    })).sort((a, b) => a.name.localeCompare(b.name)),
  })
}

export async function saveRating(caller: Caller, body: Record<string, unknown>, now: Date = new Date()): Promise<Result> {
  if (!(await isReviewer(caller))) return fail(403, 'Only the owner rates.')
  const w = ratingWindow(now)
  if (!w.open) return fail(409, w.closed ? 'This month is closed.' : `Ratings open on ${w.opensOn}.`)
  const v = validateRating(body)
  if (!v.ok) return fail(400, v.error)
  const id = typeof body.employee_id === 'string' ? body.employee_id : ''
  const people = await scoredPeople(caller.svc)
  if (!people.some(p => p.id === id)) return fail(404, 'Person not found.')
  const { error } = await caller.svc.from('scoreboard_ratings').upsert({
    month: w.month, employee_id: id, rating: v.value.rating, reason: v.value.reason, rated_by: caller.id, rated_at: now.toISOString(),
  }, { onConflict: 'month,employee_id' })
  if (error) throw new Error(error.message)
  return ok({ saved: true })
}
