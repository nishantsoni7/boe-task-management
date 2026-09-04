// Half-day company holidays — the settings-derivation and punch-clipping
// this feature needs, and nothing else.
//
// A half-day holiday exempts one half of the day; the other half is a
// normal working obligation. Two pieces work together to scope the
// EXISTING, UNMODIFIED classifyAttendanceDay / classifySingleDay to just
// that working half — no new classification algorithm and no new deduction
// math anywhere:
//
//   buildHalfWindowSettings      — the working half's schedule/thresholds.
//   clipAttendanceToWorkingHalf  — the working half's PUNCHES: time spent in
//                                  the exempt half must not count toward the
//                                  working half's presence requirement, so
//                                  the employee's raw check-in/check-out is
//                                  clipped to the working window BEFORE it
//                                  ever reaches the classifier. Halving the
//                                  thresholds alone is not sufficient — an
//                                  employee who worked long enough in the
//                                  EXEMPT half could otherwise still clear
//                                  the (halved) bar for a half they never
//                                  attended.

import type { PayrollSettings } from './settings'
import type { EngineAttendanceRecord, HolidayHalfSession } from './types'
import { LUNCH_OUT_AFTER_MINUTES, LUNCH_IN_BEFORE_MINUTES } from '../attendance/scheduleRules'
import { istMinutesOfDay, istClockToUtc, formatMinutesOfDay } from '../istDate'

/**
 * The working half's schedule and thresholds, everything else untouched.
 *
 * Boundary: the lunch window splits the day — lunch start
 * (`lunch_out_after_minutes`) is "end of morning", lunch end
 * (`lunch_in_before_minutes`) is "start of afternoon". The hour thresholds
 * (full_present / present_with_shortfall / short_present) are halved, since
 * "full presence" for a half-day obligation is naturally about half the
 * normal day's hours.
 *
 * Everything money-related — `full_day_hours`, `half_day_fraction`,
 * `missing_punch_hours`, lunch settings, rounding, divisors,
 * `paid_leave_tiers` — is left EXACTLY as passed in. Those drive a forced
 * correction's math and the per-unit rates, which must stay at full-day
 * values regardless of the holiday; only the classification inputs change.
 */
export function buildHalfWindowSettings(
  session: HolidayHalfSession,
  settings: PayrollSettings,
): PayrollSettings {
  // The grace period is stated as an OFFSET from the scheduled start in the
  // real settings, so a custom (admin-configured) grace window is preserved
  // rather than silently replaced by a hardcoded 15 minutes.
  const graceOffsetMinutes = settings.grace_end_minutes - settings.scheduled_in_minutes

  // session names the EXEMPT half. 'second_half' exempt → the working half
  // is the morning (unchanged start, ends at lunch). 'first_half' exempt →
  // the working half is the afternoon (starts after lunch, unchanged end).
  const scheduled_in_minutes  = session === 'second_half' ? settings.scheduled_in_minutes  : LUNCH_IN_BEFORE_MINUTES
  const scheduled_out_minutes = session === 'second_half' ? LUNCH_OUT_AFTER_MINUTES         : settings.scheduled_out_minutes

  return {
    ...settings,
    scheduled_in_minutes,
    grace_end_minutes: scheduled_in_minutes + graceOffsetMinutes,
    scheduled_out_minutes,
    threshold_full_present_hours:           settings.threshold_full_present_hours / 2,
    threshold_present_with_shortfall_hours: settings.threshold_present_with_shortfall_hours / 2,
    threshold_short_present_hours:          settings.threshold_short_present_hours / 2,
  }
}

/**
 * Clips a raw attendance record to the working half's window
 * (`halfWindowSettings.scheduled_in_minutes` .. `scheduled_out_minutes`, as
 * already built by buildHalfWindowSettings), so only time actually spent in
 * the required half is ever passed to the classifier.
 *
 * - Both punches present: the effective interval is the OVERLAP between the
 *   raw [check_in, check_out] span and the window — `effective_in =
 *   max(actual_in, window_start)`, `effective_out = min(actual_out,
 *   window_end)`. No overlap (`effective_out <= effective_in`) becomes no
 *   punches at all, which the classifier resolves to `full_absent` — the
 *   caller then caps that at `half_day`, which is the correct "no-show for
 *   the required half" outcome even though the employee worked elsewhere
 *   that day.
 * - Exactly one punch present: relevant only if it falls INSIDE the window.
 *   A lone punch entirely in the exempt half (e.g. a morning check-in with
 *   no check-out, on a first-half-exempt day) says nothing about the working
 *   half and is dropped, not read as a missing punch for it.
 * - Neither punch present: unchanged.
 */
export function clipAttendanceToWorkingHalf(
  record: EngineAttendanceRecord | undefined,
  halfWindowSettings: PayrollSettings,
): EngineAttendanceRecord | undefined {
  if (!record) return record

  const windowStart = halfWindowSettings.scheduled_in_minutes
  const windowEnd    = halfWindowSettings.scheduled_out_minutes

  const inMin  = record.check_in_at  != null ? istMinutesOfDay(record.check_in_at)  : null
  const outMin = record.check_out_at != null ? istMinutesOfDay(record.check_out_at) : null

  // formatMinutesOfDay always yields a valid HH:MM for an in-range minute,
  // and record.attendance_date is always a valid business date, so
  // istClockToUtc cannot actually return null here.
  const atMinute = (minute: number): string => istClockToUtc(record.attendance_date, formatMinutesOfDay(minute))!

  if (inMin != null && outMin != null) {
    const effectiveIn  = Math.max(inMin, windowStart)
    const effectiveOut = Math.min(outMin, windowEnd)
    if (effectiveOut <= effectiveIn) return { ...record, check_in_at: null, check_out_at: null }
    return {
      ...record,
      check_in_at:  effectiveIn  === inMin  ? record.check_in_at  : atMinute(effectiveIn),
      check_out_at: effectiveOut === outMin ? record.check_out_at : atMinute(effectiveOut),
    }
  }

  if (inMin != null) {
    const relevant = inMin >= windowStart && inMin <= windowEnd
    return relevant ? record : { ...record, check_in_at: null, check_out_at: null }
  }

  if (outMin != null) {
    const relevant = outMin >= windowStart && outMin <= windowEnd
    return relevant ? record : { ...record, check_in_at: null, check_out_at: null }
  }

  return record
}
