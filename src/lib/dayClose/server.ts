// DAY CLOSE: every read and write, on the service role (owner, 2026-11-12). The rules are in ./rules.ts.
//
// THE ROUTE IS THE BOUNDARY. The tables are closed to the browser (20270622000000), so these functions
// are the only door. The actor always comes from the bearer token (`Caller`), never from the request:
//
//   a member        their own day only; there is no person id in any body or query string
//   an admin        Team Today (read) and who takes part
//   the reviewer    the one person in day_close_settings.reviewer_id (the owner): Team Today, strike
//                   decisions, and approving leave while work is pending
//
// Server-side only: it holds the service role.

import type { Caller, ServiceClient } from '@/lib/security/attendancePayrollApiAuth'
import { istAddDays, istDayEndUtc, istDayStartUtc, istToday } from '@/lib/istDate'
import { buildMachineDay, machineDateOf } from '@/lib/minop/machineDay'
import { isPlausiblePunchTime } from '@/lib/minop/punches'
import {
  CLOSE_OPENS_MINUTES, PLAN_DUE_MINUTES, STRIKE_LABEL, UNCLOSED_LOOKBACK_DAYS,
  countDay, dayPrompt, dayTaskList, dayTaskState, hasPendingWork, isLockedLeaveType, isSunday, isTaskDueForPlan,
  isTaskOverdue, judgeDay, pendingWorkWords, validateCarryover, validateSummary,
  type Carryover, type DayTask, type PendingWork, type Plan, type StrikeKind, type StrikeStatus,
} from './rules'

export type Result = { status: number; body: Record<string, unknown> }
const ok = (body: Record<string, unknown>, status = 200): Result => ({ status, body })
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Result => ({ status, body: { error, ...extra } })

const PLAN_COLUMNS = 'id, employee_id, work_date, submitted_at, closed_at, close_note, planned_task_ids'
const TASK_COLUMNS = 'id, title, status, priority, due_date, assigned_to, created_by'

// ─── Settings, roles, membership ─────────────────────────────────────────────

export type DayCloseSettings = {
  reviewer_id: string | null
  plan_due_minutes: number
  close_opens_minutes: number
}

export async function readSettings(svc: ServiceClient): Promise<DayCloseSettings> {
  const { data, error } = await svc.from('day_close_settings')
    .select('reviewer_id, plan_due_minutes, close_opens_minutes').eq('singleton', true).maybeSingle()
  if (error) throw new Error(error.message)
  return {
    reviewer_id: (data?.reviewer_id as string | null) ?? null,
    plan_due_minutes: (data?.plan_due_minutes as number | undefined) ?? PLAN_DUE_MINUTES,
    close_opens_minutes: (data?.close_opens_minutes as number | undefined) ?? CLOSE_OPENS_MINUTES,
  }
}

export type Viewer = { isMember: boolean; isReviewer: boolean; seesTeam: boolean; manages: boolean }

export async function viewerOf(caller: Caller, settings: DayCloseSettings): Promise<Viewer> {
  const { data, error } = await caller.svc.from('day_close_members')
    .select('active').eq('employee_id', caller.id).maybeSingle()
  if (error) throw new Error(error.message)
  const isReviewer = !!settings.reviewer_id && settings.reviewer_id === caller.id
  return {
    isMember: !!data?.active,
    isReviewer,
    seesTeam: caller.isAdmin || isReviewer,
    manages: caller.isAdmin || isReviewer,
  }
}

type Person = {
  id: string
  full_name: string | null
  minop_user_id: string | null
  is_active: boolean | null
  is_deleted: boolean | null
}

async function activeMembers(svc: ServiceClient): Promise<Person[]> {
  const { data, error } = await svc.from('day_close_members').select('employee_id').eq('active', true)
  if (error) throw new Error(error.message)
  const ids = (data ?? []).map(r => String(r.employee_id))
  if (ids.length === 0) return []
  const people = await svc.from('users')
    .select('id, full_name, minop_user_id, is_active, is_deleted').in('id', ids)
  if (people.error) throw new Error(people.error.message)
  return ((people.data ?? []) as Person[])
    .filter(p => p.is_active && !p.is_deleted)
    .sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? ''))
}

// ─── The day's facts: punches, holiday, leave ────────────────────────────────

