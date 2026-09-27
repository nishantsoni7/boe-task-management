import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildReconciliation, validateReviewInput, type ReconInput, type ReconReview } from './requestReconciliation'
import type { AttendanceRequestRow } from './requests'
import { istClockToUtc } from '../istDate'

const EMP = 'e1'
const SCHEDULE = { scheduled_in_minutes: 600, grace_end_minutes: 615, scheduled_out_minutes: 1110, weekly_off_day: 0 }

const punch = (date: string, inClock: string | null, outClock: string | null) => ({
  employee_id: EMP,
  attendance_date: date,
  check_in_at: inClock ? istClockToUtc(date, inClock) : null,
  check_out_at: outClock ? istClockToUtc(date, outClock) : null,
  punch_direction_source: 'confirmed',
})

let n = 0
const request = (o: Partial<AttendanceRequestRow>): AttendanceRequestRow => ({
  id: `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`,
  employee_id: EMP,
  request_type: 'late_arrival',
  start_date: '2026-10-05',
  end_date: '2026-10-05',
  expected_arrival_time: null,
  departure_time: null,
  return_time: null,
  half_session: null,
  work_kind: null,
  reason_code: 'personal',
  reason_note: null,
  submitted_at: '2026-10-05T03:00:00.000Z',
  original_submitted_at: '2026-10-05T03:00:00.000Z',
  shift_start_at: '2026-10-05T04:30:00.000Z',
  informed_before_shift: true,
  status: 'approved',
  decided_by: 'admin',
  decided_at: '2026-10-05T03:30:00.000Z',
  decision_note: null,
  cancelled_at: null,
  cancel_reason: null,
  replaces_request_id: null,
  updated_at: '2026-10-05T03:30:00.000Z',
  ...o,
})

function input(over: Partial<ReconInput>): ReconInput {
  return {
    year: 2026, month: 10, today: '2026-10-31', coverageThrough: '2026-10-31',
    schedule: SCHEDULE, holidayDates: new Set(), draftGenerated: false,
    employees: [{ id: EMP, full_name: 'Asha', employee_code: 'B1', is_active: true, payroll_active: true, joining_date: null }],
    attendance: [], corrections: [], requests: [], reviews: [], draftLines: [], redemptions: [],
    ...over,
  }
}

// October 2026: the 5th–10th are Mon–Sat. Give the employee a full, on-time
// month except where a test says otherwise, so absences do not add noise.
function fullMonth(except: Record<string, [string | null, string | null] | null> = {}) {
  const rows = []
  for (let d = 1; d <= 31; d++) {
    const date = `2026-10-${String(d).padStart(2, '0')}`
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) continue
    if (date in except) {
      const v = except[date]
      if (v) rows.push(punch(date, v[0], v[1]))
      continue
    }
    rows.push(punch(date, '09:55', '18:35'))
  }
  return rows
}

const eventsOf = (r: ReturnType<typeof buildReconciliation>) => r.employees[0]?.events ?? []

