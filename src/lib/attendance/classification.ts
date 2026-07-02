// Shared attendance day classification (Phase 2B).
// Pure classification logic only — no payroll deductions, no monetary values.
// Extracted from src/lib/payroll/engine.ts classifySingleDay() without behaviour change.

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
}

export type ClassifiedDay = {
  classification: AttendanceClassification
  effective_hours_worked: number      // post-lunch-deduction hours; 0 for absent/missing
  missing_punch_type: MissingPunchType | null
  on_office_timing: boolean           // office-timing full-day override applied
  check_in_minutes: number | null     // IST minutes-since-midnight, when known
  check_out_minutes: number | null    // IST minutes-since-midnight, when known
}

// Returns minutes-since-midnight in IST for an ISO timestamptz string.
function istMinutes(ts: string): number {
  const istMs = new Date(ts).getTime() + 330 * 60 * 1000
  const d = new Date(istMs)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

export function classifyAttendanceDay(
  record: AttendanceRecordInput | undefined,
): ClassifiedDay {
  const absent: ClassifiedDay = {
    classification: 'full_absent',
    effective_hours_worked: 0,
    missing_punch_type: null,
    on_office_timing: false,
    check_in_minutes: null,
    check_out_minutes: null,
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
  const lunchDeducted = inMin < 14 * 60 && outMin > 13 * 60
  const effectiveHours = rawHours - (lunchDeducted ? 1 : 0)

  // Office-timing override: punch-in ≤ 10:15 IST and punch-out ≥ 18:30 IST → full day,
  // even if effective hours fall slightly below 7.5 after lunch deduction.
  const onOfficeTiming = inMin <= 10 * 60 + 15 && outMin >= 18 * 60 + 30

  // Classify by effective hours (office-timing takes priority)
  let classification: AttendanceClassification
  if (onOfficeTiming || effectiveHours >= 7.5) {
    classification = 'full_present'
  } else if (effectiveHours >= 5) {
    classification = 'present_with_shortfall'
  } else if (effectiveHours >= 3.75) {
    classification = 'half_day'
  } else if (effectiveHours >= 2) {
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
  }
}
