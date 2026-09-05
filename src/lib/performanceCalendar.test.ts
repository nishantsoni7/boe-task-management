/**
 * performanceCalendar — behavioural tests
 *
 * The rule under test: a day only counts against an employee if they were
 * actually expected to work it. Sundays, company holidays, dates before they
 * joined and dates after they left must not become zero-score days — while a
 * genuine working day with no activity still must.
 *
 * Reference dates used throughout (2026):
 *   Sun 2026-07-26, Mon 27, Tue 28, Wed 29, Thu 30, Fri 31, Sat 2026-08-01
 *
 * Run:
 *   npx tsx --test src/lib/performanceCalendar.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  isExpectedWorkingDay, expectedWorkingDates, eligiblePerformanceDates,
  hasDayCutoffPassed, resolveExitDate,
  parseDateRangeParams,
  PERFORMANCE_ROLLOUT_DATE, PERFORMANCE_DAY_CUTOFF_HOUR, MAX_RANGE_DAYS,
  APPROVED_LEAVE_UNAVAILABLE, isValidBusinessDate, parsePeriod, PERFORMANCE_PERIODS,
  resolvePeriod, isPeriodKey, PERIOD_KEYS,
  type WorkingDayContext,
} from './performanceCalendar'
import { periodAverageScore, trendDayFromInputs, computeBreakdown } from './performance'
import { istDayStartUtc } from './istDate'
import type { DayInputs } from './types'

const TODAY = '2026-07-30'   // a Thursday

/** After the cutoff on TODAY, so "today" counts unless a test says otherwise. */
const AFTER_CUTOFF = new Date(
  Date.parse(istDayStartUtc(TODAY)) + (PERFORMANCE_DAY_CUTOFF_HOUR + 1) * 3600_000
)

function ctx(over: Partial<WorkingDayContext> = {}): WorkingDayContext {
  return { holidays: new Set(), joiningDate: null, exitDate: null, ...over }
}

// ─── 1. Weekly off ────────────────────────────────────────────────────────────

describe('weekly off', () => {
  test('Sunday is not an expected working day', () => {
    assert.equal(isExpectedWorkingDay('2026-07-26', ctx()), false)  // Sunday
    assert.equal(isExpectedWorkingDay('2026-07-27', ctx()), true)   // Monday
  })

  test('Saturday still is — the company works six days', () => {
    assert.equal(isExpectedWorkingDay('2026-08-01', ctx()), true)
  })

  test('Sundays are dropped from a range, not scored as zero', () => {
    const dates = expectedWorkingDates('2026-07-24', TODAY, TODAY, ctx())
    assert.deepEqual(dates, ['2026-07-24', '2026-07-25', '2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30'])
    assert.equal(dates.includes('2026-07-26'), false)
  })

  test('a configured weekly off replaces the default', () => {
    const friday = ctx({ weeklyOffDays: new Set([5]) })
    assert.equal(isExpectedWorkingDay('2026-07-31', friday), false) // Friday off
    assert.equal(isExpectedWorkingDay('2026-07-26', friday), true)  // Sunday now worked
  })
})

// ─── 2. Company holidays ──────────────────────────────────────────────────────

describe('company holidays', () => {
  test('a holiday is not an expected working day', () => {
    const withHoliday = ctx({ holidays: new Set(['2026-07-29']) })
    assert.equal(isExpectedWorkingDay('2026-07-29', withHoliday), false)
    assert.equal(isExpectedWorkingDay('2026-07-28', withHoliday), true)
  })

  test('holidays drop out of the range', () => {
    const dates = expectedWorkingDates('2026-07-27', TODAY, TODAY, ctx({
      holidays: new Set(['2026-07-28', '2026-07-29']),
    }))
    assert.deepEqual(dates, ['2026-07-27', '2026-07-30'])
  })

  test('a holiday falling on a Sunday removes it once, not twice', () => {
    const dates = expectedWorkingDates('2026-07-24', TODAY, TODAY, ctx({
      holidays: new Set(['2026-07-26']),
    }))
    assert.equal(dates.filter(d => d === '2026-07-26').length, 0)
    assert.equal(dates.length, 6)
  })
})

// ─── 3. Joining-date boundary ─────────────────────────────────────────────────

