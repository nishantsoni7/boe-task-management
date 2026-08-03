/**
 * Attendance correction resolution — behavioural tests.
 *
 * The precedence rule (raw → correction → effective) and the waiver rules,
 * tested without a database.
 *
 * Run:
 *   npx tsx --test src/lib/attendance/corrections.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveEffectiveAttendance,
  waivedDeductionTypes,
  isDayTreatment,
  type AttendanceDayCorrection,
} from './corrections'

const DATE = '2026-07-21'

function correction(overrides: Partial<AttendanceDayCorrection> = {}): AttendanceDayCorrection {
  return {
    attendance_date: DATE,
    corrected_check_in_at:  '2026-07-21T04:30:00.000Z',   // 10:00 IST
    corrected_check_out_at: '2026-07-21T13:00:00.000Z',   // 18:30 IST
    day_treatment: 'auto',
    waive_late_arrival: false,
    waive_early_checkout: false,
    waive_missing_punch: false,
    ...overrides,
  }
}

describe('resolveEffectiveAttendance', () => {
  test('with no correction the raw record passes through untouched', () => {
    const raw = { check_in_at: '2026-07-21T05:00:00.000Z', check_out_at: null }
    const effective = resolveEffectiveAttendance(raw, undefined)
    assert.deepEqual(effective, { ...raw, source: 'raw' })
  })

  test('with no raw record and no correction both punches are absent', () => {
    assert.deepEqual(resolveEffectiveAttendance(undefined, undefined), {
      check_in_at: null, check_out_at: null, source: 'raw',
    })
  })

  test('a correction replaces the raw punches entirely', () => {
    const raw = { check_in_at: '2026-07-21T13:06:00.000Z', check_out_at: null }
    const effective = resolveEffectiveAttendance(raw, correction())
    assert.equal(effective.check_in_at,  '2026-07-21T04:30:00.000Z')
    assert.equal(effective.check_out_at, '2026-07-21T13:00:00.000Z')
    assert.equal(effective.source, 'corrected')
  })

  test('a corrected null means "no punch", not "keep the machine value"', () => {
    // The machine recorded a single punch and read it as the punch-in. The
    // correction states it was actually the punch-out.
    const raw = { check_in_at: '2026-07-21T13:06:00.000Z', check_out_at: null }
    const effective = resolveEffectiveAttendance(
      raw,
      correction({ corrected_check_in_at: null, corrected_check_out_at: '2026-07-21T13:06:00.000Z' }),
    )
    assert.equal(effective.check_in_at, null)
    assert.equal(effective.check_out_at, '2026-07-21T13:06:00.000Z')
  })

  test('the raw record is never mutated', () => {
    const raw = { check_in_at: '2026-07-21T13:06:00.000Z', check_out_at: null }
    const snapshot = { ...raw }
    resolveEffectiveAttendance(raw, correction())
    assert.deepEqual(raw, snapshot)
  })
})

describe('waivedDeductionTypes', () => {
  test('no correction waives nothing', () => {
    assert.equal(waivedDeductionTypes(undefined).size, 0)
  })

  test('each flag waives its own deduction type', () => {
    assert.deepEqual([...waivedDeductionTypes(correction({ waive_late_arrival: true }))], ['late_arrival'])
    assert.deepEqual([...waivedDeductionTypes(correction({ waive_early_checkout: true }))], ['early_checkout'])
  })

  test('waiving missing punch covers both directions', () => {
    const waived = waivedDeductionTypes(correction({ waive_missing_punch: true }))
    assert.ok(waived.has('missing_punch_in'))
    assert.ok(waived.has('missing_punch_out'))
  })

  test('a non-auto treatment settles the day, so the waiver flags are inert', () => {
    const waived = waivedDeductionTypes(correction({
      day_treatment: 'full_day',
      waive_late_arrival: true,
      waive_missing_punch: true,
    }))
    assert.equal(waived.size, 0)
  })
})

describe('isDayTreatment', () => {
  test('accepts the four known treatments and nothing else', () => {
    for (const t of ['auto', 'full_day', 'half_day', 'absent']) assert.ok(isDayTreatment(t))
    for (const t of ['paid_leave', '', null, undefined, 7]) assert.equal(isDayTreatment(t), false)
  })
})
