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

async function scoredPeople(svc: ServiceClient): Promise<Person[]> {
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
  const fromUtc = istDayStartUtc(month)
  const toUtc = istDayEndUtc(date)
  const minopIds = people.map(p => p.minop_user_id).filter((v): v is string => !!v)

  const [targetsR, holidaysR, settings, requestsR, membersR, strikesR, salesR, leadsR, visitsR] = await Promise.all([
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
  ])
  for (const r of [targetsR, holidaysR, requestsR, membersR, strikesR]) if (r.error) throw new Error(r.error.message)
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
    const since = member?.active ? ([member.added_at.slice(0, 10), month].sort().at(-1) as string) : null
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
    }
    return { id: p.id, name: p.full_name ?? 'Unknown', track, result: computeScore(facts) }
  })
}

// ─── The nightly record ──────────────────────────────────────────────────────

/** Writes the day's scores once. A day already written is left exactly as it was (the table refuses changes). */
export async function snapshotDay(svc: ServiceClient, date: string): Promise<{ date: string; written: number }> {
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

  if (!me) return ok({ today, month, scored: false, top5, mostImproved: improved })

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