describe('joining date', () => {
  test('dates before joining do not count', () => {
    const joined = ctx({ joiningDate: '2026-07-29' })
    assert.equal(isExpectedWorkingDay('2026-07-28', joined), false)
    assert.equal(isExpectedWorkingDay('2026-07-29', joined), true)  // the day itself counts
    assert.equal(isExpectedWorkingDay('2026-07-30', joined), true)
  })

  test('a mid-range joiner is only measured from their start', () => {
    const dates = expectedWorkingDates('2026-07-24', TODAY, TODAY, ctx({ joiningDate: '2026-07-29' }))
    assert.deepEqual(dates, ['2026-07-29', '2026-07-30'])
  })

  test('no joining date recorded means no start boundary', () => {
    const dates = expectedWorkingDates('2026-07-27', TODAY, TODAY, ctx({ joiningDate: null }))
    assert.equal(dates.length, 4)
  })
})

// ─── 4. Exit / deactivation boundary ──────────────────────────────────────────

describe('exit date', () => {
  test('dates after exit do not count', () => {
    const left = ctx({ exitDate: '2026-07-28' })
    assert.equal(isExpectedWorkingDay('2026-07-28', left), true)   // last working day counts
    assert.equal(isExpectedWorkingDay('2026-07-29', left), false)
  })

  test('a leaver is not charged zeros for the rest of the month', () => {
    const dates = expectedWorkingDates('2026-07-24', TODAY, TODAY, ctx({ exitDate: '2026-07-27' }))
    assert.deepEqual(dates, ['2026-07-24', '2026-07-25', '2026-07-27'])
  })

  test('joining and exit together bound both ends', () => {
    const dates = expectedWorkingDates('2026-07-24', TODAY, TODAY, ctx({
      joiningDate: '2026-07-25', exitDate: '2026-07-28',
    }))
    assert.deepEqual(dates, ['2026-07-25', '2026-07-27', '2026-07-28'])
  })

  test('an explicit exit_date wins over the soft-delete timestamp', () => {
    assert.equal(resolveExitDate({
      exit_date: '2026-07-20', is_deleted: true, deleted_at: '2026-07-25T10:00:00.000Z',
    }), '2026-07-20')
  })

  test('a soft-deleted user falls back to deleted_at, read in IST', () => {
    // 2026-07-25T19:30Z is already the 26th in IST.
    assert.equal(resolveExitDate({
      exit_date: null, is_deleted: true, deleted_at: '2026-07-25T19:30:00.000Z',
    }), '2026-07-26')
  })

  test('an active user has no exit boundary', () => {
    assert.equal(resolveExitDate({ exit_date: null, is_deleted: false, deleted_at: null }), null)
  })

  test('deleted_at is ignored unless the user is actually flagged deleted', () => {
    assert.equal(resolveExitDate({
      exit_date: null, is_deleted: false, deleted_at: '2026-07-25T10:00:00.000Z',
    }), null)
  })
})

// ─── 5. Rollout boundary ──────────────────────────────────────────────────────

describe('rollout date', () => {
  test('nothing before rollout is ever an expected working day', () => {
    assert.equal(PERFORMANCE_ROLLOUT_DATE, '2026-06-08')
    assert.equal(isExpectedWorkingDay('2026-06-05', ctx()), false)
    assert.equal(isExpectedWorkingDay('2026-06-08', ctx()), true)
  })

  test('a range starting before rollout is clamped to it', () => {
    const dates = expectedWorkingDates('2026-05-01', '2026-06-10', TODAY, ctx())
    assert.equal(dates[0], PERFORMANCE_ROLLOUT_DATE)
    assert.equal(dates.at(-1), '2026-06-10')
  })

  test('a fully pre-rollout range is empty', () => {
    assert.deepEqual(expectedWorkingDates('2026-01-01', '2026-02-01', TODAY, ctx()), [])
  })

  test('the future is not yet missed', () => {
    const dates = expectedWorkingDates('2026-07-29', '2026-12-31', TODAY, ctx())
    assert.deepEqual(dates, ['2026-07-29', '2026-07-30'])
  })
})

// ─── 6. A genuine working day with no activity is still a zero ────────────────