type MachineTimes = { checkInAt: string | null; checkOutAt: string | null }
type PunchRow = { minop_user_id: string; punch_at: string; punch_local: string; first_seen_at: string }

async function machineTimes(svc: ServiceClient, minopIds: string[], date: string): Promise<Map<string, MachineTimes>> {
  const out = new Map<string, MachineTimes>()
  if (minopIds.length === 0) return out
  const { data, error } = await svc.from('minop_punches')
    .select('minop_user_id, punch_at, punch_local, first_seen_at')
    .in('minop_user_id', minopIds)
    .gte('punch_at', istDayStartUtc(date))
    .lte('punch_at', istDayEndUtc(date))
    .order('punch_at', { ascending: true })
  if (error) throw new Error(error.message)
  const byPerson = new Map<string, PunchRow[]>()
  for (const p of (data ?? []) as PunchRow[]) {
    if (machineDateOf(p.punch_local) !== date || !isPlausiblePunchTime(p.punch_at, p.first_seen_at)) continue
    const key = String(p.minop_user_id)
    byPerson.set(key, [...(byPerson.get(key) ?? []), p])
  }
  for (const [key, punches] of byPerson) {
    const day = buildMachineDay(punches)
    out.set(key, { checkInAt: day?.check_in_at ?? null, checkOutAt: day?.check_out_at ?? null })
  }
  return out
}

async function isHoliday(svc: ServiceClient, date: string): Promise<boolean> {
  const { data, error } = await svc.from('payroll_holidays').select('holiday_date').eq('holiday_date', date).limit(1)
  if (error) throw new Error(error.message)
  return (data ?? []).length > 0
}

/** People with an approved full-day leave covering the date. */
async function onFullDayLeave(svc: ServiceClient, ids: string[], date: string): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const { data, error } = await svc.from('attendance_requests')
    .select('employee_id')
    .in('employee_id', ids)
    .eq('status', 'approved')
    .eq('request_type', 'full_day_leave')
    .lte('start_date', date)
    .gte('end_date', date)
  if (error) throw new Error(error.message)
  return new Set((data ?? []).map(r => String(r.employee_id)))
}

// ─── One person's day ────────────────────────────────────────────────────────

async function readPlan(svc: ServiceClient, employeeId: string, date: string): Promise<Plan | null> {
  const { data, error } = await svc.from('day_plans').select(PLAN_COLUMNS)
    .eq('employee_id', employeeId).eq('work_date', date).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as Plan | null) ?? null
}

async function ensurePlan(svc: ServiceClient, employeeId: string, date: string): Promise<Plan> {
  const existing = await readPlan(svc, employeeId, date)
  if (existing) return existing
  const { error } = await svc.from('day_plans')
    .upsert({ employee_id: employeeId, work_date: date }, { onConflict: 'employee_id,work_date', ignoreDuplicates: true })
  if (error) throw new Error(error.message)
  const plan = await readPlan(svc, employeeId, date)
  if (!plan) throw new Error('The day plan could not be created.')
  return plan
}

/**
 * The tasks a day can hold for these people: open tasks due on or before the date, and the tasks a filed
 * plan named. Two reads; the list itself is decided by dayTaskList (rules.ts).
 */
async function tasksForDay(svc: ServiceClient, ids: string[], date: string, plannedIds: string[]): Promise<DayTask[]> {
  if (ids.length === 0) return []
  const due = await svc.from('tasks').select(TASK_COLUMNS)
    .in('assigned_to', ids).lte('due_date', date).not('status', 'in', '(completed,cancelled)')
  if (due.error) throw new Error(due.error.message)
  const rows = new Map(((due.data ?? []) as DayTask[]).map(t => [t.id, t]))
  const missing = plannedIds.filter(id => !rows.has(id))
  if (missing.length) {
    const planned = await svc.from('tasks').select(TASK_COLUMNS).in('id', missing)
    if (planned.error) throw new Error(planned.error.message)
    for (const t of (planned.data ?? []) as DayTask[]) rows.set(t.id, t)
  }
  return [...rows.values()]
}

