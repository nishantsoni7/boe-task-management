// One day on the machine, for the admin's Today tab. Read-only: it selects and
// writes nothing.
//
// It shows what the machine recorded, worked out with the same buildMachineDay
// that writes attendance, so a row here is the row attendance will hold. It does
// not read attendance_day_corrections: a missing punch is fixed in Monthly Review.
//
// Who is listed: active people with a Machine ID, plus active payroll people with
// none, because those are the ones who will show absent until they are linked. A
// punch on any other ID is returned as a stray so somebody can act on it.
//
// When the machine is silent nobody is called absent. Today that means the machine
// has stopped (machineHealth.ts). On a past working day it means nobody at all
// punched, which is the same rule the month views follow: a day the machine has
// not sent stays unprocessed rather than becoming an absence.
//
// "Late" is the payroll rule: past the grace period, counted from the scheduled
// start. It is information only. The month views' own "late" has no grace period.

import type { SupabaseClient } from '@supabase/supabase-js'
import { isWeeklyOff } from '../attendance/monthCalendar'
import { toClock, type HalfSession, type RequestType } from '../attendance/requests'
import { computeWorkedDuration } from '../attendance/workedDuration'
import { istDayEndUtc, istDayStartUtc, istMinutesOfDay, istToday } from '../istDate'
import type { PayrollSettings } from '../payroll/settings'
import { fetchActiveSettings } from '../payroll/settingsStore'
import { fetchAllRows, unwrapPagedRows } from '../supabasePaging'
import { MACHINE_ATTENDANCE_FROM, buildMachineDay, machineDateOf } from './machineDay'
import { isFullDayHoliday, readMachineHealth, type MachineHealth } from './machineHealth'
import { isPlausiblePunchTime } from './punches'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Service = SupabaseClient<any, any, any>

export type MachineDayStatus =
  | 'in_office'
  | 'left'
  | 'no_punch_yet'
  | 'no_punch'
  | 'cant_tell'
  | 'on_leave'
  | 'day_off'
  | 'morning_missing'
  | 'evening_missing'
  | 'no_machine_id'

/** The filters over the list. A day off belongs to none of them. */
export type MachineDayGroup = 'in_office' | 'left' | 'no_punch' | 'on_leave' | 'needs_look'

export type MachineDayEntry = {
  userId: string
  name: string
  machineId: string | null
  checkInAt: string | null
  checkOutAt: string | null
  /** After lunch, the figure the month views use. Null without a complete pair. */
  hoursWorked: number | null
  lateMinutes: number | null
  status: MachineDayStatus
  /** Which filter the row sits under. A day off is under none. */
  group: MachineDayGroup | null
  /** An approved request covers this day. */
  approved: boolean
  note: string | null
}

export type MachineDayPerson = {
  id: string
  full_name: string
  minop_user_id: string | null
  is_active: boolean | null
  is_deleted: boolean | null
  payroll_active: boolean | null
  joining_date: string | null
  exit_date: string | null
}

export type MachineDayPunch = {
  minop_user_id: string
  punch_local: string
  punch_at: string
  first_seen_at: string
}

export type MachineDayRequest = {
  employee_id: string
  request_type: RequestType
  expected_arrival_time: string | null
  departure_time: string | null
  return_time: string | null
  half_session: HalfSession | null
}

export type StrayPunches = {
  machineId: string
  /** `HH:mm`, earliest first. */
  times: string[]
  /** Who the ID is linked to, when that person is no longer active. */
  ownerName: string | null
  /** The sentence an admin reads. */
  message: string
}

export type MachineDayCounts = Record<MachineDayGroup | 'all', number>

export type MachineDayView = {
  date: string
  today: string
  /** The first day the arrows may reach. */
  earliest: string
  health: MachineHealth
  entries: MachineDayEntry[]
  counts: MachineDayCounts
  strays: StrayPunches[]
}

