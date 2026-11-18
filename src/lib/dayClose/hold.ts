// THE ATTENDANCE HOLD (owner, 2026-11-18): the one consequence of Day Close's one rule.
//
//   the rule     before you leave, every task due today (and anything overdue) is Done, or moved to a new date
//                with a reason (Close my day moves the task's due date)
//   11:15 pm     anybody who came in on a working day and still has such a task open: the NEXT working day is
//                put ON HOLD (one day_close_holds row) and they are told
//   at punch-out a punch after 5:30 pm with work still open: "you left with N tasks open" (once a day)
//   at punch-in  a punch on a held day: "your punch-in is recorded but not counted" (once)
//   cleared      the moment none of that work is open (finished, or moved to a later date), the hold clears by
//                itself and they are told "today is counted". The owner can lift a hold with a reason. A hold
//                never cleared is the owner's call at payroll (an attendance correction). NOTHING is deducted here.
//
// Never a hold for a Sunday, a holiday, approved full-day leave, or a day with no punch on the machine, and
// nothing at all while the team switch (Control Center) is off.
//
// FAILS QUIET. Before 20270802000100 is applied the holds table does not exist: every read here answers "no
// hold" and every write is logged and skipped, so Day Close keeps working without it. A notification that
// cannot be written never fails the step that sent it.

import type { Caller, ServiceClient } from '@/lib/security/attendancePayrollApiAuth'
import { istAddDays, istDateOf, istDayStartUtc, istMinutesOfDay, istToday } from '@/lib/istDate'
import { activeMembers, closeDay, isHoliday, loadMyDay, loadMyPrompt, loadTeam, machineTimes, onFullDayLeave, readSettings, viewerOf } from './server'
import { isSunday } from './rules'

export const HOLD_NOTIFICATION_TYPE = 'day_close_hold'
/** A punch at or after this minute of the IST day is a departure (5:30 pm). */
export const LEAVING_FROM_MINUTES = 17 * 60 + 30
/** A punch before this minute is an arrival (2:00 pm), as on the punch strip. */
export const ARRIVAL_BEFORE_MINUTES = 14 * 60

const DONE = new Set(['completed', 'cancelled', 'pending_approval'])

export type Hold = {
  id: string
  employee_id: string
  held_date: string
  cause_date: string
  open_tasks: number
  created_at: string
  punch_notice_at: string | null
  cleared_at: string | null
  cleared_by: string | null
  clear_reason: string | null
}

const HOLD_COLUMNS = 'id, employee_id, held_date, cause_date, open_tasks, created_at, punch_notice_at, cleared_at, cleared_by, clear_reason'

type R = { status: number; body: Record<string, unknown> }
const ok = (body: Record<string, unknown>): R => ({ status: 200, body })
const fail = (status: number, error: string): R => ({ status, body: { error } })

// ─── Pure rules ──────────────────────────────────────────────────────────────

/** A task still counts against the day: due on or before it and not handed in or cancelled. */
export function isOpenOn(task: { status: string; due_date: string | null }, date: string): boolean {
  return !!task.due_date && task.due_date <= date && !DONE.has(String(task.status))
}

/** The next working day after `date`: not a Sunday, not a holiday. Two weeks at most. */
export function nextWorkingDay(date: string, holidays: ReadonlySet<string>): string {
  let d = istAddDays(date, 1)
  for (let i = 0; i < 14 && (isSunday(d) || holidays.has(d)); i++) d = istAddDays(d, 1)
  return d
}