async function readCarryovers(svc: ServiceClient, planIds: string[]): Promise<(Carryover & { plan_id: string })[]> {
  if (planIds.length === 0) return []
  const { data, error } = await svc.from('day_close_carryovers').select('plan_id, task_id, reason, next_date').in('plan_id', planIds)
  if (error) throw new Error(error.message)
  return (data ?? []) as (Carryover & { plan_id: string })[]
}

type DayView = {
  tasks: (DayTask & { state: string; self: boolean; carryover: Carryover | null })[]
  counts: ReturnType<typeof countDay>
}

function dayView(all: DayTask[], employeeId: string, date: string, plan: Plan | null, carry: Carryover[]): DayView {
  const list = dayTaskList(all.filter(t => t.assigned_to === employeeId), date, plan?.submitted_at ? plan.planned_task_ids ?? [] : null)
  const byTask = new Map(carry.map(c => [c.task_id, c]))
  const carried = new Set(byTask.keys())
  return {
    tasks: list.map(t => ({
      ...t, state: dayTaskState(t, carried), self: t.created_by === t.assigned_to, carryover: byTask.get(t.id) ?? null,
    })),
    counts: countDay(list, carried),
  }
}

export async function loadMyDay(caller: Caller, now: Date = new Date()): Promise<Result> {
  const svc = caller.svc
  const settings = await readSettings(svc)
  const viewer = await viewerOf(caller, settings)
  const today = istToday(now)
  const base = { today, planDue: settings.plan_due_minutes, closeOpens: settings.close_opens_minutes, viewer }
  if (!viewer.isMember) return ok({ ...base, member: false })

  const me = await svc.from('users').select('minop_user_id').eq('id', caller.id).maybeSingle()
  if (me.error) throw new Error(me.error.message)
  const minopId = (me.data?.minop_user_id as string | null) ?? null
  const [holiday, leave, times, plan] = await Promise.all([
    isHoliday(svc, today),
    onFullDayLeave(svc, [caller.id], today),
    minopId ? machineTimes(svc, [minopId], today) : Promise.resolve(new Map<string, MachineTimes>()),
    readPlan(svc, caller.id, today),
  ])
  const workingDay = !isSunday(today) && !holiday && !leave.has(caller.id)
  const punch = (minopId && times.get(minopId)) || { checkInAt: null, checkOutAt: null }
  const [all, carry] = await Promise.all([
    tasksForDay(svc, [caller.id], today, plan?.planned_task_ids ?? []),
    plan ? readCarryovers(svc, [plan.id]) : Promise.resolve([]),
  ])
  const view = dayView(all, caller.id, today, plan, carry)

  return ok({
    ...base,
    member: true,
    workingDay,
    plan,
    ...view,
    prompt: dayPrompt({
      now, date: today, workingDay, plan, openItems: view.counts.open, checkInAt: punch.checkInAt,
      planDueMinutes: settings.plan_due_minutes, closeOpensMinutes: settings.close_opens_minutes,
    }),
    punch,
  })
}

/** The strip on the Modules page: only what the person must do now. Silent for non-members. */
export async function loadMyPrompt(caller: Caller, now: Date = new Date()): Promise<Result> {
  const r = await loadMyDay(caller, now)
  if (r.status !== 200 || !r.body.member) return ok({ today: istToday(now), prompt: { kind: 'none' } })
  return ok({ today: r.body.today, prompt: r.body.prompt, counts: r.body.counts })
}

const isResult = (v: unknown): v is Result => !!v && typeof v === 'object' && 'status' in v && 'body' in v

async function memberPlanForToday(caller: Caller, now: Date): Promise<{ plan: Plan; today: string } | Result> {
  const settings = await readSettings(caller.svc)
  const viewer = await viewerOf(caller, settings)
  if (!viewer.isMember) return fail(403, 'Day Close is not switched on for you.')
  const today = istToday(now)
  const plan = await ensurePlan(caller.svc, caller.id, today)
  if (plan.closed_at) return fail(409, 'Your day is already closed.')
  return { plan, today }
}

