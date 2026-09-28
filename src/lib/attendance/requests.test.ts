import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateRequestInput,
  shiftStartUtc,
  isInformedBeforeShift,
  informedForCorrection,
  findConflict,
  canEmployeeCancel,
  validateDecision,
  type RequestInput,
  type AttendanceRequestRow,
} from './requests'

const SHIFT = { scheduled_in_minutes: 600, scheduled_out_minutes: 1110 }
const TODAY = '2026-10-12'

const base = (over: Record<string, unknown>) => ({
  request_type: 'late_arrival', start_date: TODAY, reason_code: 'personal', ...over,
})

describe('validateRequestInput', () => {
  test('an urgent late arrival needs only a type, date and reason', () => {
    const v = validateRequestInput(base({}), TODAY, SHIFT)
    assert.equal(v.ok, true)
    if (v.ok) {
      assert.equal(v.value.end_date, TODAY)
      assert.equal(v.value.expected_arrival_time, null)
    }
  })

  test('"Other" requires a note', () => {
    assert.equal(validateRequestInput(base({ reason_code: 'other' }), TODAY, SHIFT).ok, false)
    assert.equal(validateRequestInput(base({ reason_code: 'other', reason_note: 'bank' }), TODAY, SHIFT).ok, true)
  })

  test('time out: return must be after departure and inside the working day', () => {
    const t = (o: Record<string, unknown>) =>
      validateRequestInput(base({ request_type: 'time_out', work_kind: 'personal', ...o }), TODAY, SHIFT).ok
    assert.equal(t({ departure_time: '12:00', return_time: '13:00' }), true)
    assert.equal(t({ departure_time: '13:00', return_time: '12:00' }), false)
    assert.equal(t({ departure_time: '13:00', return_time: '13:00' }), false)
    assert.equal(t({ departure_time: '17:00', return_time: '19:30' }), false)
    assert.equal(validateRequestInput(base({ request_type: 'time_out', departure_time: '12:00', return_time: '13:00' }), TODAY, SHIFT).ok, false,
      'work kind is required')
  })

  test('early departure must be during the working day', () => {
    assert.equal(validateRequestInput(base({ request_type: 'early_departure', departure_time: '16:00' }), TODAY, SHIFT).ok, true)
    assert.equal(validateRequestInput(base({ request_type: 'early_departure', departure_time: '19:00' }), TODAY, SHIFT).ok, false)
  })

  test('leave: single date by default, end before start refused', () => {
    const one = validateRequestInput(base({ request_type: 'full_day_leave' }), TODAY, SHIFT)
    assert.ok(one.ok && one.value.end_date === TODAY)
    assert.equal(validateRequestInput(base({ request_type: 'full_day_leave', end_date: '2026-10-10' }), TODAY, SHIFT).ok, false)
    const multi = validateRequestInput(base({ request_type: 'full_day_leave', start_date: '2026-10-30', end_date: '2026-11-02' }), TODAY, SHIFT)
    assert.ok(multi.ok && multi.value.end_date === '2026-11-02', 'leave may cross a payroll month')
  })

  test('only leave can span days — an end date on a late arrival is ignored', () => {
    const v = validateRequestInput(base({ end_date: '2026-10-15' }), TODAY, SHIFT)
    assert.ok(v.ok && v.value.end_date === TODAY)
  })

  test('retroactive requests are allowed within the window', () => {
    assert.equal(validateRequestInput(base({ start_date: '2026-09-01' }), TODAY, SHIFT).ok, true)
    assert.equal(validateRequestInput(base({ start_date: '2026-06-01' }), TODAY, SHIFT).ok, false)
  })

  test('half day needs a session', () => {
    assert.equal(validateRequestInput(base({ request_type: 'half_day' }), TODAY, SHIFT).ok, false)
    assert.equal(validateRequestInput(base({ request_type: 'half_day', half_session: 'first_half' }), TODAY, SHIFT).ok, true)
  })
})

