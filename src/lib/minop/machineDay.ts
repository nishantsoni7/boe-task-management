// One person's machine punches on one IST date, turned into that day's
// attendance row. Pure: it reads no clock and no database.
//
// The rules are the Excel import's, so a day means the same thing from either
// source (src/lib/attendance/punchParser.ts, Format B):
//
//   two or more punches   first and last are the pair. Nothing had to be decided,
//                         so the day is 'confirmed'.
//   one punch             before 14:00 IST it is an arrival, otherwise a departure
//                         (isArrivalByDivider), and the day is 'inferred', so the
//                         engine will not build a lateness charge on it.
//
// The one rule the import does not need: two taps a few minutes apart are one
// punch. A person who taps twice at 10:02 and 10:03 and goes home unrecorded must
// not read as a one-minute day, which the classifier would call an absence. They
// read as an arrival with a missing punch-out, which is what happened.
//
// The machine's `mode` is never used. It is "8" or "IN", mixed on one day, and
// never OUT, so it says nothing about direction.

import { isArrivalByDivider, type PunchDirectionSource } from '../attendance/punchDirection'

/** The first date the machine is the attendance source. Owner decision, 2026-10-30. */
export const MACHINE_ATTENDANCE_FROM = '2026-11-01'

/** Punches closer together than this are one punch, not an arrival and a departure. */
export const DOUBLE_TAP_MINUTES = 5

export type MachineDayPunch = {
  /** UTC instant. */
  punch_at: string
  /** The machine's own IST wall clock: `YYYY-MM-DD HH:mm:ss` or with a `T`. */
  punch_local: string
}

export type MachineDayRow = {
  check_in_at: string | null
  check_out_at: string | null
  status: 'present' | 'checked_in'
  punch_direction_source: PunchDirectionSource
  source: 'minop'
}

/** Is this date one the machine supplies? ISO dates compare as text. */
export function isMachineDate(date: string): boolean {
  return date >= MACHINE_ATTENDANCE_FROM
}

/** The IST calendar date of a punch, read from the machine's own clock. */
export function machineDateOf(punchLocal: string): string {
  return punchLocal.slice(0, 10)
}

function istMinutesOf(punchLocal: string): number {
  return Number(punchLocal.slice(11, 13)) * 60 + Number(punchLocal.slice(14, 16))
}

/** The attendance row for a day's punches, or null when there are none. */
export function buildMachineDay(punches: readonly MachineDayPunch[]): MachineDayRow | null {
  if (punches.length === 0) return null

  const ordered = [...punches].sort((a, b) => Date.parse(a.punch_at) - Date.parse(b.punch_at))
  const first = ordered[0]
  const last = ordered[ordered.length - 1]

  if (Date.parse(last.punch_at) - Date.parse(first.punch_at) >= DOUBLE_TAP_MINUTES * 60_000) {
    return {
      check_in_at: first.punch_at,
      check_out_at: last.punch_at,
      status: 'present',
      punch_direction_source: 'confirmed',
      source: 'minop',
    }
  }

  const arrival = isArrivalByDivider(istMinutesOf(first.punch_local))
  return {
    check_in_at: arrival ? first.punch_at : null,
    check_out_at: arrival ? null : last.punch_at,
    status: 'checked_in',
    punch_direction_source: 'inferred',
    source: 'minop',
  }
}