/** Filing keeps the list of open tasks due today or before, as it is now. At least one is needed. */
export async function filePlan(caller: Caller, now: Date = new Date()): Promise<Result> {
  const ctx = await memberPlanForToday(caller, now)
  if (isResult(ctx)) return ctx
  if (ctx.plan.submitted_at) return ok({ filed: true, duplicate: true })
  const tasks = (await tasksForDay(caller.svc, [caller.id], ctx.today, []))
    .filter(t => t.assigned_to === caller.id && isTaskDueForPlan(t, ctx.today))
  if (tasks.length === 0) {
    return fail(400, 'Nothing is due today. Add a Self Task for what you will do today (due today), then file your plan.')
  }
  const { data, error } = await caller.svc.from('day_plans')
    .update({ submitted_at: now.toISOString(), planned_task_ids: tasks.map(t => t.id) })
    .eq('id', ctx.plan.id).is('submitted_at', null).select('id')
  if (error) throw new Error(error.message)
  return ok({ filed: true, count: tasks.length, duplicate: (data ?? []).length === 0 })
}

/**
 * Closing the day, on the Task Management dashboard: every task of the day is handed in or carried to
 * another day with a reason; the summary is written and also files the day's EOD log (owner, 2026-11-12).
 * Before the closing time it still closes (somebody leaving early with permission), and the time shows.
 */
export async function closeDay(caller: Caller, body: Record<string, unknown>, now: Date = new Date()): Promise<Result> {
  const ctx = await memberPlanForToday(caller, now)
  if (isResult(ctx)) return ctx
  if (!ctx.plan.submitted_at) return fail(409, 'File your plan first.')
  const summary = validateSummary(body.summary)
  if (!summary.ok) return fail(400, summary.error)

  const sent: Carryover[] = []
  for (const raw of Array.isArray(body.carryovers) ? body.carryovers : []) {
    const v = validateCarryover(raw, ctx.today)
    if (!v.ok) return fail(400, v.error)
    sent.push(v.value)
  }
  const [all, existing] = await Promise.all([
    tasksForDay(caller.svc, [caller.id], ctx.today, ctx.plan.planned_task_ids ?? []),
    readCarryovers(caller.svc, [ctx.plan.id]),
  ])
  const before = dayView(all, caller.id, ctx.today, ctx.plan, existing)
  const known = new Set(before.tasks.map(t => t.id))
  const strangers = sent.filter(c => !known.has(c.task_id))
  if (strangers.length) return fail(400, 'One of those tasks is not in your day.')

  const after = dayView(all, caller.id, ctx.today, ctx.plan, [...existing, ...sent])
  const open = after.tasks.filter(t => t.state === 'open')
  if (open.length > 0) {
    return fail(409, `Finish or carry over every task first: ${open.length} still open.`, { open_task_ids: open.map(t => t.id) })
  }

  const handedInNow = new Set(after.tasks.filter(t => t.state === 'done').map(t => t.id))
  const rows = sent.filter(c => !handedInNow.has(c.task_id)).map(c => ({ plan_id: ctx.plan.id, ...c }))
  if (rows.length) {
    const { error } = await caller.svc.from('day_close_carryovers').upsert(rows, { onConflict: 'plan_id,task_id' })
    if (error) throw new Error(error.message)
  }
  // The day's EOD log, from the same words (Performance and the old EOD screen keep reading it).
  const eod = await caller.svc.from('daily_work_logs')
    .upsert({ user_id: caller.id, log_date: ctx.today, summary: summary.value }, { onConflict: 'user_id,log_date' })
  if (eod.error) throw new Error(eod.error.message)
  const { error } = await caller.svc.from('day_plans')
    .update({ closed_at: now.toISOString(), close_note: summary.value.slice(0, 2000) })
    .eq('id', ctx.plan.id).is('closed_at', null)
  if (error) throw new Error(error.message)
  return ok({ closed: true })
}

// ─── Team Today (admins and the reviewer) ────────────────────────────────────

type StrikeRow = {
  id: string
  employee_id: string
  work_date: string
  kind: StrikeKind
  detail: Record<string, unknown>
  status: StrikeStatus
  decided_at: string | null
  decision_note: string | null
}