type DaySettings = Pick<PayrollSettings,
  'scheduled_in_minutes' | 'grace_end_minutes' | 'lunch_in_before_minutes' | 'lunch_out_after_minutes' | 'lunch_hours'>

export type MachineDayInput = {
  date: string
  today: string
  /** IST minutes past midnight now. Only used to word a note about today. */
  nowMinutes: number
  people: MachineDayPerson[]
  /** Everyone's real punches on this date. */
  punches: MachineDayPunch[]
  /** Approved requests covering this date. */
  requests: MachineDayRequest[]
  isHoliday: boolean
  machineStopped: boolean
  settings: DaySettings
}

const GROUP: Record<MachineDayStatus, MachineDayGroup | null> = {
  in_office: 'in_office',
  left: 'left',
  no_punch_yet: 'no_punch',
  no_punch: 'no_punch',
  cant_tell: 'no_punch',
  on_leave: 'on_leave',
  day_off: null,
  morning_missing: 'needs_look',
  evening_missing: 'needs_look',
  no_machine_id: 'needs_look',
}

/** Who needs a look comes first: no punch, then a missing punch, then everybody else. */
const RANK: Record<MachineDayStatus, number> = {
  no_punch: 0,
  no_punch_yet: 0,
  morning_missing: 2,
  evening_missing: 2,
  cant_tell: 3,
  in_office: 4,
  left: 5,
  on_leave: 6,
  day_off: 7,
  no_machine_id: 8,
}

/** The first date the screen can show: today until the machine starts, then the start. */
export function earliestMachineDay(today: string): string {
  return today < MACHINE_ATTENDANCE_FROM ? today : MACHINE_ATTENDANCE_FROM
}

/** A real calendar date between the first day the screen can show and today. */
export function isMachineDayParam(date: string, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const parsed = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return false
  return date >= earliestMachineDay(today) && date <= today
}

/** 605 -> "10:05 am", the clock the rest of the module shows. */
export function clockLabel(minutes: number): string {
  const hour24 = Math.floor(minutes / 60) % 24
  const hour = hour24 % 12 || 12
  const minute = String(minutes % 60).padStart(2, '0')
  return `${String(hour).padStart(2, '0')}:${minute} ${hour24 < 12 ? 'am' : 'pm'}`
}

function clockOf(value: string | null): string | null {
  const clock = toClock(value)
  return clock ? clockLabel(Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5))) : null
}

function requestNote(r: MachineDayRequest): string {
  switch (r.request_type) {
    case 'full_day_leave':
      return 'Approved full-day leave'
    case 'late_arrival': {
      const until = clockOf(r.expected_arrival_time)
      return until ? `Approved late arrival, until ${until}` : 'Approved late arrival'
    }
    case 'early_departure': {
      const at = clockOf(r.departure_time)
      return at ? `Approved early departure, at ${at}` : 'Approved early departure'
    }
    case 'time_out': {
      const from = clockOf(r.departure_time)
      const to = clockOf(r.return_time)
      return from && to ? `Approved time out, ${from} to ${to}` : 'Approved time out'
    }
    case 'half_day':
      return `Approved half day, ${r.half_session === 'first_half' ? 'first half' : 'second half'}`
  }
}

function noteFor(status: MachineDayStatus, approved: string | null, input: MachineDayInput): string | null {
  const start = input.settings.scheduled_in_minutes
  switch (status) {
    case 'no_machine_id':
      return 'Link one on Employees, or this person shows absent'
    case 'morning_missing':
      return 'One punch only, so it counts as leaving'
    case 'evening_missing':
      return 'One punch only, so it counts as arriving'
    case 'no_punch':
      return approved ?? 'Shows absent in Monthly Review'
    case 'no_punch_yet':
      return approved ?? `Office ${input.nowMinutes >= start ? 'opened' : 'opens'} at ${clockLabel(start)}`
    default:
      return approved
  }
}