describe('informed on time (India time)', () => {
  test('the shift start is 10:00 IST = 04:30 UTC on that date', () => {
    assert.equal(shiftStartUtc('2026-10-12', SHIFT), '2026-10-12T04:30:00.000Z')
  })

  test('09:59:59 IST is informed; 10:00 IST is not', () => {
    const shift = shiftStartUtc('2026-10-12', SHIFT)
    assert.equal(isInformedBeforeShift('2026-10-12T04:29:59.000Z', shift), true)
    assert.equal(isInformedBeforeShift('2026-10-12T04:30:00.000Z', shift), false)
  })

  test('a request filed at 23:30 IST the night before (18:00 UTC, previous UTC date) is informed', () => {
    assert.equal(isInformedBeforeShift('2026-10-11T18:00:00.000Z', shiftStartUtc('2026-10-12', SHIFT)), true)
  })

  test('a correction keeps the original submission time when the date is unchanged', () => {
    const original = { start_date: '2026-10-12', original_submitted_at: '2026-10-12T03:00:00.000Z' }
    const lateNow = '2026-10-12T06:00:00.000Z'
    assert.equal(informedForCorrection(original, { start_date: '2026-10-12' }, lateNow, SHIFT), true)
    assert.equal(informedForCorrection(original, { start_date: '2026-10-11' }, lateNow, SHIFT), false,
      'moving to another date is a new notice')
  })
})

describe('findConflict — overlapping and duplicate requests', () => {
  const row = (o: Partial<AttendanceRequestRow>) => ({
    id: 'x', request_type: 'late_arrival', start_date: TODAY, end_date: TODAY,
    departure_time: null, return_time: null, status: 'pending', ...o,
  }) as AttendanceRequestRow
  const cand = (o: Partial<RequestInput>) => ({
    request_type: 'late_arrival', start_date: TODAY, end_date: TODAY, expected_arrival_time: null,
    departure_time: null, return_time: null, half_session: null, work_kind: null,
    reason_code: 'personal', reason_note: null, ...o,
  }) as RequestInput

  test('a second late arrival for the same date is a duplicate', () => {
    assert.ok(findConflict(cand({}), [row({})]))
  })
  test('late arrival + early departure on one day is legitimate', () => {
    assert.equal(findConflict(cand({ request_type: 'early_departure', departure_time: '16:00' }), [row({})]), null)
  })
  test('leave overlapping any request conflicts, across a range', () => {
    assert.ok(findConflict(cand({ request_type: 'full_day_leave', start_date: '2026-10-10', end_date: '2026-10-14' }), [row({})]))
  })
  test('time-outs on one day conflict only when their times overlap', () => {
    const existing = [row({ request_type: 'time_out', departure_time: '12:00', return_time: '13:00' })]
    assert.equal(findConflict(cand({ request_type: 'time_out', departure_time: '15:00', return_time: '16:00' }), existing), null)
    assert.ok(findConflict(cand({ request_type: 'time_out', departure_time: '12:30', return_time: '14:00' }), existing))
  })
  test('cancelled and rejected requests never block a new one', () => {
    assert.equal(findConflict(cand({}), [row({ status: 'cancelled' }), row({ id: 'y', status: 'rejected' })]), null)
  })
  test('the request being corrected does not block its own correction', () => {
    assert.equal(findConflict(cand({}), [row({ id: 'orig' })], 'orig'), null)
  })
})

describe('what an employee may still do', () => {
  const shift = shiftStartUtc(TODAY, SHIFT)
  test('pending can be cancelled any time; approved only before the shift', () => {
    assert.equal(canEmployeeCancel({ status: 'pending', shift_start_at: shift }, '2026-10-20T00:00:00Z'), true)
    assert.equal(canEmployeeCancel({ status: 'approved', shift_start_at: shift }, '2026-10-12T04:00:00Z'), true)
    assert.equal(canEmployeeCancel({ status: 'approved', shift_start_at: shift }, '2026-10-12T05:00:00Z'), false)
    assert.equal(canEmployeeCancel({ status: 'rejected', shift_start_at: shift }, '2026-10-01T00:00:00Z'), false)
  })
})

describe('validateDecision', () => {
  test('reject needs a reason; approve does not', () => {
    assert.equal(validateDecision({ status: 'rejected' }, 'pending').ok, false)
    assert.equal(validateDecision({ status: 'rejected', note: 'No cover' }, 'pending').ok, true)
    assert.equal(validateDecision({ status: 'approved' }, 'pending').ok, true)
  })
  test('revising a decision needs a reason; a cancelled request cannot be decided', () => {
    assert.equal(validateDecision({ status: 'approved' }, 'rejected').ok, false)
    assert.equal(validateDecision({ status: 'approved', note: 'Emergency confirmed' }, 'rejected').ok, true)
    assert.equal(validateDecision({ status: 'approved' }, 'cancelled').ok, false)
    assert.equal(validateDecision({ status: 'approved' }, 'approved').ok, false)
  })
})