describe('late arrivals and the monthly review flag', () => {
  test('four uninformed late arrivals: only the fourth is flagged, and nothing is deducted by the flag', () => {
    const r = buildReconciliation(input({
      attendance: fullMonth({
        '2026-10-05': ['10:40', '18:35'],
        '2026-10-06': ['10:20', '18:35'],
        '2026-10-07': ['10:50', '18:35'],
        '2026-10-08': ['11:00', '18:35'],
      }),
    }))
    const lates = eventsOf(r).filter(e => e.kind === 'late_arrival')
    assert.equal(lates.length, 4)
    assert.deepEqual(lates.map(e => e.policy_flag), [false, false, false, true])
    assert.equal(r.employees[0].uninformed_late_count, 4)
    assert.deepEqual(r.employees[0].policy_flag_dates, ['2026-10-08'])
    assert.equal(lates[0].actual.minutes_late, 40)
    // The flag is information. The only money on the event is what the stored
    // draft says — and there is no draft here.
    assert.ok(lates.every(e => e.draft_amount === null))
  })

  test('arriving within the grace period is not a late arrival', () => {
    const r = buildReconciliation(input({ attendance: fullMonth({ '2026-10-05': ['10:15', '18:35'] }) }))
    assert.equal(eventsOf(r).filter(e => e.kind === 'late_arrival').length, 0)
  })

  test('informed and excused late arrivals do not count toward the flag', () => {
    const informed = request({ start_date: '2026-10-05', end_date: '2026-10-05' })
    const reviews: ReconReview[] = [{
      id: 'r1', employee_id: EMP, attendance_date: '2026-10-06', event_key: 'late_arrival',
      excused: true, excuse_reason: 'Company vehicle broke down', pay_decision: null, decision_reason: null,
      attendance_fingerprint: 'x', reviewed_by: 'admin', reviewed_at: '2026-10-06T08:00:00Z',
    }]
    const r = buildReconciliation(input({
      attendance: fullMonth({
        '2026-10-05': ['10:40', '18:35'],
        '2026-10-06': ['10:40', '18:35'],
        '2026-10-07': ['10:40', '18:35'],
        '2026-10-08': ['10:40', '18:35'],
        '2026-10-09': ['10:40', '18:35'],
      }),
      requests: [informed],
      reviews,
    }))
    const lates = eventsOf(r).filter(e => e.kind === 'late_arrival')
    assert.equal(lates[0].informed, true)
    assert.equal(lates[1].excused, true)
    assert.equal(r.employees[0].uninformed_late_count, 3)
    assert.equal(lates.some(e => e.policy_flag), false)
  })

  test('a request submitted after the shift started is uninformed, even if approved', () => {
    const late = request({ informed_before_shift: false, submitted_at: '2026-10-05T06:00:00.000Z' })
    const r = buildReconciliation(input({ attendance: fullMonth({ '2026-10-05': ['10:40', '18:35'] }), requests: [late] }))
    const ev = eventsOf(r).find(e => e.kind === 'late_arrival')!
    assert.equal(ev.informed, false)
    assert.equal(ev.counts_toward_policy, true)
    assert.equal(ev.request?.id, late.id, 'the request is still shown with the event')
  })

  test('approved expected time vs actual: arriving much later is flagged, not replaced', () => {
    const req = request({ expected_arrival_time: '10:45' })
    const r = buildReconciliation(input({ attendance: fullMonth({ '2026-10-05': ['11:30', '18:35'] }), requests: [req] }))
    const ev = eventsOf(r).find(e => e.kind === 'late_arrival')!
    assert.equal(ev.actual.minutes_late, 90, 'actual time is what is measured')
    assert.ok(ev.flags.some(f => f.includes('later than approved')))
  })

  test('company vehicle is an identifiable company exception', () => {
    const req = request({ reason_code: 'company_vehicle' })
    const r = buildReconciliation(input({ attendance: fullMonth({ '2026-10-05': ['10:40', '18:35'] }), requests: [req] }))
    assert.equal(eventsOf(r).find(e => e.kind === 'late_arrival')!.company_exception, true)
  })
})

describe('matching requests to attendance', () => {
  test('time out with a missing return punch is surfaced on both events', () => {
    const req = request({ request_type: 'time_out', departure_time: '14:00', return_time: '15:00', work_kind: 'company', reason_code: 'company_work' })
    const r = buildReconciliation(input({ attendance: fullMonth({ '2026-10-05': ['09:55', null] }), requests: [req] }))
    const evs = eventsOf(r).filter(e => e.date === '2026-10-05')
    const missing = evs.find(e => e.kind === 'missing_punch')!
    assert.ok(missing.flags.some(f => f.includes('time-out request')))
    const timeOut = evs.find(e => e.kind === 'request')!
    assert.equal(timeOut.company_exception, true)
    assert.ok(timeOut.flags.some(f => f.includes('not recorded')))
  })

  test('leave approved but punches exist is flagged; leave on a Sunday is not an event', () => {
    const req = request({ request_type: 'full_day_leave', start_date: '2026-10-10', end_date: '2026-10-12' })
    const r = buildReconciliation(input({ attendance: fullMonth({ '2026-10-10': ['09:55', '18:35'], '2026-10-12': null }), requests: [req] }))
    const leave = eventsOf(r).filter(e => e.request?.id === req.id)
    assert.deepEqual(leave.map(e => e.date), ['2026-10-10', '2026-10-12'], '11 Oct is a Sunday')
    assert.ok(leave[0].flags.some(f => f.includes('attendance shows punches')))
    assert.equal(eventsOf(r).some(e => e.kind === 'absent' && e.date === '2026-10-12'), false,
      'a day covered by leave is not an unexplained absence')
  })

  test('leave crossing the month boundary contributes only this month\'s dates', () => {
    const req = request({ request_type: 'full_day_leave', start_date: '2026-10-30', end_date: '2026-11-03' })
    const r = buildReconciliation(input({ attendance: fullMonth({ '2026-10-30': null, '2026-10-31': null }), requests: [req] }))
    assert.deepEqual(eventsOf(r).filter(e => e.request?.id === req.id).map(e => e.date), ['2026-10-30', '2026-10-31'])
  })

  test('cancelled requests are ignored; a working day with nothing is an absence', () => {
    const req = request({ request_type: 'full_day_leave', status: 'cancelled', cancelled_at: '2026-10-01T00:00:00Z' })
    const r = buildReconciliation(input({ attendance: fullMonth({ '2026-10-05': null }), requests: [req] }))
    const evs = eventsOf(r).filter(e => e.date === '2026-10-05')
    assert.deepEqual(evs.map(e => e.kind), ['absent'])
  })

  test('absence is not asserted past the imported coverage', () => {
    const r = buildReconciliation(input({ attendance: [], coverageThrough: '2026-10-03' }))
    assert.deepEqual(eventsOf(r).map(e => e.date), ['2026-10-01', '2026-10-02', '2026-10-03'])
  })

  test('an approval ahead of the day is upcoming, not unresolved', () => {
    const req = request({ start_date: '2026-10-28', end_date: '2026-10-28', request_type: 'full_day_leave' })
    const r = buildReconciliation(input({ today: '2026-10-20', coverageThrough: '2026-10-20', attendance: fullMonth(), requests: [req] }))
    const ev = eventsOf(r).find(e => e.request?.id === req.id)!
    assert.equal(ev.upcoming, true)
    assert.equal(r.employees[0].unresolved_count, 0)
  })
})

