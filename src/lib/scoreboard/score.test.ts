// The Scoreboard's rules (owner, 2026-11-12), pinned on small, real-looking months.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { bandOf, computeScore, fastestTip, pillarTotals, type ScoreFacts } from './score'

const ist = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`).toISOString()
// November 2026: 1st is a Sunday. Working days Mon-Sat.
const NOV = Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`)
  .filter(d => new Date(`${d}T00:00:00Z`).getUTCDay() !== 0)

function facts(over: Partial<ScoreFacts> = {}): ScoreFacts {
  const date = over.date ?? '2026-11-07'
  const workingDates = NOV.filter(d => d <= date)
  return {
    track: 'general', date, dayComplete: true, workingDates, monthWorkingDates: NOV,
    leaveDates: new Set(), arrivals: new Map(workingDates.map(d => [d, 600])), graceEndMinutes: 615,
    tasks: [], role: null, sales: null, leads: [],
    dayClose: { since: null, planStrikeDates: new Set(), closeStrikeDates: new Set() },
    requestsInformed: [], years: 2,
    ...over,
  }
}
const part = (f: ScoreFacts, key: string) => computeScore(f).parts.find(p => p.key === key)!

describe('the score', () => {
  test('a perfect first week is 100, and parts with nothing to judge are left out of both sides', () => {
    const r = computeScore(facts({
      tasks: [{ priority: 'high', due_date: '2026-11-03', handed_in_at: ist('2026-11-03', '17:00') }],
      years: 6,
    }))
    assert.equal(r.score, 100)
    assert.equal(r.band, 'star')
    // Counted: tasks 30, present 10, punctual 10, informed 5, loyalty 5. Not counted: role target, Day Close, vote, rating.
    assert.equal(r.possible, 60)
  })

  test('bands', () => {
    assert.deepEqual([85, 84, 70, 55, 54, 40, 39].map(bandOf), ['star', 'strong', 'strong', 'steady', 'watch', 'watch', 'red'])
  })

  test('too little to judge gives no score', () => {
    const r = computeScore(facts({ date: '2026-11-02', workingDates: [], arrivals: new Map(), years: null }))
    assert.equal(r.score, null)
  })
})

describe('results', () => {
  test('tasks on time are weighted by priority; late or not handed in count as missed', () => {
    const f = facts({ tasks: [
      { priority: 'high', due_date: '2026-11-03', handed_in_at: ist('2026-11-03', '18:00') },   // 3 on time
      { priority: 'low', due_date: '2026-11-04', handed_in_at: ist('2026-11-05', '10:00') },    // 1 late
      { priority: 'medium', due_date: '2026-11-05', handed_in_at: null },                        // 2 missed
    ] })
    assert.equal(part(f, 'tasks_on_time').earned, 15) // 30 × 3/6
  })

  test('a task due today counts only once handed in, while the day is in progress', () => {
    const due = [{ priority: 'medium', due_date: '2026-11-07', handed_in_at: null }]
    assert.equal(part(facts({ dayComplete: false, tasks: due }), 'tasks_on_time').earned, null)
    assert.equal(part(facts({ dayComplete: true, tasks: due }), 'tasks_on_time').earned, 0)
  })

  test('a role target is paced by the working days gone', () => {
    // 6 of 25 working days gone: 20 × 6/25 = 4.8 expected; 4 done → 10 × 4/4.8.
    const r = part(facts({ role: { target: 20, actual: 4, label: 'reels posted' } }), 'role_target')
    assert.equal(r.earned, 8.33)
    assert.match(r.note, /4 of 20 reels posted/)
  })

  test('sales: value against the paced target, and new leads called in time (after 17:30 the next working day)', () => {
    const f = facts({
      track: 'sales',
      sales: { target: 2_500_000, value: 300_000 }, // paced 600,000 → half marks
      leads: [
        { assigned_at: ist('2026-11-03', '11:00'), first_attempt_at: ist('2026-11-03', '15:00') },
        { assigned_at: ist('2026-11-03', '11:00'), first_attempt_at: ist('2026-11-04', '10:00') },
        { assigned_at: ist('2026-11-03', '18:10'), first_attempt_at: ist('2026-11-04', '10:30') },
      ],
    })
    assert.equal(part(f, 'sales_value').earned, 12.5)
    assert.equal(part(f, 'lead_work').earned, 10) // 2 of 3
    assert.equal(computeScore(f).parts.some(p => p.key === 'tasks_on_time'), false, 'sales is judged on sales, not tasks')
  })

  test('no target set: not counted, never a zero', () => {
    assert.equal(part(facts({ track: 'sales' }), 'sales_value').earned, null)
    assert.equal(part(facts(), 'role_target').earned, null)
  })
})

describe('attendance and discipline', () => {
  test('approved leave is neither present nor absent; a missing day costs; late arrivals cost punctuality', () => {
    const arrivals = new Map<string, number | null>([
      ['2026-11-02', 600], ['2026-11-03', 640], ['2026-11-05', 600], ['2026-11-06', 600], ['2026-11-07', 600],
    ])
    const f = facts({ arrivals, leaveDates: new Set(['2026-11-04']) })
    assert.equal(part(f, 'present').note, '5 of 5 working days')
    assert.equal(part(f, 'punctual').earned, 8) // 4 of 5
    const absent = facts({ arrivals })
    assert.equal(part(absent, 'present').note, '5 of 6 working days')
  })

  test('today counts for attendance only once punched in', () => {
    const arrivals = new Map(NOV.filter(d => d < '2026-11-07').map(d => [d, 600] as [string, number]))
    assert.equal(part(facts({ dayComplete: false, arrivals }), 'present').note, '5 of 5 working days')
  })

  test('Day Close: strikes cost their half; only from the day switched on; waived ones are not passed in', () => {
    const f = facts({ dayClose: {
      since: '2026-11-04',
      planStrikeDates: new Set(['2026-11-05']),
      closeStrikeDates: new Set(['2026-11-05', '2026-11-06']),
    } })
    assert.equal(part(f, 'plan_on_time').earned, 5.63)          // 3 of 4 days
    assert.equal(part(f, 'closed_before_leaving').earned, 3.75) // 2 of 4 days
    assert.equal(part(facts(), 'plan_on_time').earned, null)
  })

  test('leave asked in advance', () => {
    assert.equal(part(facts({ requestsInformed: [true, false] }), 'informed_leave').earned, 2.5)
    assert.equal(part(facts(), 'informed_leave').earned, 5)
  })
})

describe('telling the person', () => {
  test('pillars add up the parts that count', () => {
    const r = computeScore(facts({ tasks: [{ priority: 'medium', due_date: '2026-11-03', handed_in_at: null }] }))
    const results = pillarTotals(r.parts).find(p => p.pillar === 'results')!
    assert.deepEqual([results.earned, results.possible], [0, 30])
  })

  test('the fastest way up is where the most points are lost', () => {
    const r = computeScore(facts({ tasks: [{ priority: 'medium', due_date: '2026-11-03', handed_in_at: null }] }))
    assert.match(fastestTip(r.parts) ?? '', /Hand in your tasks/)
  })
})
