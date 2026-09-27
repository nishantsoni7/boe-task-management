import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildReconciliation, validateReviewInput, planReviewApplication, PAY_DECISIONS, type ReconInput, type ReconReview } from './requestReconciliation'
import type { AttendanceRequestRow } from './requests'
import { istClockToUtc } from '../istDate'

const EMP = 'e1'
const SCHEDULE = { scheduled_in_minutes: 600, grace_end_minutes: 615, scheduled_out_minutes: 1110, weekly_off_day: 0, rounding_block_minutes: 30, rounding_block_hours: 0.5 }

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
    assert.ok(timeOut.flags.some(f => f.includes('Actual time away unavailable')))
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

  const review = (o: Partial<ReconReview>): ReconReview => ({
    id: 'r', employee_id: EMP, attendance_date: '2026-10-05', event_key: 'late_arrival', excused: false,
    excuse_reason: null, pay_decision: 'paid_waived', decision_reason: 'Vehicle', attendance_fingerprint: '',
    reviewed_by: 'admin', reviewed_at: '2026-10-06T00:00:00Z', ...o,
  })
  const lateLine = { employee_id: EMP, line_date: '2026-10-05', deduction_type: 'late_arrival', hours_deducted: 1, amount_deducted: 118 }
  const waiverOn = (waiveLate: boolean, waiveEarly = false, out = '18:35') => ({
    id: 'c1', employee_id: EMP, attendance_date: '2026-10-05',
    corrected_check_in_at: istClockToUtc('2026-10-05', '10:40'), corrected_check_out_at: istClockToUtc('2026-10-05', out),
    day_treatment: 'auto', waive_late_arrival: waiveLate, waive_early_checkout: waiveEarly, waive_missing_punch: false, remark: 'x',
  })

  test('a Paid/waived decision the draft still charges is "Action required in payroll", never resolved', () => {
    const base = input({ draftGenerated: true, attendance: fullMonth({ '2026-10-05': ['10:40', '18:35'] }), draftLines: [lateLine] })
    const fp = eventsOf(buildReconciliation(base))[0].fingerprint
    const r = buildReconciliation({ ...base, reviews: [review({ attendance_fingerprint: fp })] })
    const ev = eventsOf(r)[0]
    assert.equal(ev.salary_status, 'action_required')
    assert.equal(ev.resolved, false, 'a saved decision alone is not a resolution')
    assert.equal(ev.draft_amount, 118, 'the review never changes the figure itself')
    assert.match(ev.action_note!, /still deducts ₹118/)
    assert.equal(ev.applies_in_one_step, true)
    assert.equal(r.employees[0].conflict_count, 1)
    assert.equal(r.totals.conflicts, 1)
  })

  test('once the correction waives it and the draft charges ₹0, the same decision is resolved', () => {
    const base = input({ draftGenerated: true, attendance: fullMonth({ '2026-10-05': ['10:40', '18:35'] }), corrections: [waiverOn(true)] })
    const fp = eventsOf(buildReconciliation(base))[0].fingerprint
    const ev = eventsOf(buildReconciliation({ ...base, reviews: [review({ attendance_fingerprint: fp })] }))[0]
    assert.equal(ev.waived_by_correction, true)
    assert.equal(ev.salary_status, 'resolved')
    assert.match(ev.payroll_state, /Waived in the draft by an attendance correction/)
  })

  test('Unpaid actual time conflicts with a waiver that is still in place', () => {
    const base = input({ draftGenerated: true, attendance: fullMonth({ '2026-10-05': ['10:40', '18:35'] }), corrections: [waiverOn(true)] })
    const fp = eventsOf(buildReconciliation(base))[0].fingerprint
    const ev = eventsOf(buildReconciliation({ ...base, reviews: [review({ pay_decision: 'unpaid_actual', attendance_fingerprint: fp })] }))[0]
    assert.equal(ev.salary_status, 'action_required')
    assert.match(ev.action_note!, /still waives/)
  })

  test('with no draft generated, a decision waits for one instead of reading as done', () => {
    const base = input({ attendance: fullMonth({ '2026-10-05': ['10:40', '18:35'] }) })
    const fp = eventsOf(buildReconciliation(base))[0].fingerprint
    const ev = eventsOf(buildReconciliation({ ...base, reviews: [review({ pay_decision: 'unpaid_actual', attendance_fingerprint: fp })] }))[0]
    assert.equal(ev.salary_status, 'no_draft')
    assert.equal(ev.resolved, false)
  })

  test('a decision goes stale, and says why, when the punches or the schedule change', () => {
    const base = input({ draftGenerated: true, attendance: fullMonth({ '2026-10-05': ['10:40', '18:35'] }), draftLines: [lateLine] })
    const fp = eventsOf(buildReconciliation(base))[0].fingerprint
    const rv = review({ pay_decision: 'unpaid_actual', decision_reason: 'No notice', attendance_fingerprint: fp })
    assert.equal(eventsOf(buildReconciliation({ ...base, reviews: [rv] }))[0].resolved, true)

    const punches = eventsOf(buildReconciliation({ ...base, reviews: [rv], attendance: fullMonth({ '2026-10-05': ['10:55', '18:35'] }) }))[0]
    assert.equal(punches.salary_status, 'stale')
    assert.equal(punches.resolved, false)
    assert.deepEqual(punches.stale_reasons, ['The punches changed.'])

    const schedule = eventsOf(buildReconciliation({ ...base, reviews: [rv], schedule: { ...SCHEDULE, grace_end_minutes: 620 } }))[0]
    assert.deepEqual(schedule.stale_reasons, ['The payroll schedule settings changed.'])
  })

  test('changing the same day\'s EARLY waiver does not make the late-arrival decision stale', () => {
    const base = input({ draftGenerated: true, attendance: fullMonth({ '2026-10-05': ['10:40', '17:30'] }),
      corrections: [waiverOn(false, false, '17:30')], draftLines: [lateLine] })
    const fp = eventsOf(buildReconciliation(base)).find(e => e.kind === 'late_arrival')!.fingerprint
    const rv = review({ pay_decision: 'unpaid_actual', attendance_fingerprint: fp })
    const late = eventsOf(buildReconciliation({ ...base, reviews: [rv], corrections: [waiverOn(false, true, '17:30')] }))
      .find(e => e.kind === 'late_arrival')!
    assert.equal(late.stale, false)
    assert.equal(late.resolved, true)
  })
})

