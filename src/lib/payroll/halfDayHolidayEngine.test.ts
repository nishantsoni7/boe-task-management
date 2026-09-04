/**
 * Half-day company holidays' actual contract with payroll: an EngineHoliday
 * shaped exactly as Holiday Management would produce, run through the REAL,
 * unmodified payroll engine (generatePayrollForEmployee). Confirms every
 * case the task calls out:
 *
 *   existing full-day holiday (byte-identical to today) ·
 *   First-Half / Second-Half holiday, employee attends the working half ·
 *   no attendance at all on a half-day holiday (half a day charged, never a
 *   full day) · attendance problems (late arrival) during the working half ·
 *   a manual correction on a half-day-holiday date still wins
 *
 * Run:
 *   npx tsx --test src/lib/payroll/halfDayHolidayEngine.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { generatePayrollForEmployee } from './engine'
import { isSkip } from './types'
import type { EngineEmployee, EnginePeriod, EngineAttendanceRecord, EngineHoliday, EngineResult } from './types'
import type { AttendanceDayCorrection } from '../attendance/corrections'

// per_day_rate = 26,000 / 26 = 1,000 — a half-day charge is exactly 500, a
// full-day charge exactly 1,000, easy to tell apart in assertions.
const employee: EngineEmployee = {
  id: 'emp-1', monthly_salary: 26_000, payroll_active: true, joining_date: null, employment_type: 'permanent',
}
const period: EnginePeriod = { id: 'period-1', payroll_month: 7, payroll_year: 2026, status: 'draft' }

const iso = (d: number) => `2026-07-${String(d).padStart(2, '0')}`
const at  = (d: number, hh: number, mm: number) => new Date(Date.UTC(2026, 6, d, hh, mm - 330)).toISOString()
const punch = (d: number, inH: number, inM: number, outH: number, outM: number): EngineAttendanceRecord => ({
  id: `r-${d}`, attendance_date: iso(d), check_in_at: at(d, inH, inM), check_out_at: at(d, outH, outM),
})

function fullDayHoliday(d: number): EngineHoliday {
  return { holiday_date: iso(d), holiday_type: 'full_day', half_session: null }
}
function halfDayHoliday(d: number, half_session: 'first_half' | 'second_half'): EngineHoliday {
  return { holiday_date: iso(d), holiday_type: 'half_day', half_session }
}

// A near-empty month (only the target date has any record) so
// paid_leave_available comes out 0 and nothing can absorb the target day's
// charge — isolates the unabsorbed amount cleanly, same fixture strategy
// proven in the (reverted) leave feature's engine tests.
function run(records: EngineAttendanceRecord[], holidays: EngineHoliday[], corrections: AttendanceDayCorrection[] = []): EngineResult {
  const o = generatePayrollForEmployee(employee, period, records, holidays, [], corrections)
  assert.ok(!isSkip(o), 'engine must not skip a payroll_active employee with a salary')
  return o as EngineResult
}

function dayFor(result: EngineResult, date: string) {
  const day = result.day_results.find(d => d.date === date)
  assert.ok(day, `no day_result for ${date}`)
  return day!
}

describe('an existing full-day holiday is completely unaffected', () => {
  test('excluded from the calendar exactly as before — attendance on that date is ignored, zero deduction', () => {
    const date = iso(6)
    const result = run([punch(6, 4, 30, 13, 0)], [fullDayHoliday(6)])
    const day = dayFor(result, date)
    assert.equal(day.classification, 'holiday')
    assert.equal(day.total_deduction_amount, 0)
  })
})

describe('half-day holiday: the employee attends the required working half', () => {
  test('Second-Half holiday (afternoon exempt): full morning attendance is paid in full', () => {
    const date = iso(7)
    const result = run([punch(7, 10, 0, 13, 0)], [halfDayHoliday(7, 'second_half')])
    const day = dayFor(result, date)
    assert.equal(day.classification, 'full_present')
    assert.equal(day.total_deduction_amount, 0)
  })

  test('First-Half holiday (morning exempt): full afternoon attendance is paid in full', () => {
    const date = iso(7)
    const result = run([punch(7, 14, 0, 18, 30)], [halfDayHoliday(7, 'first_half')])
    const day = dayFor(result, date)
    assert.equal(day.classification, 'full_present')
    assert.equal(day.total_deduction_amount, 0)
  })
})

describe('half-day holiday: no attendance at all on the working half', () => {
  test('charged exactly half a day, never a full day', () => {
    const date = iso(7)
    const result = run([], [halfDayHoliday(7, 'second_half')])
    const day = dayFor(result, date)
    assert.equal(day.classification, 'half_day')
    assert.equal(day.total_deduction_amount, 500, 'half of the 1,000 per-day rate')
    assert.equal(day.total_deduction_amount < 1_000, true, 'must never reach a full day\'s deduction')
  })

  test('the same cap applies regardless of which half is the holiday', () => {
    const date = iso(7)
    const result = run([], [halfDayHoliday(7, 'first_half')])
    assert.equal(dayFor(result, date).total_deduction_amount, 500)
  })
})

describe('half-day holiday: attendance problems during the working half are evaluated', () => {
  test('a late arrival within the working half still costs a late-arrival deduction, scoped to the half\'s own start time', () => {
    const date = iso(7)
    // Second-Half holiday: working half = morning, scheduled start 10:00,
    // ends at lunch (13:00). In at 10:20 (20 min late, past the 15-minute
    // grace — rounds to 0.5h per the engine's own rounding rule), out at
    // 12:59 (2h39m worked, clears the halved present_with_shortfall floor of
    // 2.5h without reaching the halved full_present floor of 3.75h, and
    // stays clear of the lunch window so lunch deduction doesn't confound
    // the hours).
    const result = run([punch(7, 10, 20, 12, 59)], [halfDayHoliday(7, 'second_half')])
    const day = dayFor(result, date)
    assert.equal(day.classification, 'present_with_shortfall')
    const late = day.deduction_lines.find(l => l.deduction_type === 'late_arrival')
    assert.ok(late, 'a late arrival within the working half must still be charged')
    assert.equal(late!.hours_deducted, 0.5)
    assert.equal(day.total_deduction_amount > 0, true)
  })

  test('an on-time arrival that leaves before the working half ends is capped at the half-day charge, not the full-day one', () => {
    const date = iso(7)
    // In at 10:00 (on time), out at 10:45 — 45 minutes worked, well under the
    // halved short_present floor (1h), so this is a no-show-equivalent for
    // the working half: remapped to half_day, never full_absent.
    const result = run([punch(7, 10, 0, 10, 45)], [halfDayHoliday(7, 'second_half')])
    const day = dayFor(result, date)
    assert.equal(day.classification, 'half_day')
    assert.equal(day.total_deduction_amount, 500)
  })
})

describe('half-day holiday: attendance entirely in the EXEMPT half must not satisfy the working half', () => {
  // The bug live browser testing found: Mohit Sharma, 15 Aug, punches
  // 09:22 -> 14:42. With a First-Half holiday (working half = afternoon,
  // 14:00-18:30), his attendance is almost entirely in the exempt morning —
  // before the fix, the unclipped hours (comfortably over the halved
  // full_present floor) wrongly cleared the bar and produced "Full Present"
  // plus a nonsensical "Early Checkout 4h" charge. Reproduced here with a
  // clean 5-hour exempt-half attendance to isolate the defect.
  test('First-Half holiday: 5 hours of attendance entirely in the exempt morning is a no-show for the working afternoon, capped at half a day', () => {
    const date = iso(7)
    const result = run([punch(7, 8, 0, 13, 0)], [halfDayHoliday(7, 'first_half')])
    const day = dayFor(result, date)
    assert.equal(day.classification, 'half_day', 'not full_present — none of those hours were in the required afternoon')
    assert.equal(day.total_deduction_amount, 500)
    assert.equal(day.deduction_lines.some(l => l.deduction_type === 'early_checkout'), false,
      'must not be charged an "early checkout" for a shift never actually started')
  })

  test('Second-Half holiday: attendance entirely in the exempt afternoon is a no-show for the working morning, capped at half a day', () => {
    const date = iso(7)
    const result = run([punch(7, 14, 0, 18, 0)], [halfDayHoliday(7, 'second_half')])
    const day = dayFor(result, date)
    assert.equal(day.classification, 'half_day')
    assert.equal(day.total_deduction_amount, 500)
  })

  test('the live-browser Mohit Sharma reproduction, exact punches: 09:22 -> 14:42', () => {
    const date = iso(7)
    const withFirstHalf  = dayFor(run([punch(7, 9, 22, 14, 42)], [halfDayHoliday(7, 'first_half')]), date)
    assert.equal(withFirstHalf.classification, 'half_day')
    assert.equal(withFirstHalf.total_deduction_amount, 500)

    const withSecondHalf = dayFor(run([punch(7, 9, 22, 14, 42)], [halfDayHoliday(7, 'second_half')]), date)
    assert.equal(withSecondHalf.classification, 'full_present', 'the morning IS the working half here, and he fully covered it')
    assert.equal(withSecondHalf.total_deduction_amount, 0)
  })
})

describe('half-day holiday: a punch spanning the half boundary counts only its overlap with the working half', () => {
  test('First-Half holiday: a punch starting in the exempt morning and ending in the working afternoon counts only the afternoon portion', () => {
    const date = iso(7)
    // Raw span 12:00->16:00 is 4h, comfortably over the halved present_with_shortfall
    // floor (2.5h) if counted whole. Only 14:00->16:00 (2h) is inside the
    // working window — enough to clear short_present' (1h) but not
    // present_with_shortfall' (2.5h), landing in the half_day band.
    const result = run([punch(7, 12, 0, 16, 0)], [halfDayHoliday(7, 'first_half')])
    const day = dayFor(result, date)
    assert.equal(day.classification, 'half_day')
    assert.equal(day.effective_hours_worked, 2, 'only the 2 overlapping hours count, not the raw 4-hour span')
  })

  test('Second-Half holiday: a punch starting in the working morning and ending in the exempt afternoon counts only the morning portion', () => {
    const date = iso(7)
    // Raw span 11:00->15:00 is 4h; only 11:00->13:00 (2h) is inside the
    // working window (10:00-13:00).
    const result = run([punch(7, 11, 0, 15, 0)], [halfDayHoliday(7, 'second_half')])
    const day = dayFor(result, date)
    assert.equal(day.classification, 'half_day')
    assert.equal(day.effective_hours_worked, 2)
  })
})

describe('half-day holiday: late/early rules still evaluate the working half correctly after clipping', () => {
  test('First-Half holiday: a late arrival into the working afternoon still costs a late-arrival deduction, scoped to the afternoon start', () => {
    const date = iso(7)
    // Working half = afternoon, scheduled start 14:00, grace to 14:15. In at
    // 15:00 (1h past grace -> rounds to 1h), out at 18:29 (just under the
    // window's own end, so onOfficeTiming does not short-circuit it) -> 3h29m
    // worked, clears present_with_shortfall' (2.5h) but not full_present' (3.75h).
    const result = run([punch(7, 15, 0, 18, 29)], [halfDayHoliday(7, 'first_half')])
    const day = dayFor(result, date)
    assert.equal(day.classification, 'present_with_shortfall')
    const late = day.deduction_lines.find(l => l.deduction_type === 'late_arrival')
    assert.ok(late, 'a late arrival into the working half must still be charged')
    assert.equal(late!.hours_deducted, 1)
  })
})

describe('raw provenance always shows the true machine punches, never the clipped ones', () => {
  test('the day-level raw_check_in_at/raw_check_out_at match the actual punches even though classification used the clipped interval', () => {
    const date = iso(7)
    const raw = punch(7, 9, 22, 14, 42)
    const day = dayFor(run([raw], [halfDayHoliday(7, 'first_half')]), date)
    assert.equal(day.classification, 'half_day', 'sanity: this is the clipped/capped outcome, not full_present')
    assert.equal(day.raw_check_in_at, raw.check_in_at)
    assert.equal(day.raw_check_out_at, raw.check_out_at)
  })
})

describe('a manual correction on a half-day-holiday date still wins', () => {
  test('an admin\'s forced "absent" overrides the holiday\'s half-day cap entirely', () => {
    const date = iso(7)
    const correction: AttendanceDayCorrection = {
      attendance_date: date, corrected_check_in_at: null, corrected_check_out_at: null, day_treatment: 'absent',
      waive_late_arrival: false, waive_early_checkout: false, waive_missing_punch: false,
    }
    const result = run([punch(7, 10, 0, 13, 0)], [halfDayHoliday(7, 'second_half')], [correction])
    const day = dayFor(result, date)
    assert.equal(day.classification, 'full_absent')
    assert.equal(day.total_deduction_amount, 1_000, 'the explicit correction is not capped by the holiday rule')
  })

  test('an admin\'s forced "full_day" also wins, identically to a normal correction', () => {
    const date = iso(7)
    const correction: AttendanceDayCorrection = {
      attendance_date: date, corrected_check_in_at: null, corrected_check_out_at: null, day_treatment: 'full_day',
      waive_late_arrival: false, waive_early_checkout: false, waive_missing_punch: false,
    }
    const result = run([], [halfDayHoliday(7, 'second_half')], [correction])
    const day = dayFor(result, date)
    assert.equal(day.classification, 'full_present')
    assert.equal(day.total_deduction_amount, 0)
  })
})
