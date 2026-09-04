/**
 * buildHalfWindowSettings — pure derivation of the working-half's schedule
 * and thresholds. No DB, no classification, no money.
 *
 * Run:
 *   npx tsx --test src/lib/payroll/halfDayHoliday.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildHalfWindowSettings, clipAttendanceToWorkingHalf } from './halfDayHoliday'
import { DEFAULT_PAYROLL_SETTINGS } from './settings'
import type { EngineAttendanceRecord } from './types'
import { istMinutesOfDay } from '../istDate'

describe('buildHalfWindowSettings', () => {
  test('second_half exempt (afternoon off): the working half is the morning, unchanged start, ends at lunch', () => {
    const s = buildHalfWindowSettings('second_half', DEFAULT_PAYROLL_SETTINGS)
    assert.equal(s.scheduled_in_minutes, DEFAULT_PAYROLL_SETTINGS.scheduled_in_minutes, '10:00, unchanged')
    assert.equal(s.scheduled_out_minutes, 13 * 60, '13:00 — lunch start')
    assert.equal(s.grace_end_minutes, DEFAULT_PAYROLL_SETTINGS.grace_end_minutes, '10:15, unchanged since the start did not move')
  })

  test('first_half exempt (morning off): the working half is the afternoon, starts after lunch, unchanged end', () => {
    const s = buildHalfWindowSettings('first_half', DEFAULT_PAYROLL_SETTINGS)
    assert.equal(s.scheduled_in_minutes, 14 * 60, '14:00 — lunch end')
    assert.equal(s.scheduled_out_minutes, DEFAULT_PAYROLL_SETTINGS.scheduled_out_minutes, '18:30, unchanged')
    assert.equal(s.grace_end_minutes, 14 * 60 + 15, 'the grace OFFSET (15 min) is preserved, not a hardcoded clock time')
  })

  test('a custom grace offset is preserved, not replaced by a hardcoded 15 minutes', () => {
    const custom = { ...DEFAULT_PAYROLL_SETTINGS, grace_end_minutes: DEFAULT_PAYROLL_SETTINGS.scheduled_in_minutes + 30 }
    const s = buildHalfWindowSettings('second_half', custom)
    assert.equal(s.grace_end_minutes, s.scheduled_in_minutes + 30)
  })

  test('the three presence thresholds are exactly halved', () => {
    const s = buildHalfWindowSettings('second_half', DEFAULT_PAYROLL_SETTINGS)
    assert.equal(s.threshold_full_present_hours, DEFAULT_PAYROLL_SETTINGS.threshold_full_present_hours / 2)
    assert.equal(s.threshold_present_with_shortfall_hours, DEFAULT_PAYROLL_SETTINGS.threshold_present_with_shortfall_hours / 2)
    assert.equal(s.threshold_short_present_hours, DEFAULT_PAYROLL_SETTINGS.threshold_short_present_hours / 2)
  })

  test('every money-related field is untouched, in both directions', () => {
    for (const session of ['first_half', 'second_half'] as const) {
      const s = buildHalfWindowSettings(session, DEFAULT_PAYROLL_SETTINGS)
      assert.equal(s.full_day_hours, DEFAULT_PAYROLL_SETTINGS.full_day_hours)
      assert.equal(s.half_day_fraction, DEFAULT_PAYROLL_SETTINGS.half_day_fraction)
      assert.equal(s.missing_punch_hours, DEFAULT_PAYROLL_SETTINGS.missing_punch_hours)
      assert.equal(s.per_day_divisor, DEFAULT_PAYROLL_SETTINGS.per_day_divisor)
      assert.equal(s.lunch_hours, DEFAULT_PAYROLL_SETTINGS.lunch_hours)
      assert.equal(s.lunch_out_after_minutes, DEFAULT_PAYROLL_SETTINGS.lunch_out_after_minutes)
      assert.equal(s.lunch_in_before_minutes, DEFAULT_PAYROLL_SETTINGS.lunch_in_before_minutes)
      assert.deepEqual(s.paid_leave_tiers, DEFAULT_PAYROLL_SETTINGS.paid_leave_tiers)
      assert.equal(s.rounding_block_minutes, DEFAULT_PAYROLL_SETTINGS.rounding_block_minutes)
      assert.equal(s.rounding_block_hours, DEFAULT_PAYROLL_SETTINGS.rounding_block_hours)
    }
  })
})

describe('clipAttendanceToWorkingHalf', () => {
  const date = '2026-07-07'
  // 2026-07-07T04:30:00.000Z is 10:00 IST (04:30 UTC + 05:30 offset).
  const at = (hh: number, mm: number) => new Date(Date.UTC(2026, 6, 7, hh, mm - 330)).toISOString()
  const record = (inH: number, inM: number, outH: number, outM: number): EngineAttendanceRecord => ({
    id: 'r-1', attendance_date: date, check_in_at: at(inH, inM), check_out_at: at(outH, outM),
  })

  // First-Half holiday -> working half = afternoon, 14:00-18:30.
  const afternoonWindow = buildHalfWindowSettings('first_half', DEFAULT_PAYROLL_SETTINGS)
  // Second-Half holiday -> working half = morning, 10:00-13:00.
  const morningWindow = buildHalfWindowSettings('second_half', DEFAULT_PAYROLL_SETTINGS)

  test('undefined record passes through unchanged', () => {
    assert.equal(clipAttendanceToWorkingHalf(undefined, afternoonWindow), undefined)
  })

  test('a punch pair entirely inside the window is unchanged', () => {
    const r = record(15, 0, 17, 0)
    const clipped = clipAttendanceToWorkingHalf(r, afternoonWindow)!
    assert.equal(clipped.check_in_at, r.check_in_at)
    assert.equal(clipped.check_out_at, r.check_out_at)
  })

  test('a punch pair entirely outside the window (in the exempt half) becomes no punches at all', () => {
    // 08:00-13:00 is entirely in the morning, working half is the afternoon.
    const r = record(8, 0, 13, 0)
    const clipped = clipAttendanceToWorkingHalf(r, afternoonWindow)!
    assert.equal(clipped.check_in_at, null)
    assert.equal(clipped.check_out_at, null)
  })

  test('a punch pair straddling the boundary is clipped to exactly the window edges', () => {
    // 12:00-16:00 overlaps the afternoon window (14:00-18:30) only in
    // [14:00, 16:00].
    const r = record(12, 0, 16, 0)
    const clipped = clipAttendanceToWorkingHalf(r, afternoonWindow)!
    assert.equal(istMinutesOfDay(clipped.check_in_at!), 14 * 60)
    assert.equal(clipped.check_out_at, r.check_out_at, 'the out punch was already inside the window, so it is untouched')
  })

  test('symmetric case: a punch straddling the boundary the other way clips the check-out only', () => {
    // 11:00-15:00 overlaps the morning window (10:00-13:00) only in [11:00, 13:00].
    const r = record(11, 0, 15, 0)
    const clipped = clipAttendanceToWorkingHalf(r, morningWindow)!
    assert.equal(clipped.check_in_at, r.check_in_at, 'the in punch was already inside the window, so it is untouched')
    assert.equal(istMinutesOfDay(clipped.check_out_at!), 13 * 60)
  })

  test('exactly one punch, inside the window, passes through unchanged', () => {
    const r: EngineAttendanceRecord = { id: 'r-1', attendance_date: date, check_in_at: at(15, 0), check_out_at: null }
    const clipped = clipAttendanceToWorkingHalf(r, afternoonWindow)!
    assert.equal(clipped.check_in_at, r.check_in_at)
    assert.equal(clipped.check_out_at, null)
  })

  test('exactly one punch, outside the window (in the exempt half), is dropped rather than read as a missing punch', () => {
    // A lone morning check-in says nothing about the required afternoon.
    const r: EngineAttendanceRecord = { id: 'r-1', attendance_date: date, check_in_at: at(9, 0), check_out_at: null }
    const clipped = clipAttendanceToWorkingHalf(r, afternoonWindow)!
    assert.equal(clipped.check_in_at, null)
    assert.equal(clipped.check_out_at, null)
  })

  test('no punches at all is unchanged', () => {
    const r: EngineAttendanceRecord = { id: 'r-1', attendance_date: date, check_in_at: null, check_out_at: null }
    const clipped = clipAttendanceToWorkingHalf(r, afternoonWindow)!
    assert.equal(clipped.check_in_at, null)
    assert.equal(clipped.check_out_at, null)
  })
})
