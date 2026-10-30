// The Overview's month, run through the real payroll engine. Nothing here stubs the
// classification: if the engine's reading of a day changes, these fail.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildOverview, buildScoreIndex, chooseDefaultMonth, scoreDay, shiftMonth,
  type ScoreContext, type ScoreEmployee, type ScoreRecord,
} from './attendanceScoreboard'
import { attentionReason, dayKind, emptyTally, greatReason, NOTHING_APPROVED, scoreBand, sparkLine, usualArrivalMinutes } from './attendanceScore'
import { DEFAULT_PAYROLL_SETTINGS } from '../payroll/settings'

const context = (over: Partial<ScoreContext> = {}): ScoreContext => ({
  settings: DEFAULT_PAYROLL_SETTINGS,
  corrections: [],
  requests: [],
  holidays: [],
  ...over,
})

const person = (id: string, over: Partial<ScoreEmployee> = {}): ScoreEmployee => ({
  id,
  full_name: `Person ${id}`,
  employee_code: null,
  joining_date: null,
  exit_date: null,
  minop_user_id: id,
  ...over,
})

let nextId = 0
const punch = (user: string, date: string, inAt: string | null, outAt: string | null): ScoreRecord => ({
  id: String(++nextId),
  user_id: user,
  attendance_date: date,
  check_in_at: inAt ? `${date}T${inAt}:00+05:30` : null,
  check_out_at: outAt ? `${date}T${outAt}:00+05:30` : null,
  punch_direction_source: null,
})

const kindOf = (record: ScoreRecord | null, ctx: ScoreContext = context(), user = 'a', date = '2026-09-07') =>
  scoreDay(buildScoreIndex(record ? [record] : [], ctx), user, date).kind

describe('a day reads as payroll reads it', () => {
  test('in by 10:15 and out by 18:30 is on time', () => {
    assert.equal(kindOf(punch('a', '2026-09-07', '10:15', '18:30')), 'ok')
  })

  test('past 10:15 is late, and 10:05 is not', () => {
    assert.equal(kindOf(punch('a', '2026-09-07', '10:16', '18:45')), 'late')
    assert.equal(kindOf(punch('a', '2026-09-07', '10:05', '18:45')), 'ok')
  })

  test('leaving before 18:15 is left early', () => {
    assert.equal(kindOf(punch('a', '2026-09-07', '09:55', '18:00')), 'early')
  })

  test('one punch is a missing punch', () => {
    assert.equal(kindOf(punch('a', '2026-09-07', '10:00', null)), 'miss')
  })

  test('a short day is a half day, though its stored status says present', () => {
    assert.equal(kindOf(punch('a', '2026-09-07', '10:00', '13:00')), 'half')
  })

  test('no punches on a working day is absent', () => {
    assert.equal(kindOf(null), 'absent')
  })
})