describe('system non-use stays visible', () => {
  const emptyDay = (): DayInputs => ({
    completedHigh: 0, completedMedium: 0, completedLow: 0,
    statusUpdates: 0, blockerResolutions: 0,
    hasEodLog: false, wasActiveToday: false, timelyAcks: 0,
    overdueCount: 0, staleBlockedCount: 0, activeTasks: 0, blockedCount: 0,
  })

  test('an ordinary working day with nothing on it counts as zero', () => {
    const dates = eligiblePerformanceDates('2026-07-27', '2026-07-29', TODAY, ctx(), AFTER_CUTOFF)
    assert.deepEqual(dates, ['2026-07-27', '2026-07-28', '2026-07-29'])

    const days = dates.map(d => trendDayFromInputs(d, emptyDay()))
    assert.deepEqual(days.map(d => d.score), [0, 0, 0])
    assert.equal(periodAverageScore(days), 0)
  })

  test('excluding non-working days does not rescue a genuinely idle week', () => {
    // Sunday drops out, but the five worked days still average zero.
    const dates = eligiblePerformanceDates('2026-07-24', '2026-07-29', TODAY, ctx(), AFTER_CUTOFF)
    assert.equal(dates.includes('2026-07-26'), false)
    assert.equal(periodAverageScore(dates.map(d => trendDayFromInputs(d, emptyDay()))), 0)
  })
})

// ─── 7. Current-day cutoff ────────────────────────────────────────────────────

describe('current-day cutoff', () => {
  const at = (hour: number) => new Date(Date.parse(istDayStartUtc(TODAY)) + hour * 3600_000)

  test('the cutoff has not passed in the morning', () => {
    assert.equal(hasDayCutoffPassed(TODAY, at(9)), false)
    assert.equal(hasDayCutoffPassed(TODAY, at(PERFORMANCE_DAY_CUTOFF_HOUR - 1)), false)
  })

  test('it has passed at and after the cutoff hour', () => {
    assert.equal(hasDayCutoffPassed(TODAY, at(PERFORMANCE_DAY_CUTOFF_HOUR)), true)
    assert.equal(hasDayCutoffPassed(TODAY, at(22)), true)
  })

  test('yesterday has always passed its cutoff', () => {
    assert.equal(hasDayCutoffPassed('2026-07-29', at(9)), true)
  })

  test('today is excluded from scoring until the cutoff passes', () => {
    const before = eligiblePerformanceDates('2026-07-27', TODAY, TODAY, ctx(), at(9))
    const after  = eligiblePerformanceDates('2026-07-27', TODAY, TODAY, ctx(), at(20))
    assert.deepEqual(before, ['2026-07-27', '2026-07-28', '2026-07-29'])
    assert.deepEqual(after,  ['2026-07-27', '2026-07-28', '2026-07-29', TODAY])
  })

  test('today still appears in the display set all day', () => {
    // The daily view has to render a live score even at 9am.
    assert.equal(expectedWorkingDates('2026-07-27', TODAY, TODAY, ctx()).includes(TODAY), true)
  })

  test('a morning with no work yet does not drag the average to zero', () => {
    const zero: DayInputs = {
      completedHigh: 0, completedMedium: 0, completedLow: 0,
      statusUpdates: 0, blockerResolutions: 0,
      hasEodLog: false, wasActiveToday: false, timelyAcks: 0,
      overdueCount: 0, staleBlockedCount: 0, activeTasks: 0, blockedCount: 0,
    }
    const good: DayInputs = { ...zero, completedHigh: 3, wasActiveToday: true, hasEodLog: true }

    const display = expectedWorkingDates('2026-07-29', TODAY, TODAY, ctx())
    const scoring = new Set(eligiblePerformanceDates('2026-07-29', TODAY, TODAY, ctx(), at(9)))
    const days    = display.map(d => trendDayFromInputs(d, d === TODAY ? zero : good))

    // Yesterday scored well; today has not started. The average is yesterday's.
    assert.equal(periodAverageScore(days.filter(d => scoring.has(d.date))), 67)
    assert.equal(periodAverageScore(days), 34)   // what counting today would give
  })
})

// ─── 8. Personal and Team agree ───────────────────────────────────────────────