describe('no duplicate deductions', () => {
  test('the review reads the draft charge once per event and never adds its own', () => {
    const r = buildReconciliation(input({
      draftGenerated: true,
      attendance: fullMonth({ '2026-10-05': ['10:40', '17:30'] }),
      draftLines: [
        { employee_id: EMP, line_date: '2026-10-05', deduction_type: 'late_arrival', hours_deducted: 1, amount_deducted: 118 },
        { employee_id: EMP, line_date: '2026-10-05', deduction_type: 'early_checkout', hours_deducted: 1, amount_deducted: 118 },
      ],
    }))
    const evs = eventsOf(r).filter(e => e.date === '2026-10-05')
    assert.deepEqual(evs.map(e => [e.kind, e.draft_amount]), [['late_arrival', 118], ['early_departure', 118]])
    const total = eventsOf(r).reduce((t, e) => t + (e.draft_amount ?? 0), 0)
    assert.equal(total, 236, 'the day totals exactly the draft — each line is attributed to one event')
  })

  test('a Paid/waived decision that the draft still charges is called out, not silently applied', () => {
    const base = input({
      draftGenerated: true,
      attendance: fullMonth({ '2026-10-05': ['10:40', '18:35'] }),
      draftLines: [{ employee_id: EMP, line_date: '2026-10-05', deduction_type: 'late_arrival', hours_deducted: 1, amount_deducted: 118 }],
    })
    const fp = eventsOf(buildReconciliation(base))[0].fingerprint
    const r = buildReconciliation({ ...base, reviews: [{
      id: 'r', employee_id: EMP, attendance_date: '2026-10-05', event_key: 'late_arrival', excused: false,
      excuse_reason: null, pay_decision: 'paid_waived', decision_reason: 'Vehicle', attendance_fingerprint: fp,
      reviewed_by: 'admin', reviewed_at: '2026-10-06T00:00:00Z',
    }] })
    const ev = eventsOf(r)[0]
    assert.equal(ev.resolved, true)
    assert.equal(ev.draft_amount, 118, 'the review never changes the figure')
    assert.ok(ev.decision_notes[0].includes('still deducts'))
  })

  test('a decision goes stale when the attendance changes after it', () => {
    const base = input({ attendance: fullMonth({ '2026-10-05': ['10:40', '18:35'] }) })
    const fp = eventsOf(buildReconciliation(base))[0].fingerprint
    const review: ReconReview = {
      id: 'r', employee_id: EMP, attendance_date: '2026-10-05', event_key: 'late_arrival', excused: false,
      excuse_reason: null, pay_decision: 'unpaid_actual', decision_reason: 'No notice', attendance_fingerprint: fp,
      reviewed_by: 'admin', reviewed_at: '2026-10-06T00:00:00Z',
    }
    assert.equal(eventsOf(buildReconciliation({ ...base, reviews: [review] }))[0].resolved, true)
    const changed = buildReconciliation({ ...base, reviews: [review], attendance: fullMonth({ '2026-10-05': ['10:55', '18:35'] }) })
    assert.equal(eventsOf(changed)[0].stale, true)
    assert.equal(eventsOf(changed)[0].resolved, false)
  })
})

describe('validateReviewInput', () => {
  const ok = { employee_id: EMP, attendance_date: '2026-10-05', event_key: 'late_arrival' }
  test('a salary treatment needs a reason; an excuse needs a reason', () => {
    assert.equal(validateReviewInput({ ...ok, pay_decision: 'paid_waived' }).ok, false)
    assert.equal(validateReviewInput({ ...ok, pay_decision: 'paid_waived', decision_reason: 'Vehicle' }).ok, true)
    assert.equal(validateReviewInput({ ...ok, excused: true }).ok, false)
    assert.equal(validateReviewInput({ ...ok, excused: true, excuse_reason: 'Emergency reported by phone' }).ok, true)
  })
  test('only late arrivals can be excused; event keys are closed', () => {
    assert.equal(validateReviewInput({ ...ok, event_key: 'absent', excused: true, excuse_reason: 'x' }).ok, false)
    assert.equal(validateReviewInput({ ...ok, event_key: 'anything', pay_decision: 'paid_waived', decision_reason: 'x' }).ok, false)
  })
})
