// Attendance-correction guards and audit shaping.
//
// Pure, so the three rules that decide whether a correction may be saved at all
// — who, when, and with what stated reason — can be tested without a database
// and cannot be re-decided differently by the route and the UI.

import { isDayTreatment, type AttendanceDayCorrection, type DayTreatment } from '../attendance/corrections'
import type { DayClassification } from './types'

export type PeriodStatus = 'draft' | 'generated' | 'locked'

export type CorrectionDenial =
  | { allowed: false; reason: 'not_authorised'; message: string }
  | { allowed: false; reason: 'payroll_locked'; message: string }

export type CorrectionPermission = { allowed: true } | CorrectionDenial

/**
 * Whether this caller may correct attendance in this payroll period.
 *
 * Payroll correction is an admin action: it moves money. The existing payroll
 * routes all gate on `users.role === 'admin'` and this reuses that, rather than
 * introducing a second notion of who runs payroll.
 *
 * A locked period is final. There is no unlock workflow in BOE, so a locked
 * period is refused outright rather than offered a way around.
 */
export function canCorrectAttendance(
  role: string | null | undefined,
  periodStatus: PeriodStatus | null | undefined,
): CorrectionPermission {
  if (role !== 'admin') {
    return {
      allowed: false,
      reason: 'not_authorised',
      message: 'Only payroll administrators can correct attendance.',
    }
  }
  if (periodStatus === 'locked') {
    return {
      allowed: false,
      reason: 'payroll_locked',
      message: 'Payroll for this period is locked. Attendance can no longer be corrected.',
    }
  }
  return { allowed: true }
}

// ─── Input validation ─────────────────────────────────────────────────────────

export type CorrectionInput = {
  attendance_date?: unknown
  check_in_at?: unknown
  check_out_at?: unknown
  day_treatment?: unknown
  waive_late_arrival?: unknown
  waive_early_checkout?: unknown
  waive_missing_punch?: unknown
  remark?: unknown
}

export type ValidatedCorrection = {
  attendance_date: string
  corrected_check_in_at: string | null
  corrected_check_out_at: string | null
  day_treatment: DayTreatment
  waive_late_arrival: boolean
  waive_early_checkout: boolean
  waive_missing_punch: boolean
  remark: string
}

export type ValidationResult =
  | { ok: true; value: ValidatedCorrection }
  | { ok: false; error: string }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function validateCorrectionInput(input: CorrectionInput): ValidationResult {
  const date = typeof input.attendance_date === 'string' ? input.attendance_date.trim() : ''
  if (!ISO_DATE.test(date)) return { ok: false, error: 'A valid attendance date is required.' }

  // The remark is what makes the correction auditable, so it is required and a
  // string of spaces does not count as one.
  const remark = typeof input.remark === 'string' ? input.remark.trim() : ''
  if (remark === '') return { ok: false, error: 'A correction remark is required.' }

  const treatment = input.day_treatment ?? 'auto'
  if (!isDayTreatment(treatment)) return { ok: false, error: 'Unknown day treatment.' }

  const checkIn  = normaliseTimestamp(input.check_in_at)
  const checkOut = normaliseTimestamp(input.check_out_at)
  if (checkIn === 'invalid')  return { ok: false, error: 'Punch-in time is not a valid time.' }
  if (checkOut === 'invalid') return { ok: false, error: 'Punch-out time is not a valid time.' }

  if (checkIn && checkOut && new Date(checkOut).getTime() <= new Date(checkIn).getTime()) {
    return { ok: false, error: 'Punch-out must be later than punch-in.' }
  }

  return {
    ok: true,
    value: {
      attendance_date: date,
      corrected_check_in_at:  checkIn,
      corrected_check_out_at: checkOut,
      day_treatment: treatment,
      waive_late_arrival:   input.waive_late_arrival   === true,
      waive_early_checkout: input.waive_early_checkout === true,
      waive_missing_punch:  input.waive_missing_punch  === true,
      remark,
    },
  }
}

function normaliseTimestamp(value: unknown): string | null | 'invalid' {
  if (value == null || value === '') return null
  if (typeof value !== 'string') return 'invalid'
  const ms = new Date(value).getTime()
  if (isNaN(ms)) return 'invalid'
  return new Date(ms).toISOString()
}

export function toEngineCorrection(v: ValidatedCorrection): AttendanceDayCorrection {
  return {
    attendance_date: v.attendance_date,
    corrected_check_in_at:  v.corrected_check_in_at,
    corrected_check_out_at: v.corrected_check_out_at,
    day_treatment: v.day_treatment,
    waive_late_arrival:   v.waive_late_arrival,
    waive_early_checkout: v.waive_early_checkout,
    waive_missing_punch:  v.waive_missing_punch,
  }
}

// ─── Audit snapshot ───────────────────────────────────────────────────────────

export type DaySnapshot = {
  check_in_at: string | null
  check_out_at: string | null
  classification: DayClassification | null
  deduction_amount: number
  net_salary: number
}

export type CorrectionAudit = {
  original_check_in_at: string | null
  original_check_out_at: string | null
  original_classification: DayClassification | null
  revised_classification: DayClassification | null
  original_deduction_amount: number
  revised_deduction_amount: number
  original_net_salary: number
  revised_net_salary: number
}

/**
 * The before/after pair stored on the correction row.
 *
 * Both sides are captured from the engine — the "before" from a run over the
 * attendance as it stood, the "after" from a run with the new correction
 * applied — so the audit records what payroll actually did, not what the form
 * was told.
 */
export function buildCorrectionAudit(before: DaySnapshot, after: DaySnapshot): CorrectionAudit {
  return {
    original_check_in_at:      before.check_in_at,
    original_check_out_at:     before.check_out_at,
    original_classification:   before.classification,
    revised_classification:    after.classification,
    original_deduction_amount: round2(before.deduction_amount),
    revised_deduction_amount:  round2(after.deduction_amount),
    original_net_salary:       round2(before.net_salary),
    revised_net_salary:        round2(after.net_salary),
  }
}

// Currency is stored as numeric(10,2)/(12,2). Rounding here — and only here —
// keeps the audit consistent with the payroll columns without the engine
// rounding mid-calculation, which is what the existing totals rely on.
function round2(n: number): number {
  return Math.round(n * 100) / 100
}
