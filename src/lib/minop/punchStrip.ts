// The punch-in strip at the top of the Modules page: what a person's own
// punches today say to them (owner, 2026-11-07).
//
//   punched in      green, or amber when late, for 30 minutes
//   not punched in  red from the end of the grace period, all day, until they
//                   punch or hide it on their own device
//
// The aim is that nobody can say they missed the punch, so the strip must never
// be wrong in the other direction: it says nothing at all whenever BOE cannot
// honestly say "no punch". That is
//
//   no Machine ID (the machine cannot see them), inactive, not yet joined or gone
//   a Sunday, a holiday (a half-day holiday too: the working half is unknown),
//     or an approved request of any kind that day
//   the machine has stopped sending (machineHealth.ts), so the silence is its
//     fault, not theirs
//   the day's only punch is a departure (after 14:00): they did punch
//
// THE SERVER DECIDES, THE DEVICE ONLY DRAWS. The answer carries the IST date and
// the time left, so a wrong phone clock can neither keep the strip up nor hide
// it. It reads only the caller's own punches: the route passes the caller's id
// from the bearer token and takes no id from the request.
//
// Rules shared with the admin's Today tab: buildMachineDay (the day's arrival),
// the 10:15 grace end and lateness counted from 10:00 (machineDayView.ts), and
// isPlausiblePunchTime (Minop's 2018 sample message is not a punch).
//
// shortcut: a half-day holiday silences the red strip all day, and lateness is
// not shown on it; upgrade when the first-half/second-half arrival time is wanted.

import type { SupabaseClient } from '@supabase/supabase-js'
import { isWeeklyOff } from '../attendance/monthCalendar'
import { istDayEndUtc, istDayStartUtc, istMinutesOfDay, istToday } from '../istDate'
import type { PayrollSettings } from '../payroll/settings'
import { fetchActiveSettings } from '../payroll/settingsStore'
import { buildMachineDay, isMachineDate, machineDateOf, type MachineDayPunch } from './machineDay'
import { clockLabel } from './machineDayView'
import { judgeMachineHealth, readLatestPunch } from './machineHealth'
import { isPlausiblePunchTime } from './punches'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Service = SupabaseClient<any, any, any>

/** How long the green or amber strip shows after the punch (owner, 2026-11-07). */
export const PUNCH_STRIP_SHOW_MINUTES = 30

export type PunchStripTone = 'on_time' | 'late' | 'missing'

export type PunchStrip = {
  /** The IST date this answers for. "Hide for today" is remembered against it. */
  today: string
  /** Null: draw nothing. */
  tone: PunchStripTone | null
  title: string
  detail: string
  /** Milliseconds left, counted from this response. Null for the red strip, which stays. */
  showForMs: number | null
}

export type PunchStripPerson = {
  minop_user_id: string | null
  is_active: boolean | null
  is_deleted: boolean | null
  joining_date: string | null
  exit_date: string | null
}

export type PunchStripPunch = {
  punch_at: string
  punch_local: string
  first_seen_at: string
}

export type PunchStripInput = {
  now: Date
  person: PunchStripPerson
  /** This person's real punches whose machine date is today. */
  punches: PunchStripPunch[]
  /** Any holiday row today, full or half day. */
  holiday: boolean
  /** An approved attendance request of any kind covers today. */
  approved: boolean
  machineStopped: boolean
  settings: Pick<PayrollSettings, 'scheduled_in_minutes' | 'grace_end_minutes'>
}

/** The answer that draws nothing. */
export function silentStrip(today: string): PunchStrip {
  return { today, tone: null, title: '', detail: '', showForMs: null }
}

const minutes = (n: number) => `${n} ${n === 1 ? 'minute' : 'minutes'}`