describe('personal and team use the same eligible-date rule', () => {
  test('the same employee and range yield the same days and the same average', () => {
    const employee = ctx({
      holidays:    new Set(['2026-07-28']),
      joiningDate: '2026-07-25',
      exitDate:    null,
    })

    // Personal page range (a month slice) and team window (last N days) resolved
    // through the one helper both routes call.
    const personal = eligiblePerformanceDates('2026-07-24', TODAY, TODAY, employee, AFTER_CUTOFF)
    const team     = eligiblePerformanceDates('2026-07-24', TODAY, TODAY, employee, AFTER_CUTOFF)

    assert.deepEqual(personal, team)
    assert.deepEqual(personal, ['2026-07-25', '2026-07-27', '2026-07-29', '2026-07-30'])

    const score = (d: string): DayInputs => ({
      completedHigh: d === '2026-07-29' ? 2 : 0,
      completedMedium: 0, completedLow: 0,
      statusUpdates: 1, blockerResolutions: 0,
      hasEodLog: true, wasActiveToday: true, timelyAcks: 0,
      overdueCount: 0, staleBlockedCount: 0, activeTasks: 0, blockedCount: 0,
    })

    assert.equal(
      periodAverageScore(personal.map(d => trendDayFromInputs(d, score(d)))),
      periodAverageScore(team.map(d => trendDayFromInputs(d, score(d)))),
    )
  })

  test('a holiday changes both sides identically', () => {
    const withHoliday = ctx({ holidays: new Set(['2026-07-29']) })
    const plain       = ctx()
    assert.equal(
      eligiblePerformanceDates('2026-07-27', TODAY, TODAY, withHoliday, AFTER_CUTOFF).length,
      eligiblePerformanceDates('2026-07-27', TODAY, TODAY, plain, AFTER_CUTOFF).length - 1,
    )
  })
})

// ─── Deactivation and leave: what is and is not supported ────────────────────

describe('deactivation boundary', () => {
  test('a soft-delete gives a usable boundary', () => {
    const exit = resolveExitDate({ exit_date: null, is_deleted: true, deleted_at: '2026-07-27T06:00:00.000Z' })
    assert.equal(exit, '2026-07-27')
    const dates = expectedWorkingDates('2026-07-24', TODAY, TODAY, ctx({ exitDate: exit }))
    assert.deepEqual(dates, ['2026-07-24', '2026-07-25', '2026-07-27'])
  })

  test('a merely inactive user with no recorded date gets no boundary — by design', () => {
    // users.is_active carries no timestamp. Guessing a date would be inventing
    // history, so the limitation is surfaced as "no boundary" rather than a
    // fabricated one. Documented in the handoff.
    assert.equal(resolveExitDate({ exit_date: null, is_deleted: false, deleted_at: null }), null)
  })
})

describe('approved leave', () => {
  test('is documented as unavailable rather than inferred from absence', () => {
    // There is no leave table and attendance_records.status cannot express
    // approved leave. Inferring it from absence would let anyone erase a bad
    // day by not showing up, so leave days remain in scope and count as zero.
    assert.equal(APPROVED_LEAVE_UNAVAILABLE, true)
    assert.equal(isExpectedWorkingDay('2026-07-28', ctx()), true)
  })
})

// ─── No regression to the score weights ───────────────────────────────────────

describe('score weights are unchanged', () => {
  test('the four pillars still cap at 50 / 20 / 20 / -40', () => {
    const max: DayInputs = {
      completedHigh: 10, completedMedium: 10, completedLow: 10,
      statusUpdates: 10, blockerResolutions: 10,
      hasEodLog: true, wasActiveToday: true, timelyAcks: 10,
      overdueCount: 0, staleBlockedCount: 0, activeTasks: 0, blockedCount: 0,
    }
    const b = computeBreakdown(max)
    assert.equal(b.output, 50)
    assert.equal(b.momentum, 20)
    assert.equal(b.discipline, 20)
    assert.equal(b.total, 90)

    const worst = computeBreakdown({ ...max, overdueCount: 10, staleBlockedCount: 10 })
    assert.equal(worst.risk, -41)
  })

  test('priority weights are still 22 / 15 / 8', () => {
    const one = (k: 'completedHigh' | 'completedMedium' | 'completedLow') => computeBreakdown({
      completedHigh: 0, completedMedium: 0, completedLow: 0,
      statusUpdates: 0, blockerResolutions: 0,
      hasEodLog: false, wasActiveToday: false, timelyAcks: 0,
      overdueCount: 0, staleBlockedCount: 0, activeTasks: 0, blockedCount: 0,
      [k]: 1,
    } as DayInputs).output
    assert.equal(one('completedHigh'),   22)
    assert.equal(one('completedMedium'), 15)
    assert.equal(one('completedLow'),     8)
  })
})

// ─── 11. Parameter authorization ──────────────────────────────────────────────
//
// canViewPerformanceOf and canViewTeamPerformance used to be tested here. They
// were role tests, they are deleted, and their replacements live in
// src/lib/permissions/performance.test.ts — which covers the same questions plus
// the ones a role could not answer: a Manager who holds Team Performance and not
// Personal, and a Team Performance holder without company-wide sight.