const tasksWord = (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`

/** "Thu, 19 Nov" from an IST date. */
function dayWords(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
}

function clockWords(instant: string): string {
  return new Date(instant).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
}

export const MESSAGES = {
  left: (open: number) => ({
    title: 'You left with work open',
    body: `${tasksWord(open)} still open. Finish them or move them to a new date with a reason, or tomorrow's attendance will be on hold.`,
  }),
  held: (open: number, heldDate: string) => ({
    title: 'Tomorrow’s attendance is on hold',
    body: `You left with ${tasksWord(open)} open. Your punch-in on ${dayWords(heldDate)} will not be counted until you finish them or move them to a new date.`,
  }),
  punch: (punchAt: string) => ({
    title: 'Your punch-in is not counted yet',
    body: `Your punch-in at ${clockWords(punchAt)} is recorded but not counted, because yesterday's work was not closed. Close it now on Task Management to count today.`,
  }),
  cleared: () => ({
    title: 'Today is counted',
    body: 'Thanks. Yesterday’s work is closed, so your attendance today counts.',
  }),
}

// ─── Reads and writes ────────────────────────────────────────────────────────

async function notify(svc: ServiceClient, userId: string, message: { title: string; body: string }): Promise<void> {
  const { error } = await svc.from('notifications').insert({ user_id: userId, type: HOLD_NOTIFICATION_TYPE, ...message })
  if (error) console.error('[day-close/hold] notification not written:', error.message)
}

/** Each person's open tasks due on or before `date`. */
export async function openWorkByPerson(svc: ServiceClient, ids: string[], date: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (ids.length === 0) return out
  const { data, error } = await svc.from('tasks').select('assigned_to, status, due_date').in('assigned_to', ids).lte('due_date', date)
  if (error) throw new Error(error.message)
  for (const t of (data ?? []) as { assigned_to: string; status: string; due_date: string | null }[]) {
    if (isOpenOn(t, date)) out.set(t.assigned_to, (out.get(t.assigned_to) ?? 0) + 1)
  }
  return out
}

async function holidaysAfter(svc: ServiceClient, date: string): Promise<Set<string>> {
  const { data, error } = await svc.from('payroll_holidays').select('holiday_date')
    .gt('holiday_date', date).lte('holiday_date', istAddDays(date, 15))
  if (error) throw new Error(error.message)
  return new Set((data ?? []).map(r => String(r.holiday_date)))
}

/** Open holds for these people on or before `upTo` (the person's own, Team Today's). Empty when the table is missing. */
export async function openHolds(svc: ServiceClient, ids: string[] | null, upTo: string): Promise<Hold[]> {
  let q = svc.from('day_close_holds').select(HOLD_COLUMNS).is('cleared_at', null).lte('held_date', upTo)
  if (ids) {
    if (ids.length === 0) return []
    q = q.in('employee_id', ids)
  }
  const { data, error } = await q.order('held_date', { ascending: true })
  if (error) return []
  return (data ?? []) as Hold[]
}

/**
 * THE NIGHTLY CHECK (the 11:15 pm cron, for the day just ending): every member who came in and still has work
 * open gets the next working day on hold, and is told. Written once: a second run adds nothing.
 */
export async function writeHolds(svc: ServiceClient, date: string, now: Date = new Date()): Promise<{ date: string; judged: number; written: number }> {
  void now
  const settings = await readSettings(svc)
  if (!settings.team_live) return { date, judged: 0, written: 0 }
  if (isSunday(date) || await isHoliday(svc, date)) return { date, judged: 0, written: 0 }
  const people = await activeMembers(svc)
  if (people.length === 0) return { date, judged: 0, written: 0 }
  const ids = people.map(p => p.id)
  const minopIds = people.map(p => p.minop_user_id).filter((v): v is string => !!v)
  const [leave, times, open, holidays] = await Promise.all([
    onFullDayLeave(svc, ids, date),
    machineTimes(svc, minopIds, date),
    openWorkByPerson(svc, ids, date),
    holidaysAfter(svc, date),
  ])
  const heldDate = nextWorkingDay(date, holidays)

  let judged = 0
  let written = 0
  for (const p of people) {
    const punch = p.minop_user_id ? times.get(p.minop_user_id) : undefined
    // No punch on the machine (or no Machine ID): never held. Approved full-day leave: never held.
    if (!punch?.checkInAt || leave.has(p.id)) continue
    judged++
    const n = open.get(p.id) ?? 0
    if (n === 0) continue
    const { data, error } = await svc.from('day_close_holds')
      .upsert({ employee_id: p.id, held_date: heldDate, cause_date: date, open_tasks: n }, { onConflict: 'employee_id,held_date', ignoreDuplicates: true })
      .select('id')
    if (error) { console.error('[day-close/hold] hold not written:', error.message); continue }
    if ((data ?? []).length === 0) continue
    written++
    await notify(svc, p.id, MESSAGES.held(n, heldDate))
  }
  return { date, judged, written }
}

