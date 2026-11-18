// Team Today's roster rules: never red before it is due; worst first. No morning plan and no strikes
// (owner, 2026-11-18): a person needs attention for no punch, a day not closed after 6:30 pm, or overdue work.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { dayProgress, rosterStatus, sortRoster, type RosterContext, type RosterInput, type RosterStatus } from './teamView'

const FRI = '2026-11-13'
const ist = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`).toISOString()
const at = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }

const ctx = (over: Partial<RosterContext> = {}): RosterContext => ({
  date: FRI, today: FRI, nowMinutes: at('11:40'), workingDay: true, planDue: at('10:30'), closeOpens: at('18:00'), ...over,
})
const person = (over: Partial<RosterInput> = {}): RosterInput => ({
  name: 'Dhruv', machineLinked: true, onLeave: false,
  punch: { checkInAt: ist(FRI, '10:02'), checkOutAt: null },
  plan: null, overdueTasks: 0, strikes: [], ...over,
})
const none = { checkInAt: null, checkOutAt: null }

describe('where they are today', () => {
  test('punched in: "In", on track, with no plan filed (there is no plan any more)', () => {
    const s = rosterStatus(person(), ctx())
    assert.deepEqual(s.day, { tone: 'green', text: 'In' })
    assert.equal(s.group, 'on_track')
  })
  test('before 10:30 no punch is grey "Not in yet", never red', () => {
    const s = rosterStatus(person({ punch: none }), ctx({ nowMinutes: at('09:55') }))
    assert.deepEqual(s.day, { tone: 'grey', text: 'Not in yet' })
    assert.equal(s.group, 'on_track')
  })
  test('after 10:30 no punch is red and needs attention; nobody is judged on a machine they are not linked to', () => {
    const s = rosterStatus(person({ punch: none }), ctx())
    assert.deepEqual(s.day, { tone: 'red', text: 'No punch' })
    assert.deepEqual(s.issues, ['No punch'])
    assert.equal(rosterStatus(person({ punch: none, machineLinked: false }), ctx()).group, 'on_track')
  })
  test('a day off is never red; leave is away', () => {
    assert.equal(rosterStatus(person({ punch: none }), ctx({ workingDay: false })).day.text, 'Day off')
    const away = rosterStatus(person({ onLeave: true, overdueTasks: 4 }), ctx())
    assert.equal(away.group, 'away')
    assert.deepEqual(away.issues, [])
  })
  test('old strikes no longer count', () => {
    const s = rosterStatus(person({ strikes: [{ kind: 'no_plan', status: 'open' }] }), ctx())
    assert.equal(s.group, 'on_track')
  })
})

describe('closing and overdue work', () => {
  test('closing opens at 6 pm (grey); not closed after 6:30 pm needs attention', () => {
    assert.deepEqual(rosterStatus(person(), ctx({ nowMinutes: at('18:10') })).close, { tone: 'grey', text: 'Closing open' })
    const late = rosterStatus(person(), ctx({ nowMinutes: at('18:31') }))
    assert.deepEqual(late.close, { tone: 'red', text: 'Not closed' })
    assert.ok(late.issues.includes('Day not closed'))
  })
  test('a past day is judged as over', () => {
    const p = person({ punch: { checkInAt: ist('2026-11-12', '10:00'), checkOutAt: null } })
    assert.ok(rosterStatus(p, ctx({ date: '2026-11-12', today: FRI, nowMinutes: at('09:00') })).issues.includes('Day not closed'))
  })
  test('closed: green with the time', () => {
    const s = rosterStatus(person({ plan: { submitted_at: null, closed_at: ist(FRI, '18:12') } }), ctx({ nowMinutes: at('19:00') }))
    assert.deepEqual(s.close, { tone: 'green', text: 'Closed 6:12 pm' })
    assert.equal(s.group, 'on_track')
  })
  test('overdue tasks need attention', () => {
    assert.deepEqual(rosterStatus(person({ overdueTasks: 3 }), ctx()).issues, ['3 overdue'])
  })
})

describe('the order', () => {
  const st = (group: RosterStatus['group'], issues: string[] = []): RosterStatus => ({ group, day: { tone: 'grey', text: '' }, close: null, issues })
  test('attention first, most issues first, then on track, then away, by name', () => {
    const rows = [
      { name: 'Zed', status: st('on_track') }, { name: 'Amy', status: st('away') },
      { name: 'Bob', status: st('attention', ['a']) }, { name: 'Cat', status: st('attention', ['a', 'b']) },
      { name: 'Abe', status: st('on_track') },
    ]
    assert.deepEqual(sortRoster(rows).map(r => r.name), ['Cat', 'Bob', 'Abe', 'Zed', 'Amy'])
  })
  test('day progress runs 10:00 to 6:30', () => {
    assert.equal(dayProgress(at('09:00')), 0)
    assert.equal(dayProgress(at('14:15')), 0.5)
    assert.equal(dayProgress(at('20:00')), 1)
  })
})