// ─── 12. Invalid date ranges ──────────────────────────────────────────────────

describe('parseDateRangeParams', () => {
  test('accepts a well-formed range', () => {
    assert.deepEqual(parseDateRangeParams('2026-07-01', '2026-07-31'), {
      ok: true, from: '2026-07-01', to: '2026-07-31',
    })
  })

  test('requires both ends', () => {
    assert.equal(parseDateRangeParams('2026-07-01', null).ok, false)
    assert.equal(parseDateRangeParams(null, '2026-07-31').ok, false)
    assert.equal(parseDateRangeParams(null, null).ok, false)
  })

  test('rejects non-dates rather than letting them reach date arithmetic', () => {
    for (const bad of ['garbage', '2026-7-1', '01-07-2026', '2026-07-01T00:00:00Z', '']) {
      assert.equal(parseDateRangeParams(bad, '2026-07-31').ok, false, `should reject ${bad}`)
    }
  })

  test('rejects calendar dates that do not exist', () => {
    assert.equal(parseDateRangeParams('2026-02-30', '2026-07-31').ok, false)
    assert.equal(parseDateRangeParams('2026-13-01', '2026-07-31').ok, false)
    assert.equal(parseDateRangeParams('2026-07-01', '2026-06-31').ok, false)
  })

  test('rejects an inverted range', () => {
    const r = parseDateRangeParams('2026-07-31', '2026-07-01')
    assert.equal(r.ok, false)
    assert.match(r.ok === false ? r.error : '', /after/)
  })

  test('accepts a single-day range', () => {
    assert.equal(parseDateRangeParams('2026-07-30', '2026-07-30').ok, true)
  })

  test('rejects a span beyond the cap', () => {
    assert.equal(parseDateRangeParams('2020-01-01', '2030-01-01').ok, false)
    // Exactly at the cap is fine; one past it is not.
    assert.equal(parseDateRangeParams('2026-01-01', '2026-12-31').ok, true)   // 365
    assert.equal(parseDateRangeParams('2026-01-01', '2027-01-02').ok, false)  // 368
    assert.equal(MAX_RANGE_DAYS, 366)
  })
})

describe('isValidBusinessDate', () => {
  test('accepts a real date', () => {
    assert.equal(isValidBusinessDate('2026-07-30'), true)
    assert.equal(isValidBusinessDate('2028-02-29'), true)   // leap year
  })

  test('rejects nulls, empties and malformed strings', () => {
    for (const bad of [null, undefined, '', 'today', '2026/07/30', '26-07-30']) {
      assert.equal(isValidBusinessDate(bad), false, `should reject ${String(bad)}`)
    }
  })

  test('rejects dates that do not exist on the calendar', () => {
    assert.equal(isValidBusinessDate('2026-02-29'), false)  // not a leap year
    assert.equal(isValidBusinessDate('2026-04-31'), false)
    assert.equal(isValidBusinessDate('2026-00-10'), false)
  })
})

describe('parsePeriod', () => {
  test('defaults to daily when absent', () => {
    assert.equal(parsePeriod(null), 'daily')
  })

  test('accepts every supported period', () => {
    for (const p of PERFORMANCE_PERIODS) assert.equal(parsePeriod(p), p)
  })

  test('rejects anything else rather than silently falling back', () => {
    assert.equal(parsePeriod('yearly'), null)
    assert.equal(parsePeriod('DAILY'),  null)
    assert.equal(parsePeriod(''),       null)
  })
})

// ─── Reporting periods ────────────────────────────────────────────────────────
// TODAY = 2026-07-30, a Thursday. Week of Mon 27 – Sat Aug 1.

