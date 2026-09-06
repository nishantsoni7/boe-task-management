// Turning one validated Minop punch event into an attendance decision.
//
// This is the convergence point Phase C5 requires: it decides WHAT to write,
// reusing the exact classification the CSV import route already uses to tell
// "nothing to write" from "a real change" — src/lib/attendance/punchParser.ts
// `attendanceRowChange` — so a Minop-authored row and a CSV-authored row are
// judged by one rule, not two. It performs no I/O itself: everything it needs
// (the mapping candidates, the existing row, whether the month is locked) is
// read by the caller and handed in, which is what makes every branch below
// testable without a database.

import { istDateOf } from '../istDate'
import { attendanceRowChange } from '../attendance/punchParser'
import type { PunchDirectionSource } from '../attendance/punchDirection'
import { resolveMinopEmployee, type MinopEmployeeCandidate } from './employeeMapping'
import { mergeMinopPunch, type ExistingAttendancePunches } from './attendanceMerge'
import type { SupportedPunchType } from './punchEvent'

export type ExistingAttendanceRow = ExistingAttendancePunches & {
  punch_direction_source: string | null
}

export type MinopAttendanceOutcome =
  | { status: 'unmapped' }
  | { status: 'mapping_conflict' }
  /** The code matched exactly one employee, so `userId` is known even though
   *  no attendance was posted for them — useful to an admin deciding whether
   *  this is expected (an exited employee's old badge) or not. */
  | { status: 'inactive_employee'; userId: string }
  | { status: 'payroll_locked'; userId: string }
  | {
      status: 'processed'
      userId: string
      attendanceDate: string
      /** False when the merge changed nothing (an exact repeat, or a punch
       *  that loses to first-in/last-out) — the caller need not write. */
      write: boolean
      row: {
        check_in_at: string | null
        check_out_at: string | null
        status: 'present' | 'checked_in'
        punch_direction_source: PunchDirectionSource
        source: 'minop'
      }
    }

export type PayrollLockCheck = { locked: boolean }

/**
 * Decide the attendance outcome of one supported (CheckIn/CheckOut) Minop
 * punch event, already validated by parseMinopPunchEvent.
 */
export function computeMinopAttendanceOutcome(input: {
  minopUserId: string
  type: SupportedPunchType
  logTimeUtc: string
  candidates: MinopEmployeeCandidate[]
  /** The stored row for (resolved user, attendance date), if any. */
  existingRow: ExistingAttendanceRow | null
  payrollLock: PayrollLockCheck
}): MinopAttendanceOutcome {
  const mapping = resolveMinopEmployee(input.minopUserId, input.candidates)
  if (!mapping.ok) {
    return mapping.reason === 'inactive_employee'
      ? { status: 'inactive_employee', userId: mapping.userId }
      : { status: mapping.reason }
  }

  // Existing payroll locks win outright — a late Minop callback for an
  // already-finalised month must never rewrite it, and the raw delivery
  // stays as the record that a punch arrived and was refused for that
  // reason, exactly as a late CSV correction is refused today.
  if (input.payrollLock.locked) return { status: 'payroll_locked', userId: mapping.userId }

  const attendanceDate = istDateOf(input.logTimeUtc)

  const existingPunches: ExistingAttendancePunches = input.existingRow
    ? { check_in_at: input.existingRow.check_in_at, check_out_at: input.existingRow.check_out_at }
    : { check_in_at: null, check_out_at: null }

  const merged = mergeMinopPunch(existingPunches, { type: input.type, timeUtc: input.logTimeUtc })

  const complete = merged.check_in_at !== null && merged.check_out_at !== null
  // Minop states the direction of every punch it sends — unlike a CSV Format B
  // cell with one ambiguous time, there is nothing here to infer. See
  // src/lib/attendance/punchDirection.ts.
  const nextRow = {
    check_in_at: merged.check_in_at,
    check_out_at: merged.check_out_at,
    status: (complete ? 'present' : 'checked_in') as 'present' | 'checked_in',
    punch_direction_source: 'confirmed' as PunchDirectionSource,
    source: 'minop' as const,
  }

  // Reuse the CSV importer's own "did anything actually change" rule, so a
  // Minop retry and a re-imported CSV row are judged identically: a repeat
  // that lands on the exact same minute is not a write.
  const change = input.existingRow
    ? attendanceRowChange(
        { check_in_at: nextRow.check_in_at, check_out_at: nextRow.check_out_at, direction_source: nextRow.punch_direction_source },
        { check_in_at: input.existingRow.check_in_at, check_out_at: input.existingRow.check_out_at, punch_direction_source: input.existingRow.punch_direction_source },
      )
    : null

  return {
    status: 'processed',
    userId: mapping.userId,
    attendanceDate,
    write: change ? change.changed : true,
    row: nextRow,
  }
}
