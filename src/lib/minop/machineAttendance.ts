// Writes attendance_records from the punches in minop_punches.
//
// Every write works out the whole day again from all of that day's punches, so
// the result never depends on the order punches arrive in. That matters because
// the machine holds punches and sends them hours or days later.
//
// Who may reach here:
//   - the webhook, for the people and dates in the message it just stored;
//   - the nightly sync, which repairs anything the webhook missed (recording is
//     best-effort there) and picks up people linked after they punched;
//   - Employee Master, when a Machine ID is saved.
//
// What it leaves alone: dates before MACHINE_ATTENDANCE_FROM, machine IDs linked
// to nobody, people who are inactive or deleted, and payroll months that are
// locked. A row that would not change is not written, because a written row moves
// updated_at and that marks a generated payroll month as out of date.
//
// It writes only attendance_records. Corrections stay in their own overlay and
// the payroll engine reads this table whatever filled it.

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows, unwrapPagedRows } from '../supabasePaging'
import { MACHINE_ATTENDANCE_FROM, buildMachineDay, isMachineDate, machineDateOf, type MachineDayRow } from './machineDay'
import {
  deviceTimeToUtcIso,
  extractMinopPunches,
  isPlausiblePunchTime,
  mergePunchRows,
  type MinopPunchWithFirstSeen,
} from './punches'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Service = SupabaseClient<any, any, any>

type StoredPunch = {
  minop_user_id: string
  punch_local: string
  punch_at: string
  first_seen_at: string
}

type LinkedUser = {
  id: string
  minop_user_id: string
  is_active: boolean | null
  is_deleted: boolean | null
}

type ExistingDay = {
  user_id: string
  attendance_date: string
  check_in_at: string | null
  check_out_at: string | null
  punch_direction_source: string | null
  source: string | null
}

export type MachineWrite = MachineDayRow & { user_id: string; attendance_date: string }

export type MachineRebuildResult = {
  written: number
  unchanged: number
  /** Machine IDs in the window that belong to nobody. */
  unlinked: string[]
  skippedInactive: number
  skippedLocked: number
}

export type MachineDayPlanInput = {
  punches: StoredPunch[]
  users: LinkedUser[]
  lockedMonths: Set<string>
  existing: ExistingDay[]
}

const monthOf = (date: string) => date.slice(0, 7)

/** One timestamp against another: the same instant in either spelling is unchanged. */
function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b
  return Date.parse(a) === Date.parse(b)
}

function isUnchanged(next: MachineDayRow, stored: ExistingDay | undefined): boolean {
  return !!stored
    && stored.source === next.source
    && stored.punch_direction_source === next.punch_direction_source
    && sameInstant(stored.check_in_at, next.check_in_at)
    && sameInstant(stored.check_out_at, next.check_out_at)
}

/** The decision, with no database: which rows to write, and what was left alone and why. */
export function planMachineDays(input: MachineDayPlanInput): { writes: MachineWrite[]; result: MachineRebuildResult } {
  const usersById = new Map(input.users.map(u => [u.minop_user_id, u]))
  const existingByKey = new Map(input.existing.map(e => [`${e.user_id}|${e.attendance_date}`, e]))

  const days = new Map<string, { minopUserId: string; date: string; punches: StoredPunch[] }>()
  for (const punch of input.punches) {
    const date = machineDateOf(punch.punch_local)
    if (!isMachineDate(date) || !isPlausiblePunchTime(punch.punch_at, punch.first_seen_at)) continue
    const key = `${punch.minop_user_id}|${date}`
    const day = days.get(key) ?? { minopUserId: punch.minop_user_id, date, punches: [] }
    day.punches.push(punch)
    days.set(key, day)
  }

  const writes: MachineWrite[] = []
  const unlinked = new Set<string>()
  const result: MachineRebuildResult = { written: 0, unchanged: 0, unlinked: [], skippedInactive: 0, skippedLocked: 0 }

  for (const day of days.values()) {
    const user = usersById.get(day.minopUserId)
    if (!user) { unlinked.add(day.minopUserId); continue }
    if (!user.is_active || user.is_deleted) { result.skippedInactive += 1; continue }
    if (input.lockedMonths.has(monthOf(day.date))) { result.skippedLocked += 1; continue }

    const row = buildMachineDay(day.punches)
    if (!row) continue
    if (isUnchanged(row, existingByKey.get(`${user.id}|${day.date}`))) { result.unchanged += 1; continue }
    writes.push({ ...row, user_id: user.id, attendance_date: day.date })
  }

  result.written = writes.length
  result.unlinked = [...unlinked].sort()
  return { writes, result }
}

/** Instant bounds of an inclusive IST date range. */
function windowBounds(from: string, to: string): { start: string; end: string } {
  const start = deviceTimeToUtcIso(`${from} 00:00:00`)
  const lastInstant = deviceTimeToUtcIso(`${to} 00:00:00`)
  if (!start || !lastInstant) throw new Error(`Invalid machine attendance window: ${from} to ${to}`)
  return { start, end: new Date(Date.parse(lastInstant) + 86_400_000).toISOString() }
}

/**
 * Works out every machine day in an inclusive IST date range and writes the ones
 * that changed. Pass `minopUserIds` to limit it to those people. A failed read or
 * write throws; the caller decides whether that may stop anything.
 */