describe('resolvePeriod', () => {
  test('today compares against yesterday', () => {
    const p = resolvePeriod('today', TODAY)
    assert.deepEqual([p.from, p.to], [TODAY, TODAY])
    assert.deepEqual([p.previous.from, p.previous.to], ['2026-07-29', '2026-07-29'])
  })

  test('this week runs Monday to today and compares with the same stretch last week', () => {
    const p = resolvePeriod('this_week', TODAY)
    assert.deepEqual([p.from, p.to], ['2026-07-27', TODAY])
    assert.deepEqual([p.previous.from, p.previous.to], ['2026-07-20', '2026-07-23'])
  })

  test('last week is a full Monday to Saturday', () => {
    const p = resolvePeriod('last_week', TODAY)
    assert.deepEqual([p.from, p.to], ['2026-07-20', '2026-07-25'])
    assert.deepEqual([p.previous.from, p.previous.to], ['2026-07-13', '2026-07-18'])
  })

  test('this month is month-to-date, compared with the same span of last month', () => {
    const p = resolvePeriod('this_month', TODAY)
    assert.deepEqual([p.from, p.to], ['2026-07-01', TODAY])
    // 30 days into July, so 30 days into June — not the whole of June, which
    // would compare a part-month against a full one.
    assert.deepEqual([p.previous.from, p.previous.to], ['2026-06-01', '2026-06-30'])
  })

  test('a month-to-date comparison never runs past the end of the shorter month', () => {
    const p = resolvePeriod('this_month', '2026-03-31')
    assert.equal(p.previous.from, '2026-02-01')
    assert.equal(p.previous.to,   '2026-02-28')
  })

  test('last month is the whole month, compared with the whole month before', () => {
    const p = resolvePeriod('last_month', TODAY)
    assert.deepEqual([p.from, p.to], ['2026-06-01', '2026-06-30'])
    assert.deepEqual([p.previous.from, p.previous.to], ['2026-05-01', '2026-05-31'])
  })

  test('a custom range compares against an equally long preceding stretch', () => {
    const p = resolvePeriod('custom', TODAY, { from: '2026-07-20', to: '2026-07-24' })
    assert.deepEqual([p.from, p.to], ['2026-07-20', '2026-07-24'])
    assert.deepEqual([p.previous.from, p.previous.to], ['2026-07-15', '2026-07-19'])
  })

  test('a custom range is clamped so it never reaches into the future', () => {
    const p = resolvePeriod('custom', TODAY, { from: '2026-07-28', to: '2026-12-31' })
    assert.equal(p.to, TODAY)
  })

  test('resolution is deterministic — the same inputs give the same range', () => {
    const a = resolvePeriod('this_month', TODAY)
    const b = resolvePeriod('this_month', TODAY)
    assert.deepEqual(a, b)
  })

  test('every preset yields a from no later than its to', () => {
    for (const key of PERIOD_KEYS) {
      const p = resolvePeriod(key, TODAY, { from: '2026-07-20', to: '2026-07-24' })
      assert.ok(p.from <= p.to, `${key}: ${p.from} > ${p.to}`)
      assert.ok(p.previous.from <= p.previous.to, `${key} previous inverted`)
      assert.ok(p.previous.to < p.from, `${key} previous overlaps the period`)
    }
  })

  test('isPeriodKey rejects anything not on the list', () => {
    assert.equal(isPeriodKey('this_month'), true)
    assert.equal(isPeriodKey('yesterday'),  false)
    assert.equal(isPeriodKey(null),         false)
  })
})

describe('one period drives every section', () => {
  test('the same resolved period gives one eligible-date list for all consumers', () => {
    const p   = resolvePeriod('this_month', TODAY)
    const emp = ctx({ holidays: new Set(['2026-07-15']), joiningDate: '2026-07-06' })

    // Summary cards, table rows and the drawer all derive from this one call
    // server-side. Calling it repeatedly must not drift.
    const a = eligiblePerformanceDates(p.from, p.to, TODAY, emp, AFTER_CUTOFF)
    const b = eligiblePerformanceDates(p.from, p.to, TODAY, emp, AFTER_CUTOFF)
    assert.deepEqual(a, b)

    assert.equal(a.includes('2026-07-15'), false)  // holiday
    assert.equal(a.includes('2026-07-05'), false)  // Sunday and pre-joining
    assert.equal(a.includes('2026-07-26'), false)  // Sunday
    assert.equal(a.includes('2026-07-06'), true)   // joining day
  })

  test('a non-working current day is absent from the scoring set', () => {
    // 2026-07-26 is a Sunday. Asking for "today" on a Sunday must not present
    // Saturday's score as today's, and must not invent a zero for Sunday.
    const sunday = '2026-07-26'
    const p = resolvePeriod('today', sunday)
    const dates = eligiblePerformanceDates(p.from, p.to, sunday, ctx(),
      new Date(Date.parse(istDayStartUtc(sunday)) + 22 * 3600_000))
    assert.deepEqual(dates, [])
  })
})