/**
 * Clears a person's open holds whose work is now closed (finished, or moved to a later date), and tells them.
 * Called whenever their day is read, after Close my day, and at a punch. Returns the holds still open.
 */
export async function refreshHolds(svc: ServiceClient, employeeId: string, now: Date = new Date()): Promise<Hold[]> {
  const today = istToday(now)
  const holds = await openHolds(svc, [employeeId], today)
  if (holds.length === 0) return []
  const still: Hold[] = []
  for (const h of holds) {
    const open = (await openWorkByPerson(svc, [employeeId], h.cause_date)).get(employeeId) ?? 0
    if (open > 0) { still.push({ ...h, open_tasks: open }); continue }
    const { data, error } = await svc.from('day_close_holds').update({ cleared_at: now.toISOString() })
      .eq('id', h.id).is('cleared_at', null).select('id')
    if (error) { console.error('[day-close/hold] hold not cleared:', error.message); still.push(h); continue }
    if ((data ?? []).length && h.held_date === today) await notify(svc, employeeId, MESSAGES.cleared())
  }
  return still
}

/** The person's own hold to show (today's first, else the oldest), after clearing what can be cleared. */
export async function myHold(svc: ServiceClient, employeeId: string, now: Date = new Date()): Promise<Hold | null> {
  const still = await refreshHolds(svc, employeeId, now).catch(() => [] as Hold[])
  const today = istToday(now)
  return still.find(h => h.held_date === today) ?? still[0] ?? null
}

/**
 * At a punch (the Minop webhook, after it has answered Minop): the punch-in on a held day, and the punch-out with
 * work open. Each message goes once. Never throws: the punch is already safe.
 */
export async function onPunches(svc: ServiceClient, receivedAt: string, now: Date = new Date()): Promise<number> {
  try {
    if (!(await readSettings(svc)).team_live) return 0
    const today = istToday(now)
    const { data, error } = await svc.from('minop_punches').select('minop_user_id, punch_at').eq('first_seen_at', receivedAt)
    if (error || !data?.length) return 0
    const punches = (data as { minop_user_id: string; punch_at: string }[]).filter(p => istDateOf(p.punch_at) === today)
    if (!punches.length) return 0
    const people = await activeMembers(svc)
    const byMinop = new Map(people.filter(p => p.minop_user_id).map(p => [String(p.minop_user_id), p.id]))
    let sent = 0
    for (const p of punches) {
      const who = byMinop.get(String(p.minop_user_id))
      if (!who) continue
      const minute = istMinutesOfDay(p.punch_at)
      if (minute < ARRIVAL_BEFORE_MINUTES) {
        const held = (await refreshHolds(svc, who, now)).find(h => h.held_date === today && !h.punch_notice_at)
        if (!held) continue
        const { data: marked } = await svc.from('day_close_holds').update({ punch_notice_at: now.toISOString() })
          .eq('id', held.id).is('punch_notice_at', null).select('id')
        if (!marked?.length) continue
        await notify(svc, who, MESSAGES.punch(p.punch_at))
        sent++
      } else if (minute >= LEAVING_FROM_MINUTES) {
        const open = (await openWorkByPerson(svc, [who], today)).get(who) ?? 0
        if (open === 0) continue
        const told = await svc.from('notifications').select('id').eq('user_id', who).eq('type', HOLD_NOTIFICATION_TYPE)
          .eq('title', MESSAGES.left(1).title).gte('created_at', istDayStartUtc(today)).limit(1)
        if (told.error || (told.data ?? []).length) continue
        await notify(svc, who, MESSAGES.left(open))
        sent++
      }
    }
    return sent
  } catch (e) {
    console.error('[day-close/hold] punch check failed:', e instanceof Error ? e.message : 'unknown error')
    return 0
  }
}

