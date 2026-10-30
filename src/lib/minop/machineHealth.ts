// Is the attendance machine sending?
//
// The machine has no heartbeat BOE can see (Say Hello has never fired), so the
// only evidence is a punch reaching BOE. A quiet morning is not always a fault,
// which keeps the rule narrow. The machine has stopped when ALL of these hold:
//
//   it is a working day, from MACHINE_ATTENDANCE_FROM on (not a Sunday or a holiday)
//   it is past 11:00 IST (the office opens at 10:00)
//   no real punch has reached BOE since midnight
//
// "Reached" is first_seen_at, not the punch's own time: a late punch from
// yesterday arriving this morning still proves the machine is connected. Minop's
// sample message has an impossible time and proves nothing, so it is not counted.
//
// A slow machine can trip this too. On 28 Oct some punches took over two hours.
// The alert asks someone to look; it decides nothing, and no attendance depends
// on it. It clears by itself on the next punch.
//
// Pure apart from the two readers and sendMachineStoppedAlert, so the screen can
// import the labels.

import type { SupabaseClient } from '@supabase/supabase-js'
import { isWeeklyOff } from '../attendance/monthCalendar'
import { istDateOf, istDayStartUtc, istMinutesOfDay, istToday } from '../istDate'
import { isMachineDate } from './machineDay'
import { isPlausiblePunchTime } from './punches'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Service = SupabaseClient<any, any, any>

/** IST minutes past midnight. By now somebody has punched on a working day. */
export const MACHINE_STOPPED_AFTER_MINUTES = 11 * 60

/** How many recent punches to look through for a real one. A sample message is two rows. */
const RECENT_PUNCHES = 50

export const MACHINE_STOPPED_NOTIFICATION_TYPE = 'attendance_machine_stopped'

export type MachineHealthState = 'sending' | 'waiting' | 'day_off' | 'stopped'

export type LatestPunch = {
  /** When it was punched. */
  punchAt: string
  /** When it reached BOE. */
  reachedAt: string
}

export type MachineHealth = {
  state: MachineHealthState
  /** The IST date this was judged on. */
  today: string
  lastPunch: LatestPunch | null
}

export function judgeMachineHealth(input: {
  now: Date
  lastPunch: LatestPunch | null
  isHoliday: boolean
}): MachineHealth {
  const { now, lastPunch, isHoliday } = input
  const today = istToday(now)
  const judged = (state: MachineHealthState): MachineHealth => ({ state, today, lastPunch })

  if (lastPunch && istDateOf(lastPunch.reachedAt) === today) return judged('sending')
  if (isWeeklyOff(today) || isHoliday) return judged('day_off')
  if (!isMachineDate(today) || istMinutesOfDay(now) < MACHINE_STOPPED_AFTER_MINUTES) return judged('waiting')
  return judged('stopped')
}

/** A half-day holiday still has people at work, so only a full day counts. */
export function isFullDayHoliday(row: { holiday_type?: string | null }): boolean {
  return (row.holiday_type ?? 'full_day') === 'full_day'
}

function clockOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
  })
}

/** "10:42 am" today, "Mon 2 Nov, 06:52 pm" on any other day. */
export function formatPunchMoment(iso: string, today: string): string {
  if (istDateOf(iso) === today) return clockOf(iso)
  const day = new Date(iso).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata',
  })
  return `${day.replace(',', '')}, ${clockOf(iso)}`
}

/** How long a punch took to reach BOE, in the words after "reached BOE". */
export function punchLagLabel(punch: LatestPunch): string {
  const minutes = Math.max(0, Math.round((Date.parse(punch.reachedAt) - Date.parse(punch.punchAt)) / 60_000))
  if (minutes < 1) return 'within a minute'
  if (minutes === 1) return '1 minute later'
  if (minutes < 60) return `${minutes} minutes later`
  const hours = Math.round(minutes / 60)
  if (hours === 1) return '1 hour later'
  if (hours < 48) return `${hours} hours later`
  return `${Math.round(hours / 24)} days later`
}

/** The newest real punch to reach BOE, or null when none ever has. */
export async function readLatestPunch(svc: Service): Promise<LatestPunch | null> {
  const { data, error } = await svc.from('minop_punches')
    .select('punch_at, first_seen_at')
    .order('first_seen_at', { ascending: false })
    .order('punch_at', { ascending: false })
    .limit(RECENT_PUNCHES)
  if (error) throw new Error(error.message)

  const rows = (data ?? []) as { punch_at: string; first_seen_at: string }[]
  const real = rows.find(p => isPlausiblePunchTime(p.punch_at, p.first_seen_at))
  return real ? { punchAt: real.punch_at, reachedAt: real.first_seen_at } : null
}

export async function readMachineHealth(svc: Service, now: Date = new Date()): Promise<MachineHealth> {
  const [lastPunch, holidays] = await Promise.all([
    readLatestPunch(svc),
    svc.from('payroll_holidays').select('holiday_date, holiday_type').eq('holiday_date', istToday(now)),
  ])
  if (holidays.error) throw new Error(holidays.error.message)
  return judgeMachineHealth({ now, lastPunch, isHoliday: (holidays.data ?? []).some(isFullDayHoliday) })
}

export function machineStoppedMessage(health: MachineHealth): { title: string; body: string } {
  const last = health.lastPunch ? ` Last one ${formatPunchMoment(health.lastPunch.punchAt, health.today)}.` : ''
  return {
    title: 'Machine has stopped sending',
    body: `No punch has reached BOE today.${last} Check the machine has power and Wi-Fi, and that the Minop subscription is active.`,
  }
}

/**
 * Tells every active admin, once a day. A second run the same day sends nothing,
 * so a repeated cron call is harmless. Returns how many were told.
 *
 * REQUIRES 20270511000000 (the enum value).
 */
export async function sendMachineStoppedAlert(svc: Service, health: MachineHealth): Promise<number> {
  if (health.state !== 'stopped') return 0

  const admins = await svc.from('users').select('id').eq('role', 'admin').eq('is_active', true)
  if (admins.error) throw new Error(admins.error.message)
  const adminIds = ((admins.data ?? []) as { id: string }[]).map(a => a.id)
  if (adminIds.length === 0) return 0

  const told = await svc.from('notifications')
    .select('user_id')
    .eq('type', MACHINE_STOPPED_NOTIFICATION_TYPE)
    .gte('created_at', istDayStartUtc(health.today))
    .in('user_id', adminIds)
  if (told.error) throw new Error(told.error.message)
  const alreadyTold = new Set(((told.data ?? []) as { user_id: string }[]).map(n => n.user_id))

  const message = machineStoppedMessage(health)
  const rows = adminIds
    .filter(id => !alreadyTold.has(id))
    .map(id => ({ user_id: id, type: MACHINE_STOPPED_NOTIFICATION_TYPE, ...message }))
  if (rows.length === 0) return 0

  const { error } = await svc.from('notifications').insert(rows)
  if (error) throw new Error(error.message)
  return rows.length
}