describe('what an admin decided is honoured', () => {
  const correction = (over = {}) => ({
    user_id: 'a',
    attendance_date: '2026-09-07',
    corrected_check_in_at: '2026-09-07T10:40:00+05:30',
    corrected_check_out_at: '2026-09-07T18:45:00+05:30',
    day_treatment: 'auto' as const,
    waive_late_arrival: false,
    waive_early_checkout: false,
    waive_missing_punch: false,
    ...over,
  })

  test('a waived late arrival is on time', () => {
    const late = punch('a', '2026-09-07', '10:40', '18:45')
    assert.equal(kindOf(late), 'late')
    assert.equal(kindOf(late, context({ corrections: [correction({ waive_late_arrival: true })] })), 'ok')
  })

  test('a waived missing punch is not a missing punch', () => {
    const one = punch('a', '2026-09-07', '10:00', null)
    const waived = correction({
      corrected_check_in_at: '2026-09-07T10:00:00+05:30',
      corrected_check_out_at: null,
      waive_missing_punch: true,
    })
    assert.equal(kindOf(one, context({ corrections: [waived] })), 'ok')
  })

  test('a corrected day uses the corrected punches', () => {
    const corrected = correction({ corrected_check_in_at: '2026-09-07T09:58:00+05:30' })
    assert.equal(kindOf(punch('a', '2026-09-07', '10:40', '18:45'), context({ corrections: [corrected] })), 'ok')
  })

  test('approved leave is not an absence', () => {
    const leave = { employee_id: 'a', request_type: 'full_day_leave', start_date: '2026-09-07', end_date: '2026-09-08' }
    assert.equal(kindOf(null, context({ requests: [leave] })), 'leave')
    assert.equal(kindOf(null, context({ requests: [leave] }), 'a', '2026-09-08'), 'leave')
  })

  test('an approved late arrival does not count against the person', () => {
    const late = { employee_id: 'a', request_type: 'late_arrival', start_date: '2026-09-07', end_date: '2026-09-07' }
    assert.equal(kindOf(punch('a', '2026-09-07', '10:40', '18:45'), context({ requests: [late] })), 'ok')
  })

  test('an approved half day that was worked is left out of the score', () => {
    const half = { employee_id: 'a', request_type: 'half_day', start_date: '2026-09-07', end_date: '2026-09-07' }
    assert.equal(kindOf(punch('a', '2026-09-07', '10:00', '13:00'), context({ requests: [half] })), 'leave')
  })

  test('an approved half day with no attendance at all is still absent', () => {
    const half = { employee_id: 'a', request_type: 'half_day', start_date: '2026-09-07', end_date: '2026-09-07' }
    assert.equal(kindOf(null, context({ requests: [half] })), 'absent')
  })

  test('someone else\'s approval changes nothing', () => {
    const leave = { employee_id: 'b', request_type: 'full_day_leave', start_date: '2026-09-07', end_date: '2026-09-07' }
    assert.equal(kindOf(null, context({ requests: [leave] })), 'absent')
  })
})

/** Every working day of September 2026 on time, with `changes` by date. */
function september(user: string, changes: Record<string, [string | null, string | null] | null> = {}): ScoreRecord[] {
  const rows: ScoreRecord[] = []
  for (let d = 1; d <= 30; d++) {
    const date = `2026-09-${String(d).padStart(2, '0')}`
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) continue
    const change = changes[date]
    if (change === null) continue
    rows.push(punch(user, date, change?.[0] ?? '10:00', change?.[1] ?? '18:45'))
  }
  return rows
}

const OCTOBER_NOW = new Date('2026-10-20T12:00:00+05:30')

const overview = (employees: ScoreEmployee[], records: ScoreRecord[], over: Partial<ScoreContext> = {}, now = OCTOBER_NOW) =>
  buildOverview({
    employees, records, context: context(over), year: 2026, month: 9, pendingRequests: 0, fellBackFrom: null, now,
  })

