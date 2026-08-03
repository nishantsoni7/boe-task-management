// Manual attendance corrections — the override layer, as pure logic.
//
// The precedence rule for a single day, stated once, here:
//
//   raw biometric record  →  current correction (when one exists)  →  effective
//
// A correction carries the COMPLETE effective punch pair for its date, not a
// patch. `corrected_check_in_at: null` therefore means "there is no punch-in on
// this day", never "leave the machine value alone" — which is precisely what an
// admin needs when the machine recorded a punch-out as the punch-in.
//
// Nothing here touches the raw record. The caller reads attendance_records and
// attendance_day_corrections separately and asks this module which values
// payroll should use.

export const DAY_TREATMENTS = ['auto', 'full_day', 'half_day', 'absent'] as const
export type DayTreatment = (typeof DAY_TREATMENTS)[number]

// The deduction types a correction can waive. Kept as local literals rather
// than imported from payroll/types so attendance stays free of a payroll
// dependency — payroll already depends on attendance, not the other way round.
export type WaivableDeductionType =
  | 'late_arrival'
  | 'early_checkout'
  | 'missing_punch_in'
  | 'missing_punch_out'

export type AttendanceDayCorrection = {
  attendance_date: string              // ISO date
  corrected_check_in_at: string | null   // ISO timestamptz
  corrected_check_out_at: string | null  // ISO timestamptz
  day_treatment: DayTreatment
  waive_late_arrival: boolean
  waive_early_checkout: boolean
  waive_missing_punch: boolean
}

export type RawAttendance = {
  check_in_at: string | null
  check_out_at: string | null
}

export type EffectiveAttendance = {
  check_in_at: string | null
  check_out_at: string | null
  /** Where the punches came from — drives the "Corrected" indicator in the UI. */
  source: 'raw' | 'corrected'
}

export function isDayTreatment(value: unknown): value is DayTreatment {
  return typeof value === 'string' && (DAY_TREATMENTS as readonly string[]).includes(value)
}

/**
 * The punches payroll must use for a day.
 *
 * With no correction this is the raw record verbatim (or an empty pair when the
 * machine has nothing for the day at all).
 */
export function resolveEffectiveAttendance(
  raw: RawAttendance | undefined,
  correction: AttendanceDayCorrection | undefined,
): EffectiveAttendance {
  if (correction) {
    return {
      check_in_at:  correction.corrected_check_in_at,
      check_out_at: correction.corrected_check_out_at,
      source: 'corrected',
    }
  }
  return {
    check_in_at:  raw?.check_in_at  ?? null,
    check_out_at: raw?.check_out_at ?? null,
    source: 'raw',
  }
}

/**
 * Deduction types this correction exempts.
 *
 * A treatment other than 'auto' settles the whole day on its own — a forced
 * full day, half day or absence has no late/early/missing-punch line to waive —
 * so the waiver flags only carry meaning under 'auto'.
 */
export function waivedDeductionTypes(
  correction: AttendanceDayCorrection | undefined,
): Set<WaivableDeductionType> {
  const waived = new Set<WaivableDeductionType>()
  if (!correction || correction.day_treatment !== 'auto') return waived
  if (correction.waive_late_arrival)   waived.add('late_arrival')
  if (correction.waive_early_checkout) waived.add('early_checkout')
  if (correction.waive_missing_punch) {
    waived.add('missing_punch_in')
    waived.add('missing_punch_out')
  }
  return waived
}

// A day carries the "Corrected" indicator whenever a current correction exists
// for it, not only when the punches differ: an admin who reviewed a date and
// recorded a remark has overridden it, even if they confirmed the machine was
// right. That decision lives in the engine's `is_corrected` flag.