describe('case 4 — time out with no mid-day punches', () => {
  test('requested 14:00–15:30 is shown, never measured, never charged, and cannot be decided as unpaid', () => {
    const req = request({ request_type: 'time_out', departure_time: '14:00:00', return_time: '15:30:00', work_kind: 'personal', reason_code: 'personal' })
    const r = buildReconciliation(input({ draftGenerated: true, attendance: fullMonth(), requests: [req] }))
    const ev = eventsOf(r).find(e => e.request?.id === req.id)!
    assert.match(ev.title, /requested 14:00–15:30/)
    assert.match(ev.title, /actual time away unavailable/)
    assert.equal(ev.request!.requested_departure, '14:00')
    assert.equal(ev.draft_amount, 0, 'no line is attributed to a time out')
    assert.deepEqual(ev.allowed_decisions, ['paid_waived', 'needs_correction'])
    assert.equal(ev.applies_in_one_step, false)
    assert.match(ev.one_step_blocker!, /Actual time away unavailable/)
    assert.equal(eventsOf(r).length, 1, 'no invented early-departure or 90-minute event')
  })
})

describe('case 5 — automatic paid leave is described, not claimed as chosen', () => {
  test('a ₹0 absent line with no credits is described as the automatic paid-leave rule', () => {
    const r = buildReconciliation(input({
      draftGenerated: true, attendance: fullMonth({ '2026-10-05': null }),
      draftLines: [{ employee_id: EMP, line_date: '2026-10-05', deduction_type: 'absent', hours_deducted: 0, amount_deducted: 0 }],
    }))
    const ev = eventsOf(r).find(e => e.kind === 'absent')!
    assert.match(ev.payroll_state, /automatic paid leave/)
    assert.match(ev.payroll_state, /not a manual choice/)
    assert.equal((PAY_DECISIONS as readonly string[]).includes('use_paid_leave'), false)
  })

  test('the same ₹0 covered by BOE Credits says so instead', () => {
    const r = buildReconciliation(input({
      draftGenerated: true, attendance: fullMonth({ '2026-10-05': null }),
      draftLines: [{ employee_id: EMP, line_date: '2026-10-05', deduction_type: 'absent', hours_deducted: 0, amount_deducted: 0 }],
      redemptions: [{ employee_id: EMP, attendance_date: '2026-10-05', deduction_type: 'absent', credits: 4 }],
    }))
    assert.match(eventsOf(r).find(e => e.kind === 'absent')!.payroll_state, /BOE Credits \(4\)/)
  })
})

