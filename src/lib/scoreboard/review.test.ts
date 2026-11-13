// The monthly review: award picks, private-review steps, goals and the announcement (owner, 2026-11-12).

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { announcement, countedDays, reviewFlags, suggestAwards, validateGoals, type FinalRow } from './review'

const parts = (days: number, present: number, punctualFull = true) => [
  { key: 'present', max: 10, earned: (10 * present) / days, note: `${present} of ${days} working days` },
  { key: 'punctual', max: 10, earned: punctualFull ? 10 : 6, note: '' },
]
const row = (id: string, name: string, score: number | null, over: Partial<FinalRow> = {}): FinalRow =>
  ({ id, name, track: 'general', score, parts: parts(24, 24), ...over })

describe('awards', () => {
  const rows = [
    row('p', 'Priya', 88), row('m', 'Mohit', 79, { track: 'sales', parts: parts(24, 23) }), row('r', 'Rakesh', 74, { parts: parts(24, 24, false) }),
    row('d', 'Dhruv', 68), row('n', 'New Joiner', 95, { parts: parts(6, 6) }), row('x', 'No Score', null),
  ]
  const s = suggestAwards({
    rows,
    previous: new Map([['p', 85], ['d', 54], ['r', 70]]),
    sales: new Map([['m', 1_840_000], ['p', 0]]),
    votes: new Map([['r', 5], ['d', 5], ['p', 2]]),
  })

  test('a new joiner with under 10 working days cannot win, whatever the score', () => {
    assert.equal(countedDays(parts(6, 6)), 6)
    assert.deepEqual(s.star_performer, ['p'])
  })

  test('Star Seller is the highest confirmed sales', () => assert.deepEqual(s.star_seller, ['m']))
  test('Most Improved is the biggest rise ending 55 or more', () => assert.deepEqual(s.most_improved, ['d']))
  test('Team Player: most votes, ties alphabetical', () => assert.deepEqual(s.team_player, ['d']))
  test('Never Late: every day present and on time', () => assert.deepEqual(s.never_late, ['d', 'p']))

  test('nobody is suggested when nobody qualifies', () => {
    const e = suggestAwards({ rows: [row('a', 'A', 50)], previous: new Map(), sales: new Map(), votes: new Map() })
    assert.deepEqual([e.star_seller, e.most_improved, e.team_player], [[], [], []])
  })
})

describe('private reviews', () => {
  test('the lowest and anybody in the Red zone; steps follow the Red streak', () => {
    const rows = [row('a', 'A', 72), row('b', 'B', 45), row('c', 'C', 35), row('d', 'D', 30)]
    const f = reviewFlags(rows, new Map([['c', [80, 38]], ['d', [39, 20]]]))
    assert.deepEqual([...f.keys()].sort(), ['c', 'd'])
    assert.equal(f.get('c')!.step, 'written_warning')
    assert.equal(f.get('d')!.step, 'role_salary_review')
    const calm = reviewFlags([row('a', 'A', 72), row('b', 'B', 61)], new Map())
    assert.deepEqual([...calm.entries()], [['b', { reason: 'lowest', redStreak: 0, step: 'one_to_one' }]])
  })

  test('goals: one to three, and a check-in after the month', () => {
    assert.equal(validateGoals({ goals: [], checkin_on: '2026-12-15' }, '2026-11-01').ok, false)
    assert.equal(validateGoals({ goals: ['a', 'b', 'c', 'd'], checkin_on: '2026-12-15' }, '2026-11-01').ok, false)
    assert.equal(validateGoals({ goals: ['Plan by 10:30 every day'], checkin_on: '2026-10-30' }, '2026-11-01').ok, false)
    assert.deepEqual(validateGoals({ goals: [' Plan by 10:30 every day ', ''], checkin_on: '2026-12-15', warning: true }, '2026-11-01'),
      { ok: true, value: { goals: ['Plan by 10:30 every day'], checkin_on: '2026-12-15', warning: true, note: null } })
  })
})

describe('the announcement', () => {
  test('winners only, in award order, with their lines', () => {
    const text = announcement('November 2026', [
      { award: 'never_late', names: ['Dhruv', 'Priya'] },
      { award: 'star_performer', names: ['Priya'], note: 'Every task on time' },
      { award: 'team_player', names: [] },
    ])
    assert.equal(text.split('\n')[0], '🏆 BOE Champions of November 2026 🏆')
    assert.ok(text.indexOf('Star Performer: Priya – Every task on time') < text.indexOf('Never Late: Dhruv, Priya'))
    assert.equal(text.includes('Team Player'), false)
  })
})