export async function rebuildMachineDays(
  svc: Service,
  range: { from: string; to: string; minopUserIds?: string[] },
): Promise<MachineRebuildResult> {
  const from = range.from < MACHINE_ATTENDANCE_FROM ? MACHINE_ATTENDANCE_FROM : range.from
  const empty: MachineRebuildResult = { written: 0, unchanged: 0, unlinked: [], skippedInactive: 0, skippedLocked: 0 }
  if (from > range.to) return empty

  const { start, end } = windowBounds(from, range.to)
  const ids = range.minopUserIds
  const punches = unwrapPagedRows('Minop punches', await fetchAllRows<StoredPunch>((pageFrom, pageTo) => {
    const query = svc.from('minop_punches')
      .select('minop_user_id, punch_local, punch_at, first_seen_at')
      .gte('punch_at', start)
      .lt('punch_at', end)
    return (ids ? query.in('minop_user_id', ids) : query)
      .order('id', { ascending: true })
      .range(pageFrom, pageTo)
  }))
  if (punches.length === 0) return empty

  const machineIds = [...new Set(punches.map(p => p.minop_user_id))]
  const users = await svc.from('users')
    .select('id, minop_user_id, is_active, is_deleted')
    .in('minop_user_id', machineIds)
  if (users.error) throw new Error(`Could not read Machine IDs: ${users.error.message}`)
  const linked = (users.data ?? []) as LinkedUser[]

  const months = [...new Set(punches.map(p => monthOf(machineDateOf(p.punch_local))))]
  const lockedMonths = new Set<string>()
  for (const month of months) {
    const { data, error } = await svc.from('payroll_periods')
      .select('status')
      .eq('payroll_year', Number(month.slice(0, 4)))
      .eq('payroll_month', Number(month.slice(5, 7)))
      .maybeSingle()
    if (error) throw new Error(`Could not read payroll lock status: ${error.message}`)
    if (data?.status === 'locked') lockedMonths.add(month)
  }

  const userIds = linked.map(u => u.id)
  const existing = userIds.length === 0 ? [] : unwrapPagedRows('attendance', await fetchAllRows<ExistingDay>((pageFrom, pageTo) =>
    svc.from('attendance_records')
      .select('user_id, attendance_date, check_in_at, check_out_at, punch_direction_source, source')
      .in('user_id', userIds)
      .gte('attendance_date', from)
      .lte('attendance_date', range.to)
      .order('id', { ascending: true })
      .range(pageFrom, pageTo),
  ))

  const { writes, result } = planMachineDays({ punches, users: linked, lockedMonths, existing })
  if (writes.length > 0) {
    const { error } = await svc.from('attendance_records').upsert(writes, { onConflict: 'user_id,attendance_date' })
    if (error) throw new Error(`Could not write attendance: ${error.message}`)
  }
  return result
}

/** The people and dates in one stored message, as a range for rebuildMachineDays. */
export function machineRangeOf(payload: unknown): { from: string; to: string; minopUserIds: string[] } | null {
  const punches = extractMinopPunches(payload).filter(p => isMachineDate(machineDateOf(p.punch_local)))
  if (punches.length === 0) return null
  const dates = punches.map(p => machineDateOf(p.punch_local)).sort()
  return {
    from: dates[0],
    to: dates[dates.length - 1],
    minopUserIds: [...new Set(punches.map(p => p.minop_user_id))],
  }
}

/** The earliest date the nightly sync looks at: the start of last month, or the start date. */
export function machineSyncFrom(today: string): string {
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  const previous = month === 1 ? `${year - 1}-12-01` : `${year}-${String(month - 1).padStart(2, '0')}-01`
  return previous < MACHINE_ATTENDANCE_FROM ? MACHINE_ATTENDANCE_FROM : previous
}

/**
 * The nightly repair: copies any stored message's punches that the webhook failed
 * to record, then works out every day again. Safe to run at any time and any
 * number of times.
 */
export async function syncMachineAttendance(svc: Service, today: string): Promise<MachineRebuildResult & { punchesRecorded: number }> {
  const from = machineSyncFrom(today)
  const start = deviceTimeToUtcIso(`${from} 00:00:00`)
  if (!start) throw new Error(`Invalid machine sync date: ${from}`)

  const deliveries = unwrapPagedRows('Minop messages', await fetchAllRows<{ received_at: string; payload: unknown }>((pageFrom, pageTo) =>
    svc.from('minop_webhook_deliveries')
      .select('received_at, payload')
      .eq('processing_status', 'received')
      .gte('received_at', start)
      .order('id', { ascending: true })
      .range(pageFrom, pageTo),
  ))

  const rows: MinopPunchWithFirstSeen[] = mergePunchRows(
    deliveries.flatMap(d => extractMinopPunches(d.payload).map(p => ({ ...p, first_seen_at: d.received_at }))),
  ).filter(p => isMachineDate(machineDateOf(p.punch_local)))

  if (rows.length > 0) {
    const { error } = await svc.from('minop_punches').upsert(rows, {
      onConflict: 'dvc_id,minop_user_id,punch_local',
      ignoreDuplicates: true,
    })
    if (error) throw new Error(`Could not record Minop punches: ${error.message}`)
  }

  return { ...await rebuildMachineDays(svc, { from, to: today }), punchesRecorded: rows.length }
}