export async function loadTeam(caller: Caller, dateParam: string | null, now: Date = new Date()): Promise<Result> {
  const svc = caller.svc
  const settings = await readSettings(svc)
  const viewer = await viewerOf(caller, settings)
  if (!viewer.seesTeam) return fail(403, 'Forbidden')

  const today = istToday(now)
  const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) && dateParam <= today ? dateParam : today
  const people = await activeMembers(svc)
  const ids = people.map(p => p.id)
  const minopIds = people.map(p => p.minop_user_id).filter((v): v is string => !!v)
  const monthStart = `${date.slice(0, 7)}-01`
  const none = Promise.resolve({ data: [], error: null })

  const [holiday, leave, times, plansRead, strikesRead, monthStrikesRead, openStrikesRead, callsRead, overdueRead, reviewerRead] = await Promise.all([
    isHoliday(svc, date),
    onFullDayLeave(svc, ids, date),
    machineTimes(svc, minopIds, date),
    ids.length ? svc.from('day_plans').select(PLAN_COLUMNS).eq('work_date', date).in('employee_id', ids) : none,
    ids.length ? svc.from('day_strikes').select('id, employee_id, work_date, kind, detail, status, decided_at, decision_note').eq('work_date', date).in('employee_id', ids) : none,
    ids.length ? svc.from('day_strikes').select('employee_id, status').gte('work_date', monthStart).lte('work_date', date).in('employee_id', ids).neq('status', 'waived') : none,
    svc.from('day_strikes').select('id, employee_id, work_date, kind, detail, status, decided_at, decision_note').eq('status', 'open').order('work_date', { ascending: false }).limit(200),
    ids.length ? svc.from('sales_lead_activities').select('actor, kind').in('actor', ids).in('kind', ['call', 'whatsapp']).is('undone_at', null).gte('at', istDayStartUtc(date)).lte('at', istDayEndUtc(date)) : none,
    ids.length ? svc.from('tasks').select('assigned_to, status, due_date').in('assigned_to', ids).lt('due_date', date).not('status', 'in', '(completed,cancelled,pending_approval)') : none,
    settings.reviewer_id ? svc.from('users').select('full_name').eq('id', settings.reviewer_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ])
  for (const r of [plansRead, strikesRead, monthStrikesRead, openStrikesRead, callsRead, overdueRead]) {
    if (r.error) throw new Error(r.error.message)
  }

  const plans = (plansRead.data ?? []) as Plan[]
  const planByPerson = new Map(plans.map(p => [p.employee_id, p]))
  const [all, carry] = await Promise.all([
    tasksForDay(svc, ids, date, plans.flatMap(p => p.planned_task_ids ?? [])),
    readCarryovers(svc, plans.map(p => p.id)),
  ])
  const carryByPlan = new Map<string, Carryover[]>()
  for (const c of carry) carryByPlan.set(c.plan_id, [...(carryByPlan.get(c.plan_id) ?? []), c])

  const strikesByPerson = new Map<string, StrikeRow[]>()
  for (const s of (strikesRead.data ?? []) as StrikeRow[]) strikesByPerson.set(s.employee_id, [...(strikesByPerson.get(s.employee_id) ?? []), s])
  const monthCount = new Map<string, number>()
  for (const s of (monthStrikesRead.data ?? []) as { employee_id: string }[]) monthCount.set(s.employee_id, (monthCount.get(s.employee_id) ?? 0) + 1)
  const calls = new Map<string, { call: number; whatsapp: number }>()
  for (const a of (callsRead.data ?? []) as { actor: string; kind: string }[]) {
    const c = calls.get(a.actor) ?? { call: 0, whatsapp: 0 }
    if (a.kind === 'call') c.call++
    else c.whatsapp++
    calls.set(a.actor, c)
  }
  const overdue = new Map<string, number>()
  for (const t of (overdueRead.data ?? []) as { assigned_to: string; status: string; due_date: string | null }[]) {
    if (isTaskOverdue(t, date)) overdue.set(t.assigned_to, (overdue.get(t.assigned_to) ?? 0) + 1)
  }

  const nameById = new Map(people.map(p => [p.id, p.full_name ?? 'Unknown']))
  // Open strikes of people no longer switched on still need a decision: name them too.
  const openStrikes = (openStrikesRead.data ?? []) as StrikeRow[]
  const strangerIds = [...new Set(openStrikes.map(s => s.employee_id).filter(id => !nameById.has(id)))]
  if (strangerIds.length) {
    const r = await svc.from('users').select('id, full_name').in('id', strangerIds)
    for (const u of r.data ?? []) nameById.set(String(u.id), String(u.full_name ?? 'Unknown'))
  }

  const rows = people.map(p => {
    const plan = planByPerson.get(p.id) ?? null
    const punch = (p.minop_user_id && times.get(p.minop_user_id)) || { checkInAt: null, checkOutAt: null }
    return {
      id: p.id,
      name: p.full_name ?? 'Unknown',
      machineLinked: !!p.minop_user_id,
      onLeave: leave.has(p.id),
      punch,
      plan,
      ...dayView(all, p.id, date, plan, plan ? carryByPlan.get(plan.id) ?? [] : []),
      strikes: strikesByPerson.get(p.id) ?? [],
      monthStrikes: monthCount.get(p.id) ?? 0,
      calls: calls.get(p.id) ?? { call: 0, whatsapp: 0 },
      overdueTasks: overdue.get(p.id) ?? 0,
    }
  })

  return ok({
    date,
    today,
    workingDay: !isSunday(date) && !holiday,
    holiday,
    viewer,
    reviewer: settings.reviewer_id ? { id: settings.reviewer_id, name: (reviewerRead.data?.full_name as string | null) ?? null } : null,
    planDue: settings.plan_due_minutes,
    closeOpens: settings.close_opens_minutes,
    rows,
    openStrikes: openStrikes.map(s => ({ ...s, name: nameById.get(s.employee_id) ?? 'Unknown', label: STRIKE_LABEL[s.kind] })),
  })
}