describe('the month', () => {
  test('a perfect month scores 100 and ranks first', () => {
    const data = overview([person('a'), person('b')], [
      ...september('a'),
      ...september('b', { '2026-09-07': ['10:40', '18:45'] }),
    ])
    assert.equal(data.people[0].id, 'a')
    assert.equal(data.people[0].score, 100)
    assert.equal(data.people[0].rank, 1)
    assert.equal(data.people[0].band, 'great')
    assert.equal(data.people[1].rank, 2)
  })

  test('the points add up: 26 working days, one late, one absent', () => {
    const data = overview([person('a')], september('a', {
      '2026-09-07': ['10:40', '18:45'],
      '2026-09-08': null,
    }))
    const [p] = data.people
    assert.equal(p.counted, 26)
    assert.equal(p.tally.late, 1)
    assert.equal(p.tally.absent, 1)
    assert.equal(p.score, Math.round((24 + 0.75) / 26 * 100))
  })

  test('approved leave leaves the day out rather than counting it', () => {
    const data = overview([person('a')], september('a', { '2026-09-07': null }), {
      requests: [{ employee_id: 'a', request_type: 'full_day_leave', start_date: '2026-09-07', end_date: '2026-09-07' }],
    })
    assert.equal(data.people[0].score, 100)
    assert.equal(data.people[0].counted, 25)
    assert.equal(data.people[0].tally.leave, 1)
  })

  test('a full-day holiday is not a working day, and a Sunday shows as off', () => {
    const data = overview([person('a')], september('a', { '2026-09-07': null }), {
      holidays: [{ holiday_date: '2026-09-07', holiday_type: 'full_day', half_session: null }],
    })
    const [p] = data.people
    assert.equal(p.score, 100)
    assert.equal(p.strip.find(d => d.date === '2026-09-07')?.kind, 'off')
    assert.equal(p.strip.find(d => d.date === '2026-09-06')?.kind, 'off')
  })

  test('days before joining are not absences', () => {
    const employee = person('a', { joining_date: '2026-09-21' })
    const data = overview([employee], september('a').filter(r => r.attendance_date >= '2026-09-21'))
    const [p] = data.people
    assert.equal(p.tally.absent, 0)
    assert.equal(p.score, 100)
    assert.equal(p.strip.find(d => d.date === '2026-09-14')?.kind, 'not_employed')
  })

  test('under five counted days is not ranked, and says why', () => {
    const employee = person('a', { joining_date: '2026-09-28' })
    const data = overview([employee], september('a').filter(r => r.attendance_date >= '2026-09-28'))
    const [p] = data.people
    assert.equal(p.score, null)
    assert.equal(p.rank, null)
    assert.match(p.notRanked ?? '', /Joined 28 Sept?, 3 days so far/)
  })

  test('someone who had not joined yet is left off the month', () => {
    const data = overview([person('a'), person('b', { joining_date: '2026-12-01' })], september('a'))
    assert.deepEqual(data.people.map(p => p.id), ['a'])
  })

  test('the month before is the delta, and months with no data are gaps', () => {
    const augustLate = punch('a', '2026-08-03', '10:40', '18:45')
    const august: ScoreRecord[] = [augustLate]
    for (let d = 4; d <= 8; d++) august.push(punch('a', `2026-08-0${d}`, '10:00', '18:45'))
    const data = overview([person('a')], [...august, ...september('a')])
    const [p] = data.people
    assert.equal(p.history.length, 6)
    assert.equal(p.history[5], 100)
    assert.equal(p.history[3], null, 'July has no data')
    assert.equal(p.delta, 100 - (p.history[4] as number))
  })
})

describe('the machine months', () => {
  const NOV_NOW = new Date('2026-11-20T12:00:00+05:30')
  const november = (user: string): ScoreRecord[] => ['02', '03', '04', '05', '06', '07', '09', '10', '11', '12', '13', '14', '16', '17', '18', '19', '20']
    .map(day => punch(user, `2026-11-${day}`, '10:00', day === '20' ? null : '18:45'))

  const nov = (employees: ScoreEmployee[], records: ScoreRecord[]) => buildOverview({
    employees, records, context: context(), year: 2026, month: 11, pendingRequests: 0, fellBackFrom: null, now: NOV_NOW,
  })

  test('no Machine ID is unknown, never absent, and is not ranked', () => {
    const data = nov([person('a'), person('b', { minop_user_id: null })], november('a'))
    const b = data.people.find(p => p.id === 'b')!
    assert.equal(b.score, null)
    assert.equal(b.tally.absent, 0)
    assert.equal(b.notRanked, 'No Machine ID yet, so no punches can be read')
    assert.equal(b.strip.find(d => d.date === '2026-11-10')?.kind, 'unknown')
    assert.equal(data.noMachineId, 1)
  })

  test('today is never counted, so a half-finished day is not a missing punch', () => {
    const data = nov([person('a')], november('a'))
    const [p] = data.people
    assert.equal(data.coverageThrough, '2026-11-19')
    assert.equal(p.strip.find(d => d.date === '2026-11-20')?.kind, 'pending')
    assert.equal(p.tally.miss, 0)
  })

  test('the same person in an Excel month needs no Machine ID', () => {
    const data = overview([person('a', { minop_user_id: null })], september('a'))
    assert.equal(data.people[0].score, 100)
  })
})