export function judgePunchStrip(input: PunchStripInput): PunchStrip {
  const { now, person, punches, settings } = input
  const today = istToday(now)
  const silent = silentStrip(today)

  if (!person.minop_user_id || !person.is_active || person.is_deleted) return silent
  if (!isMachineDate(today)) return silent
  if ((person.joining_date && today < person.joining_date) || (person.exit_date && today >= person.exit_date)) return silent

  const dayOff = isWeeklyOff(today) || input.holiday
  const officeStart = clockLabel(settings.scheduled_in_minutes)

  if (punches.length > 0) {
    const arrival = buildMachineDay(punches as MachineDayPunch[])?.check_in_at
    // A lone punch after 14:00 is a departure, so there is no arrival to show, but they did punch.
    if (!arrival) return silent

    const earliest = [...punches].sort((a, b) => Date.parse(a.punch_at) - Date.parse(b.punch_at))[0]
    // From the later of the punch and the moment BOE received it, so a late delivery still shows.
    const hideAt = Math.max(Date.parse(arrival), Date.parse(earliest.first_seen_at)) + PUNCH_STRIP_SHOW_MINUTES * 60_000
    const left = hideAt - now.getTime()
    if (left <= 0) return silent

    const inMinutes = istMinutesOfDay(arrival)
    const lateBy = !dayOff && inMinutes > settings.grace_end_minutes ? inMinutes - settings.scheduled_in_minutes : null
    const goesAway = `This note goes away at ${clockLabel(istMinutesOfDay(hideAt))}.`

    return {
      today,
      tone: lateBy === null ? 'on_time' : 'late',
      title: `You punched in at ${clockLabel(inMinutes)}`,
      detail: lateBy === null
        ? `On time. ${goesAway}`
        : `Late by ${minutes(lateBy)}, counted from ${officeStart}. ${goesAway}`,
      showForMs: left,
    }
  }

  if (dayOff || input.approved || input.machineStopped) return silent
  if (istMinutesOfDay(now) < settings.grace_end_minutes) return silent

  return {
    today,
    tone: 'missing',
    title: 'No punch-in recorded for you today',
    detail: `Office opened at ${officeStart}. Punch on the machine; it shows here within a few minutes.`,
    showForMs: null,
  }
}

/**
 * One person's strip. A failed read throws: the route answers 500 and the page
 * shows nothing, never a guess. Reads a stranger's data in no case: `userId`
 * is the caller's own, from the bearer token.
 */
export async function readPunchStrip(svc: Service, userId: string, now: Date = new Date()): Promise<PunchStrip> {
  const today = istToday(now)

  const personRead = await svc.from('users')
    .select('minop_user_id, is_active, is_deleted, joining_date, exit_date')
    .eq('id', userId)
    .maybeSingle()
  if (personRead.error) throw new Error(personRead.error.message)
  const person = personRead.data as PunchStripPerson | null
  // Nobody to say anything to: skip the other reads.
  if (!person?.minop_user_id || !person.is_active || person.is_deleted) return silentStrip(today)

  const [active, holidays, requests, lastPunch, punches] = await Promise.all([
    fetchActiveSettings(svc),
    svc.from('payroll_holidays').select('holiday_date').eq('holiday_date', today),
    svc.from('attendance_requests')
      .select('id')
      .eq('employee_id', userId)
      .eq('status', 'approved')
      .lte('start_date', today)
      .gte('end_date', today)
      .limit(1),
    readLatestPunch(svc),
    svc.from('minop_punches')
      .select('punch_at, punch_local, first_seen_at')
      .eq('minop_user_id', person.minop_user_id)
      .gte('punch_at', istDayStartUtc(today))
      .lte('punch_at', istDayEndUtc(today))
      .order('punch_at', { ascending: true }),
  ])
  if (holidays.error) throw new Error(holidays.error.message)
  if (requests.error) throw new Error(requests.error.message)
  if (punches.error) throw new Error(punches.error.message)

  const holiday = (holidays.data ?? []).length > 0
  const own = ((punches.data ?? []) as PunchStripPunch[])
    .filter(p => machineDateOf(p.punch_local) === today && isPlausiblePunchTime(p.punch_at, p.first_seen_at))

  return judgePunchStrip({
    now,
    person,
    punches: own,
    holiday,
    approved: (requests.data ?? []).length > 0,
    machineStopped: judgeMachineHealth({ now, lastPunch, isHoliday: holiday }).state === 'stopped',
    settings: active.settings,
  })
}