/** The owner (or an administrator) lifts a hold, with a reason. */
export async function liftHold(caller: Caller, id: string, body: Record<string, unknown>, now: Date = new Date()): Promise<R> {
  const settings = await readSettings(caller.svc)
  const viewer = await viewerOf(caller, settings)
  if (!viewer.manages) return fail(403, 'Forbidden')
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (reason.length < 3) return fail(400, 'Say why the hold is lifted (at least 3 characters).')
  const { data, error } = await caller.svc.from('day_close_holds')
    .update({ cleared_at: now.toISOString(), cleared_by: caller.id, clear_reason: reason.slice(0, 500) })
    .eq('id', id).is('cleared_at', null).select('id, employee_id, held_date')
  if (error) throw new Error(error.message)
  const row = (data ?? [])[0] as { employee_id: string; held_date: string } | undefined
  if (!row) return fail(409, 'This hold was already cleared, or does not exist.')
  if (row.held_date === istToday(now)) await notify(caller.svc, row.employee_id, MESSAGES.cleared())
  return ok({ lifted: true })
}

// ─── The routes' loaders, with the hold added ────────────────────────────────

/** GET /api/day-close/me: the person's day, plus their hold (none while paused or not a member). */
export async function loadMyDayWithHold(caller: Caller, now: Date = new Date()): Promise<R> {
  const r = await loadMyDay(caller, now)
  if (r.status !== 200 || !r.body.member || r.body.live !== true) return r
  return { ...r, body: { ...r.body, hold: await myHold(caller.svc, caller.id, now) } }
}

/** The Modules strip: a hold comes first, before the evening close. */
export async function loadMyPromptWithHold(caller: Caller, now: Date = new Date()): Promise<R> {
  const r = await loadMyPrompt(caller, now)
  if (r.status !== 200) return r
  if (!(await readSettings(caller.svc)).team_live) return r
  const member = (await viewerOf(caller, await readSettings(caller.svc))).isMember
  if (!member) return r
  const hold = await myHold(caller.svc, caller.id, now)
  if (!hold) return r
  return { ...r, body: { ...r.body, prompt: { kind: 'on_hold', open: hold.open_tasks, causeDate: hold.cause_date } } }
}

/** POST close_day: closing may close yesterday's work too (moved dates), so the hold is checked again. */
export async function closeDayWithHold(caller: Caller, body: Record<string, unknown>, now: Date = new Date()): Promise<R> {
  const r = await closeDay(caller, body, now)
  if (r.status === 200) await refreshHolds(caller.svc, caller.id, now).catch(() => [])
  return r
}

/** Team Today, plus every hold still open on or before the day shown, with names. */
export async function loadTeamWithHolds(caller: Caller, dateParam: string | null, now: Date = new Date()): Promise<R> {
  const r = await loadTeam(caller, dateParam, now)
  if (r.status !== 200) return r
  const date = String(r.body.date)
  const holds = await openHolds(caller.svc, null, date)
  const names = new Map<string, string>()
  for (const row of (r.body.rows ?? []) as { id: string; name: string }[]) names.set(row.id, row.name)
  const missing = [...new Set(holds.map(h => h.employee_id).filter(id => !names.has(id)))]
  if (missing.length) {
    const u = await caller.svc.from('users').select('id, full_name').in('id', missing)
    for (const x of u.data ?? []) names.set(String(x.id), String(x.full_name ?? 'Unknown'))
  }
  return { ...r, body: { ...r.body, holds: holds.map(h => ({ ...h, name: names.get(h.employee_id) ?? 'Unknown' })) } }
}