describe('which month opens', () => {
  test('the current month once it has five counted days', () => {
    const records = ['02', '03', '04', '05', '06', '07'].map(d => punch('a', `2026-11-${d}`, '10:00', '18:45'))
    assert.deepEqual(chooseDefaultMonth(records, [], new Date('2026-11-09T12:00:00+05:30')), { year: 2026, month: 11 })
  })

  test('otherwise the newest month with enough, skipping one not uploaded', () => {
    const records = [punch('a', '2026-11-02', '10:00', '18:45'), ...september('a')]
    assert.deepEqual(chooseDefaultMonth(records, [], new Date('2026-11-03T12:00:00+05:30')), { year: 2026, month: 9 })
  })

  test('the current month when there is nothing at all', () => {
    assert.deepEqual(chooseDefaultMonth([], [], new Date('2026-11-03T12:00:00+05:30')), { year: 2026, month: 11 })
  })

  test('months move across a year end', () => {
    assert.deepEqual(shiftMonth({ year: 2026, month: 1 }, -2), { year: 2025, month: 11 })
    assert.deepEqual(shiftMonth({ year: 2026, month: 12 }, 1), { year: 2027, month: 1 })
  })
})

describe('the rules', () => {
  test('bands', () => {
    assert.equal(scoreBand(95), 'great')
    assert.equal(scoreBand(94), 'okay')
    assert.equal(scoreBand(85), 'okay')
    assert.equal(scoreBand(84), 'attention')
  })

  test('a day that was absent stays absent however it was punched', () => {
    assert.equal(dayKind({ classification: 'full_absent', late: false, early: false, missing: false, approved: NOTHING_APPROVED }), 'absent')
  })

  test('someone on approved leave who came in for a full day is scored on it', () => {
    const approved = { ...NOTHING_APPROVED, fullLeave: true }
    assert.equal(dayKind({ classification: 'full_present', late: true, early: false, missing: false, approved }), 'late')
  })

  test('the usual arrival is the middle one, not the mean', () => {
    assert.equal(usualArrivalMinutes([600, 601, 900]), 601)
    assert.equal(usualArrivalMinutes([600, 610]), 605)
    assert.equal(usualArrivalMinutes([]), null)
  })

  test('the trend line skips a gap and ends on the newest score', () => {
    const line = sparkLine([90, null, 100], 110, 30, 60, 100)
    assert.equal(line.points.split(' ').length, 2)
    assert.equal(line.end?.x, 105)
    assert.equal(line.end?.y, 5)
  })
})

describe('the reason lines', () => {
  test('a perfect month and a nearly perfect one', () => {
    assert.equal(greatReason({ ...emptyTally(), ok: 23 }), 'On time on all 23 days')
    assert.equal(greatReason({ ...emptyTally(), ok: 19, late: 2, miss: 1, leave: 1 }), 'On time on 19 of 22 days, 1 approved leave')
  })

  test('absences all on one weekday are named', () => {
    const line = attentionReason({
      tally: { ...emptyTally(), ok: 16, late: 4, absent: 3 },
      absentDates: ['2026-11-02', '2026-11-16', '2026-11-23'],
      usualArrival: null, delta: -7, previousMonthName: 'October',
    })
    assert.equal(line, 'All 3 absent days were Mondays, 7 points down on October')
  })

  test('someone late most days is told how late', () => {
    const line = attentionReason({
      tally: { ...emptyTally(), ok: 8, late: 14, miss: 1 },
      absentDates: [], usualArrival: 638, delta: -1, previousMonthName: 'October',
    })
    assert.equal(line, 'Late on 14 of 23 days, usually in at 10:38')
  })

  test('otherwise the two biggest causes', () => {
    const line = attentionReason({
      tally: { ...emptyTally(), ok: 8, late: 7, miss: 2, half: 1, absent: 5 },
      absentDates: ['2026-11-03', '2026-11-04', '2026-11-11', '2026-11-17', '2026-11-25'],
      usualArrival: 627, delta: -8, previousMonthName: 'October',
    })
    assert.equal(line, '5 absent days and 7 late, 8 points down on October')
  })
})
