// Merging one live Minop punch into a day's attendance row.
//
// A CSV block already carries the whole day in one cell and a proven rule for
// several punches inside it: "with two or more punches the first and last are
// the pair" (src/lib/attendance/punchDirection.ts). A live device delivers
// the same day one punch at a time, arriving in whatever order the network
// gives them, so Stage 2 needs the incremental form of that identical rule:
//
//   CheckIn  → the EARLIEST CheckIn of the day is the arrival. A later CheckIn
//              (a re-entry after stepping out, a retry) never overwrites an
//              arrival already recorded.
//   CheckOut → the LATEST CheckOut of the day is the departure. Each new,
//              later CheckOut replaces the one before it.
//
// This is also what makes the merge naturally idempotent: replaying the exact
// same event twice (a Minop retry, or an admin's manual reprocess) recomputes
// the identical earliest-in / latest-out and changes nothing.
//
// Nothing here touches the database or knows about delivery rows, mapping, or
// payroll locks — it is given "what the day currently looks like" and "one
// new punch" and answers "what the day should look like now".

import type { SupportedPunchType } from './punchEvent'

export type ExistingAttendancePunches = {
  check_in_at: string | null
  check_out_at: string | null
}

export type MergedAttendancePunches = {
  check_in_at: string | null
  check_out_at: string | null
  /** False when the new punch changes neither timestamp — an exact repeat, or
   *  a CheckIn that is not earlier than one already recorded, or a CheckOut
   *  that is not later than one already recorded. */
  changed: boolean
}

/** Apply one punch on top of a day's current punches. */
export function mergeMinopPunch(
  existing: ExistingAttendancePunches,
  punch: { type: SupportedPunchType; timeUtc: string },
): MergedAttendancePunches {
  const newMs = Date.parse(punch.timeUtc)

  if (punch.type === 'CheckIn') {
    const currentMs = existing.check_in_at ? Date.parse(existing.check_in_at) : null
    const earlier = currentMs === null || newMs < currentMs
    return {
      check_in_at: earlier ? punch.timeUtc : existing.check_in_at,
      check_out_at: existing.check_out_at,
      changed: earlier,
    }
  }

  // CheckOut
  const currentMs = existing.check_out_at ? Date.parse(existing.check_out_at) : null
  const later = currentMs === null || newMs > currentMs
  return {
    check_in_at: existing.check_in_at,
    check_out_at: later ? punch.timeUtc : existing.check_out_at,
    changed: later,
  }
}
