// Shared attendance day classification (Phase 2B).
// Pure classification logic only — no payroll deductions, no monetary values.
// Extracted from src/lib/payroll/engine.ts classifySingleDay() without behaviour change.

import { resolveDirectionSource, type PunchDirectionSource } from './punchDirection'
import { DEFAULT_PAYROLL_SETTINGS, type PayrollSettings } from '../payroll/settings'

export type AttendanceClassification =
  | 'full_present'
  | 'present_with_shortfall'
  | 'short_present'
  | 'half_day'
  | 'full_absent'
  | 'missing_punch'

export type MissingPunchType = 'missing_punch_in' | 'missing_punch_out'

export type AttendanceRecordInput = {
  check_in_at: string | null   // ISO timestamptz
  check_out_at: string | null  // ISO timestamptz
  /**
   * How the IN/OUT split for this day was established. Optional because most
   * callers have no opinion; absent is read as 'inferred', the cautious value.
   * See ./punchDirection for why the distinction is carried this far.
   */
  direction_source?: PunchDirectionSource | null
}

export type ClassifiedDay = {
  classification: AttendanceClassification
  effective_hours_worked: number      // post-lunch-deduction hours; 0 for absent/missing
  missing_punch_type: MissingPunchType | null
  on_office_timing: boolean           // office-timing full-day override applied
  check_in_minutes: number | null     // IST minutes-since-midnight, when known
  check_out_minutes: number | null    // IST minutes-since-midnight, when known
  /**
   * Resolved provenance of the IN/OUT split — never null, so a consumer cannot
   * forget to apply the default. Only meaningful when exactly one punch is
   * present; a complete pair required no decision.
   */
  direction_source: PunchDirectionSource
}

// Returns minutes-since-midnight in IST for an ISO timestamptz string.
function istMinutes(ts: string): number {
  const istMs = new Date(ts).getTime() + 330 * 60 * 1000
  const d = new Date(istMs)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

/**
 * Classify one day.
 *
 * `settings` carries the thresholds and the office clock. It defaults to
 * DEFAULT_PAYROLL_SETTINGS — which IS the constant set this function used to
 * import directly — so every caller that has no opinion behaves exactly as it
 * did before settings existed. Payroll generation passes the period's snapshot
 * instead, which is what keeps an already-generated month from restating itself
 * when an admin edits a rule.
 */
export function classifyAttendanceDay(
  record: AttendanceRecordInput | undefined,
  settings: PayrollSettings = DEFAULT_PAYROLL_SETTINGS,
): ClassifiedDay {
  const directionSource = resolveDirectionSource(record?.direction_source)

  const absent: ClassifiedDay = {
    classification: 'full_absent',
    effective_hours_worked: 0,
    missing_punch_type: null,
    on_office_timing: false,
    check_in_minutes: null,
    check_out_minutes: null,
    direction_source: directionSource,
  }

  // No record or both punches missing → full_absent
  if (!record || (record.check_in_at == null && record.check_out_at == null)) return absent

  // Missing punch: exactly one punch present.
  if (record.check_in_at == null || record.check_out_at == null) {
    const missingType: MissingPunchType = record.check_in_at == null ? 'missing_punch_in' : 'missing_punch_out'
    return {
      classification: 'missing_punch',
      effective_hours_worked: 0,
      missing_punch_type: missingType,
      on_office_timing: false,
      check_in_minutes: record.check_in_at != null ? istMinutes(record.check_in_at) : null,
      check_out_minutes: record.check_out_at != null ? istMinutes(record.check_out_at) : null,
      direction_source: directionSource,
    }
  }

  const inMs  = new Date(record.check_in_at).getTime()
  const outMs = new Date(record.check_out_at).getTime()

  // Corrupt record: check_out before check_in → full_absent
  if (outMs <= inMs) return absent

  const rawHours = (outMs - inMs) / 3_600_000

  // Lunch deduction: subtract 1h if check_in < 14:00 AND check_out > 13:00 (IST)
  const inMin  = istMinutes(record.check_in_at)
  const outMin = istMinutes(record.check_out_at)
  const lunchDeducted = inMin < settings.lunch_in_before_minutes && outMin > settings.lunch_out_after_minutes
  const effectiveHours = rawHours - (lunchDeducted ? settings.lunch_hours : 0)

  // Office-timing override: punch-in within grace and punch-out at or after the
  // scheduled close → full day, even if effective hours fall slightly below the
  // full-present threshold after the lunch deduction.
  const onOfficeTiming = inMin <= settings.grace_end_minutes && outMin >= settings.scheduled_out_minutes

  // Classify by effective hours (office-timing takes priority)
  let classification: AttendanceClassification
  if (onOfficeTiming || effectiveHours >= settings.threshold_full_present_hours) {
    classification = 'full_present'
  } else if (effectiveHours >= settings.threshold_present_with_shortfall_hours) {
    classification = 'present_with_shortfall'
  } else if (effectiveHours >= settings.threshold_half_day_hours) {
    classification = 'half_day'
  } else if (effectiveHours >= settings.threshold_short_present_hours) {
    classification = 'short_present'
  } else {
    return { ...absent }
  }

  return {
    classification,
    effective_hours_worked: effectiveHours,
    missing_punch_type: null,
    on_office_timing: onOfficeTiming,
    check_in_minutes: inMin,
    check_out_minutes: outMin,
    // Both punches are present, so nothing about the direction was decided.
    // Reported as 'confirmed' regardless of what the caller passed, which keeps
    // late-arrival and early-departure on complete days exactly as they were.
    direction_source: 'confirmed',
  }
}