// ─── Strike decisions (the reviewer only) ────────────────────────────────────

export async function decideStrike(caller: Caller, id: string, body: Record<string, unknown>, now: Date = new Date()): Promise<Result> {
  const settings = await readSettings(caller.svc)
  if (!settings.reviewer_id || settings.reviewer_id !== caller.id) {
    return fail(403, 'Only the Day Close reviewer decides strikes.')
  }
  const decision = body.decision
  if (decision !== 'upheld' && decision !== 'waived') return fail(400, 'Choose Uphold or Waive.')
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : ''
  if (decision === 'waived' && note.length < 3) return fail(400, 'Say why it is waived (at least 3 characters).')
  const { data, error } = await caller.svc.from('day_strikes')
    .update({ status: decision, decided_by: caller.id, decided_at: now.toISOString(), decision_note: note || null })
    .eq('id', id).eq('status', 'open').select('id')
  if (error) throw new Error(error.message)
  if ((data ?? []).length === 0) return fail(409, 'This strike was already decided, or does not exist.')
  return ok({ decided: true })
}

// ─── Who takes part, and who reviews (admins and the reviewer) ───────────────

export async function loadMembers(caller: Caller): Promise<Result> {
  const settings = await readSettings(caller.svc)
  const viewer = await viewerOf(caller, settings)
  if (!viewer.manages) return fail(403, 'Forbidden')
  const [people, members] = await Promise.all([
    caller.svc.from('users').select('id, full_name, role, is_active, is_deleted').eq('is_active', true),
    caller.svc.from('day_close_members').select('employee_id, active'),
  ])
  if (people.error) throw new Error(people.error.message)
  if (members.error) throw new Error(members.error.message)
  const on = new Set((members.data ?? []).filter(m => m.active).map(m => String(m.employee_id)))
  const list = (people.data ?? [])
    .filter(u => !u.is_deleted)
    .map(u => ({ id: String(u.id), name: String(u.full_name ?? 'Unknown'), role: String(u.role), member: on.has(String(u.id)) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return ok({ people: list, reviewer_id: settings.reviewer_id, viewer })
}

export async function changeMembers(caller: Caller, body: Record<string, unknown>, now: Date = new Date()): Promise<Result> {
  const settings = await readSettings(caller.svc)
  const viewer = await viewerOf(caller, settings)
  if (!viewer.manages) return fail(403, 'Forbidden')
  const action = body.action
  const stamp = now.toISOString()

  if (action === 'become_reviewer') {
    // Only an administrator, and only while nobody holds it: it is the owner's seat, not a toggle.
    if (!caller.isAdmin) return fail(403, 'Only an administrator can take the reviewer seat.')
    if (settings.reviewer_id) return fail(409, 'A reviewer is already set.')
    const { error } = await caller.svc.from('day_close_settings')
      .update({ reviewer_id: caller.id, updated_by: caller.id, updated_at: stamp }).eq('singleton', true).is('reviewer_id', null)
    if (error) throw new Error(error.message)
    return ok({ saved: true })
  }

  let ids: string[] = []
  if (action === 'add_everyone') {
    const { data, error } = await caller.svc.from('users').select('id, role, is_active, is_deleted').eq('is_active', true)
    if (error) throw new Error(error.message)
    // Everyone working, not administrators (the owner reviews; he does not file a plan).
    ids = (data ?? []).filter(u => !u.is_deleted && u.role !== 'admin').map(u => String(u.id))
  } else if ((action === 'add' || action === 'remove') && typeof body.employee_id === 'string') {
    ids = [body.employee_id]
  } else {
    return fail(400, 'Unknown action.')
  }
  if (ids.length === 0) return ok({ saved: true, count: 0 })

  if (action === 'remove') {
    const { error } = await caller.svc.from('day_close_members')
      .update({ active: false, removed_by: caller.id, removed_at: stamp }).in('employee_id', ids)
    if (error) throw new Error(error.message)
    return ok({ saved: true, count: ids.length })
  }
  const { data: known, error: knownError } = await caller.svc.from('users').select('id').in('id', ids).eq('is_active', true)
  if (knownError) throw new Error(knownError.message)
  const rows = (known ?? []).map(u => ({
    employee_id: String(u.id), active: true, added_by: caller.id, added_at: stamp, removed_by: null, removed_at: null,
  }))
  if (rows.length === 0) return fail(404, 'Person not found.')
  const { error } = await caller.svc.from('day_close_members').upsert(rows, { onConflict: 'employee_id' })
  if (error) throw new Error(error.message)
  return ok({ saved: true, count: rows.length })
}

// ─── The nightly check ───────────────────────────────────────────────────────

/** Writes the strikes for a date. Idempotent: a strike is written once and a decided one is never touched. */
export async function evaluateDay(svc: ServiceClient, date: string): Promise<{ date: string; judged: number; written: number }> {
  const people = await activeMembers(svc)
  if (people.length === 0 || isSunday(date)) return { date, judged: 0, written: 0 }
  const ids = people.map(p => p.id)
  const minopIds = people.map(p => p.minop_user_id).filter((v): v is string => !!v)
  const [settings, holiday, leave, times, plansRead] = await Promise.all([
    readSettings(svc),
    isHoliday(svc, date),
    onFullDayLeave(svc, ids, date),
    machineTimes(svc, minopIds, date),
    svc.from('day_plans').select(PLAN_COLUMNS).eq('work_date', date).in('employee_id', ids),
  ])
  if (plansRead.error) throw new Error(plansRead.error.message)
  const plans = new Map(((plansRead.data ?? []) as Plan[]).map(p => [p.employee_id, p]))

  const rows: { employee_id: string; work_date: string; kind: StrikeKind; detail: Record<string, unknown> }[] = []
  let judged = 0
  for (const p of people) {
    const punch = (p.minop_user_id && times.get(p.minop_user_id)) || { checkInAt: null, checkOutAt: null }
    const plan = plans.get(p.id) ?? null
    const drafts = judgeDay({
      date, holiday, fullDayLeave: leave.has(p.id),
      checkInAt: punch.checkInAt, checkOutAt: punch.checkOutAt,
      plan, openItems: 0,
      planDueMinutes: settings.plan_due_minutes,
    })
    if (drafts.length || punch.checkInAt || punch.checkOutAt) judged++
    for (const d of drafts) rows.push({ employee_id: p.id, work_date: date, kind: d.kind, detail: d.detail })
  }
  if (rows.length === 0) return { date, judged, written: 0 }
  const { data, error } = await svc.from('day_strikes')
    .upsert(rows, { onConflict: 'employee_id,work_date,kind', ignoreDuplicates: true }).select('id')
  if (error) throw new Error(error.message)
  return { date, judged, written: (data ?? []).length }
}

// ─── Leave while work is pending ─────────────────────────────────────────────

export async function pendingWorkFor(svc: ServiceClient, employeeId: string, today: string): Promise<PendingWork> {
  const from = istAddDays(today, -UNCLOSED_LOOKBACK_DAYS)
  const [tasks, unclosed] = await Promise.all([
    // Filtered here (isTaskOverdue), not in the query: one person's past-due tasks are few.
    svc.from('tasks').select('status, due_date').eq('assigned_to', employeeId).lt('due_date', today),
    svc.from('day_strikes').select('work_date').eq('employee_id', employeeId).eq('kind', 'day_not_closed')
      .neq('status', 'waived').gte('work_date', from).lt('work_date', today),
  ])
  if (tasks.error) throw new Error(tasks.error.message)
  if (unclosed.error) throw new Error(unclosed.error.message)
  return {
    overdueTasks: ((tasks.data ?? []) as { status: string; due_date: string | null }[]).filter(t => isTaskOverdue(t, today)).length,
    unclosedDays: new Set((unclosed.data ?? []).map(r => String(r.work_date))).size,
  }
}

/**
 * After a leave request is saved: if its owner takes part and has work pending, lock it so only the
 * reviewer can approve it. Returns the words to tell the employee, or null. A failed check locks it
 * anyway (fail closed): the reviewer can still approve it.
 */
export async function lockLeaveIfPending(
  svc: ServiceClient,
  request: { id: string; employee_id: string; request_type: string },
  today: string,
): Promise<string | null> {
  if (!isLockedLeaveType(request.request_type)) return null
  const member = await svc.from('day_close_members').select('active').eq('employee_id', request.employee_id).maybeSingle()
  if (member.error || !member.data?.active) return null
  let pending: PendingWork
  let detail: Record<string, unknown> = {}
  try {
    pending = await pendingWorkFor(svc, request.employee_id, today)
  } catch (error) {
    pending = { overdueTasks: 0, unclosedDays: 0 }
    detail = { check_failed: error instanceof Error ? error.message : 'unknown error' }
  }
  if (!hasPendingWork(pending) && !detail.check_failed) return null
  const words = detail.check_failed ? 'pending work could not be checked' : pendingWorkWords(pending)
  const { error } = await svc.from('day_close_leave_locks').upsert({
    request_id: request.id,
    employee_id: request.employee_id,
    overdue_tasks: pending.overdueTasks,
    unclosed_days: pending.unclosedDays,
    detail: { ...detail, words },
  }, { onConflict: 'request_id', ignoreDuplicates: true })
  if (error) console.error('[day-close] leave lock not written:', error.message)
  return words
}

/** The locks still holding for these requests, by request id. */
export async function leaveLocksFor(svc: ServiceClient, requestIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (requestIds.length === 0) return out
  const { data, error } = await svc.from('day_close_leave_locks')
    .select('request_id, detail').in('request_id', requestIds).is('released_at', null)
  if (error) return out
  for (const row of data ?? []) {
    const words = (row.detail as { words?: string } | null)?.words ?? 'work pending'
    out.set(String(row.request_id), words)
  }
  return out
}

/**
 * Before a leave decision. Approving a locked request: only the reviewer, and it releases the lock.
 * Returns a refusal, or null to go ahead. Rejecting is anybody's to do, as before.
 */
export async function leaveDecisionGate(
  svc: ServiceClient,
  callerId: string,
  requestId: string,
  newStatus: string,
): Promise<{ status: number; error: string } | null> {
  if (newStatus !== 'approved') return null
  const locks = await leaveLocksFor(svc, [requestId])
  const words = locks.get(requestId)
  if (!words) return null
  const settings = await readSettings(svc)
  if (settings.reviewer_id && settings.reviewer_id === callerId) return null
  let name = 'the Day Close reviewer'
  if (settings.reviewer_id) {
    const r = await svc.from('users').select('full_name').eq('id', settings.reviewer_id).maybeSingle()
    if (r.data?.full_name) name = String(r.data.full_name)
  }
  return { status: 409, error: `Work is pending (${words}). Only ${name} can approve this leave.` }
}

export async function releaseLeaveLock(svc: ServiceClient, callerId: string, requestId: string, now: string): Promise<void> {
  const { error } = await svc.from('day_close_leave_locks')
    .update({ released_by: callerId, released_at: now }).eq('request_id', requestId).is('released_at', null)
  if (error) console.error('[day-close] leave lock not released:', error.message)
}