function entryFor(person: MachineDayPerson, punches: MachineDayPunch[], input: MachineDayInput, silent: boolean, dayOff: boolean): MachineDayEntry {
  const { date, today, settings } = input
  const day = buildMachineDay(punches)
  const requests = input.requests.filter(r => r.employee_id === person.id)
  const onLeave = requests.some(r => r.request_type === 'full_day_leave')

  let status: MachineDayStatus
  if (!person.minop_user_id) status = 'no_machine_id'
  else if (day?.check_in_at && day.check_out_at) status = 'left'
  else if (day?.check_out_at) status = 'morning_missing'
  else if (day) status = date === today ? 'in_office' : 'evening_missing'
  else if (onLeave) status = 'on_leave'
  else if (dayOff) status = 'day_off'
  else if (silent) status = 'cant_tell'
  else status = date === today ? 'no_punch_yet' : 'no_punch'

  const checkInAt = day?.check_in_at ?? null
  const checkOutAt = day?.check_out_at ?? null

  let hoursWorked: number | null = null
  if (checkInAt && checkOutAt) {
    const elapsed = (Date.parse(checkOutAt) - Date.parse(checkInAt)) / 3_600_000
    hoursWorked = computeWorkedDuration(istMinutesOfDay(checkInAt), istMinutesOfDay(checkOutAt), elapsed, {
      start: settings.lunch_out_after_minutes,
      end: settings.lunch_in_before_minutes,
      maxHours: settings.lunch_hours,
    }).paid_hours
  }

  const inMinutes = checkInAt ? istMinutesOfDay(checkInAt) : null
  const lateMinutes = inMinutes !== null && !dayOff && inMinutes > settings.grace_end_minutes
    ? inMinutes - settings.scheduled_in_minutes
    : null

  const approved = requests.length > 0 ? requests.map(requestNote).join('. ') : null
  return {
    userId: person.id,
    name: person.full_name,
    machineId: person.minop_user_id,
    checkInAt,
    checkOutAt,
    hoursWorked,
    lateMinutes,
    status,
    group: GROUP[status],
    approved: approved !== null,
    note: noteFor(status, approved, input),
  }
}

function sortKey(e: MachineDayEntry): number {
  // A no-punch row with an approved reason follows the ones with none.
  return RANK[e.status] + (e.approved && RANK[e.status] === 0 ? 1 : 0)
}

function compareEntries(a: MachineDayEntry, b: MachineDayEntry): number {
  return sortKey(a) - sortKey(b)
    || Number(b.lateMinutes !== null) - Number(a.lateMinutes !== null)
    || (a.checkInAt ?? '9').localeCompare(b.checkInAt ?? '9')
    || a.name.localeCompare(b.name)
}

/** The day's rows, most in need of a look first. */
export function buildMachineDayEntries(input: MachineDayInput): MachineDayEntry[] {
  const { date, today, punches } = input
  const dayOff = isWeeklyOff(date) || input.isHoliday
  const silent = !dayOff && (date === today ? input.machineStopped : punches.length === 0)

  const byMachineId = new Map<string, MachineDayPunch[]>()
  for (const punch of punches) {
    byMachineId.set(punch.minop_user_id, [...(byMachineId.get(punch.minop_user_id) ?? []), punch])
  }

  return input.people
    .filter(p => (!p.joining_date || date >= p.joining_date) && (!p.exit_date || date < p.exit_date))
    .map(p => entryFor(p, p.minop_user_id ? byMachineId.get(p.minop_user_id) ?? [] : [], input, silent, dayOff))
    .sort(compareEntries)
}

export function countMachineDay(entries: MachineDayEntry[]): MachineDayCounts {
  const counts: MachineDayCounts = { all: entries.length, in_office: 0, left: 0, no_punch: 0, on_leave: 0, needs_look: 0 }
  for (const entry of entries) {
    if (entry.group) counts[entry.group] += 1
  }
  return counts
}