describe('planReviewApplication — decision → correction', () => {
  type PlanEvent = Parameters<typeof planReviewApplication>[0]
  const ev = (o: Partial<PlanEvent> = {}): PlanEvent => ({
    event_key: 'late_arrival', date: '2026-10-05', one_step_blocker: null,
    day_state: { raw: { check_in_at: 'IN', check_out_at: 'OUT', direction_confirmed: true }, correction: null },
    ...o,
  })
  const corr = (o: Record<string, unknown>) => ({
    id: 'c', employee_id: EMP, attendance_date: '2026-10-05', corrected_check_in_at: 'CIN', corrected_check_out_at: 'COUT',
    day_treatment: 'auto', waive_late_arrival: false, waive_early_checkout: false, waive_missing_punch: false, remark: 'old', ...o,
  })

  test('Paid / waived with no correction copies the raw punches and sets only the late waiver', () => {
    const plan = planReviewApplication(ev(), 'paid_waived', 'Payroll review: Paid / waived — Vehicle')
    assert.deepEqual(plan, { kind: 'apply', correction: {
      attendance_date: '2026-10-05', corrected_check_in_at: 'IN', corrected_check_out_at: 'OUT',
      day_treatment: 'auto', waive_late_arrival: true, waive_early_checkout: false, waive_missing_punch: false,
      remark: 'Payroll review: Paid / waived — Vehicle',
    } })
  })

  test('an existing correction is carried over: its punches and other waivers are kept', () => {
    const plan = planReviewApplication(ev({ day_state: { raw: null, correction: corr({ waive_early_checkout: true }) } }), 'paid_waived', 'r')
    assert.ok(plan.kind === 'apply' && plan.correction.waive_early_checkout && plan.correction.corrected_check_in_at === 'CIN')
  })

  test('saving the same decision twice writes nothing the second time — no double waiver', () => {
    assert.deepEqual(planReviewApplication(ev({ day_state: { raw: null, correction: corr({ waive_late_arrival: true }) } }), 'paid_waived', 'r'), { kind: 'none' })
    assert.deepEqual(planReviewApplication(ev(), 'unpaid_actual', 'r'), { kind: 'none' }, 'unpaid with no waiver already matches')
  })

  test('a guessed lone punch, a manual day treatment, or an absence goes to the payslip instead', () => {
    const guessed = ev({ event_key: 'missing_punch', one_step_blocker: 'guessed',
      day_state: { raw: { check_in_at: 'IN', check_out_at: null, direction_confirmed: false }, correction: null } })
    assert.equal(planReviewApplication(guessed, 'paid_waived', 'r').kind, 'action_required')
    assert.equal(planReviewApplication(ev({ day_state: { raw: null, correction: corr({ day_treatment: 'full_day' }) } }), 'paid_waived', 'r').kind, 'action_required')
    assert.equal(planReviewApplication(ev({ event_key: 'absent' }), 'paid_waived', 'r').kind, 'action_required')
    assert.deepEqual(planReviewApplication(ev(), 'needs_correction', 'r'), { kind: 'none' })
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

describe('item 1 — the charge is explained with the payroll rule and the draft figure', () => {
  const lateLine = (h: number, amt: number, date = '2026-10-05') =>
    ({ employee_id: EMP, line_date: date, deduction_type: 'late_arrival', hours_deducted: h, amount_deducted: amt })

  test('"40 minutes late · payroll rule charges 1 hour · ₹118 proposed in the draft"', () => {
    const r = buildReconciliation(input({ draftGenerated: true, attendance: fullMonth({ '2026-10-05': ['10:40', '18:35'] }), draftLines: [lateLine(1, 118)] }))
    const ev = eventsOf(r).find(e => e.kind === 'late_arrival')!
    assert.equal(ev.charge?.text, '40 minutes late · payroll rule charges 1 hour · ₹118 proposed in the draft')
    assert.equal(ev.charge?.rule_hours, 1)
    assert.equal(ev.charge?.draft_hours, 1)
    assert.match(ev.charge!.rule_text, /up to 15 minutes past the scheduled time costs nothing; beyond that, the time is rounded up to the next 30 minutes and charged at 0.5 hour/)
  })

  test('the rule is the engine\'s: 16 min → ½ hour, 30 → ½, 31 → 1, 91 → 2; within grace → nothing', () => {
    const at = (clock: string) => {
      const r = buildReconciliation(input({ attendance: fullMonth({ '2026-10-05': [clock, '18:35'] }) }))
      return eventsOf(r).find(e => e.kind === 'late_arrival')?.charge ?? null
    }
    assert.equal(at('10:16')?.rule_hours, 0.5)
    assert.equal(at('10:30')?.rule_hours, 0.5)
    assert.equal(at('10:31')?.rule_hours, 1)
    assert.equal(at('11:31')?.rule_hours, 2)
    assert.equal(at('10:15'), null, 'inside the grace period there is no late event at all')
    assert.match(at('10:16')!.text, /no payroll draft yet/)
  })

  test('early departure uses the same rule; a waived one says ₹0 without inventing an amount', () => {
    const corr = {
      id: 'c', employee_id: EMP, attendance_date: '2026-10-05',
      corrected_check_in_at: istClockToUtc('2026-10-05', '09:55'), corrected_check_out_at: istClockToUtc('2026-10-05', '17:50'),
      day_treatment: 'auto', waive_late_arrival: false, waive_early_checkout: true, waive_missing_punch: false, remark: 'x',
    }
    const r = buildReconciliation(input({ draftGenerated: true, attendance: fullMonth({ '2026-10-05': ['09:55', '17:50'] }), corrections: [corr] }))
    const ev = eventsOf(r).find(e => e.kind === 'early_departure')!
    assert.equal(ev.charge?.text, '40 minutes early · payroll rule charges 1 hour · waived by attendance correction — ₹0 in the draft')
  })

  test('when the draft charges different hours from the rule, both are shown', () => {
    const r = buildReconciliation(input({ draftGenerated: true, attendance: fullMonth({ '2026-10-05': ['10:40', '18:35'] }), draftLines: [lateLine(1.5, 176)] }))
    assert.match(eventsOf(r).find(e => e.kind === 'late_arrival')!.charge!.text, /₹176 proposed in the draft · the draft charges 1.5 hours — see the payslip/)
  })
})

describe('item 3 — notice given on time stays "informed" even when the request is rejected', () => {
  test('rejected but submitted before 10:00: informed, not counted, timestamp and label untouched; Unpaid still allowed', () => {
    const rejected = request({ status: 'rejected', decision_note: 'Reason not accepted', informed_before_shift: true, submitted_at: '2026-10-05T03:00:00.000Z' })
    const r = buildReconciliation(input({ draftGenerated: true, attendance: fullMonth({ '2026-10-05': ['10:40', '18:35'] }), requests: [rejected] }))
    const ev = eventsOf(r).find(e => e.kind === 'late_arrival')!
    assert.equal(ev.informed, true)
    assert.equal(ev.counts_toward_policy, false)
    assert.equal(ev.request?.submitted_at, '2026-10-05T03:00:00.000Z')
    assert.equal(ev.request?.informed_before_shift, true)
    assert.ok(ev.flags.includes('The request was rejected.'))
    assert.ok(ev.allowed_decisions.includes('unpaid_actual'), 'payroll may still treat the time as unpaid')
  })

  test('the same request submitted after 10:00 is uninformed whatever its decision', () => {
    for (const status of ['approved', 'rejected', 'pending'] as const) {
      const late = request({ status, informed_before_shift: false, submitted_at: '2026-10-05T05:00:00.000Z', decision_note: status === 'rejected' ? 'x' : null })
      const r = buildReconciliation(input({ attendance: fullMonth({ '2026-10-05': ['10:40', '18:35'] }), requests: [late] }))
      assert.equal(eventsOf(r).find(e => e.kind === 'late_arrival')!.informed, false, status)
    }
  })
})