function strayMessage(machineId: string, times: string[], ownerName: string | null): string {
  const labels = times.map(t => clockLabel(Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))))
  const when = labels.length > 1
    ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
    : labels[0]
  const whose = ownerName ? `It belongs to ${ownerName}, who is marked inactive` : 'It is not linked to anyone'
  return `Machine ID ${machineId} punched at ${when}. ${whose}, so nobody gets attendance from it.`
}

/** Punches on IDs that give nobody attendance. A wrong link or a leaver's ID shows up here. */
export function findStrayPunches(
  punches: MachineDayPunch[],
  listedIds: ReadonlySet<string>,
  people: MachineDayPerson[],
): StrayPunches[] {
  const owners = new Map(people.flatMap(p => (p.minop_user_id ? [[p.minop_user_id, p.full_name] as const] : [])))
  const byId = new Map<string, string[]>()
  for (const punch of punches) {
    if (listedIds.has(punch.minop_user_id)) continue
    byId.set(punch.minop_user_id, [...(byId.get(punch.minop_user_id) ?? []), punch.punch_local.slice(11, 16)])
  }
  return [...byId.entries()]
    .map(([machineId, times]) => {
      const ownerName = owners.get(machineId) ?? null
      const sorted = [...times].sort()
      return { machineId, times: sorted, ownerName, message: strayMessage(machineId, sorted, ownerName) }
    })
    .sort((a, b) => a.machineId.localeCompare(b.machineId, undefined, { numeric: true }))
}

/** Everything the Today tab shows for one date. A failed read throws. */
export async function readMachineDay(svc: Service, date: string, now: Date = new Date()): Promise<MachineDayView> {
  const today = istToday(now)
  const [health, active, holidays, requests, people, punches] = await Promise.all([
    readMachineHealth(svc, now),
    fetchActiveSettings(svc),
    svc.from('payroll_holidays').select('holiday_date, holiday_type').eq('holiday_date', date),
    svc.from('attendance_requests')
      .select('employee_id, request_type, expected_arrival_time, departure_time, return_time, half_session')
      .eq('status', 'approved')
      .lte('start_date', date)
      .gte('end_date', date),
    fetchAllRows<MachineDayPerson>((from, to) =>
      svc.from('users')
        .select('id, full_name, minop_user_id, is_active, is_deleted, payroll_active, joining_date, exit_date')
        .order('id', { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<MachineDayPunch>((from, to) =>
      svc.from('minop_punches')
        .select('minop_user_id, punch_local, punch_at, first_seen_at')
        .gte('punch_at', istDayStartUtc(date))
        .lte('punch_at', istDayEndUtc(date))
        .order('id', { ascending: true })
        .range(from, to),
    ),
  ])
  if (holidays.error) throw new Error(holidays.error.message)
  if (requests.error) throw new Error(requests.error.message)

  const allPeople = unwrapPagedRows('Employees', people)
  const realPunches = unwrapPagedRows('Minop punches', punches)
    .filter(p => machineDateOf(p.punch_local) === date && isPlausiblePunchTime(p.punch_at, p.first_seen_at))
  const listed = allPeople.filter(p => p.is_active && !p.is_deleted && (p.minop_user_id || p.payroll_active))

  const entries = buildMachineDayEntries({
    date,
    today,
    nowMinutes: istMinutesOfDay(now),
    people: listed,
    punches: realPunches,
    requests: (requests.data ?? []) as unknown as MachineDayRequest[],
    isHoliday: (holidays.data ?? []).some(isFullDayHoliday),
    machineStopped: health.state === 'stopped',
    settings: active.settings,
  })

  const listedIds = new Set(entries.flatMap(e => (e.machineId ? [e.machineId] : [])))
  return {
    date,
    today,
    earliest: earliestMachineDay(today),
    health,
    entries,
    counts: countMachineDay(entries),
    strays: findStrayPunches(realPunches, listedIds, allPeople),
  }
}
