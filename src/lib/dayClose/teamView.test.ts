// Team Today's roster rules (owner, 2026-11-13): never red before the plan is due; worst first.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { dayProgress, rosterStatus, sortRoster, type RosterContext, type RosterInput } from './teamView'

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

describe('the plan chip', () => {
  test('before the plan is due: grey "Plan due", not an issue', () => {
    const s = rosterStatus(person({ punch: { checkInAt: null, checkOutAt: null } }), ctx({ nowMinutes: at('08:55') }))
    assert.deepEqual(s.plan, { tone: 'grey', text: 'Plan due 10:30 am' })
    assert.equal(s.group, 'on_track')
  })
  test('a late arrival gets 30 minutes: due 11:10 for an 10:40 punch', () => {
    const s = rosterStatus(person({ punch: { checkInAt: ist(FRI, '10:40'), checkOutAt: null } }), ctx({ nowMinutes: at('11:00') }))
    assert.equal(s.plan.text, 'Plan due 11:10 am')
  })
  test('past the due time with no plan: red, and needs attention', () => {
    const s = rosterStatus(person(), ctx())
    assert.deepEqual(s.plan, { tone: 'red', text: 'No plan' })
    assert.deepEqual(s.issues, ['No plan'])
    assert.equal(s.group, 'attention')
  })
  test('filed on time: green; filed late: amber and an issue', () => {
    assert.deepEqual(rosterStatus(person({ plan: { submitted_at: ist(FRI, '10:12'), closed_at: null } }), ctx()).plan, { tone: 'green', text: 'Plan 10:12 am' })
    const late = rosterStatus(person({ plan: { submitted_at: ist(FRI, '10:52'), closed_at: null } }), ctx())
    assert.deepEqual(late.plan, { tone: 'amber', text: 'Plan 10:52 am · late' })
    assert.deepEqual(late.issues, ['Plan late'])
  })
  test('a day off is never red', () => {
    const s = rosterStatus(person(), ctx({ workingDay: false }))
    assert.equal(s.plan.text, 'Day off')
    assert.equal(s.group, 'on_track')
  })
  test('on leave: away, nothing else judged', () => {
    const s = rosterStatus(person({ onLeave: true, overdueTasks: 4 }), ctx())
    assert.equal(s.group, 'away')
    assert.deepEqual(s.issues, [])
  })
})

describe('closing, punches and overdue work', () => {
  const filed = { submitted_at: ist(FRI, '10:10'), closed_at: null }
  test('closing opens at 6 pm (grey), not closed after 6:30 is an issue', () => {
    assert.deepEqual(rosterStatus(person({ plan: filed }), ctx({ nowMinutes: at('18:10') })).close, { tone: 'grey', text: 'Closing open' })
    const late = rosterStatus(person({ plan: filed }), ctx({ nowMinutes: at('18:31') }))
    assert.deepEqual(late.close, { tone: 'red', text: 'Not closed' })
    assert.ok(late.issues.includes('Day not closed'))
  })
  test('a past day is judged as over', () => {
    const s = rosterStatus(person({ plan: filed }), ctx({ date: '2026-11-12', today: FRI, nowMinutes: at('09:00') }))
    assert.ok(s.issues.includes('Day not closed'))
  })
  test('closed: green with the time', () => {
    const s = rosterStatus(person({ plan: { submitted_at: ist(FRI, '10:10'), closed_at: ist(FRI, '18:12') } }), ctx({ nowMinutes: at('19:00') }))
    assert.deepEqual(s.close, { tone: 'green', text: 'Closed 6:12 pm' })
    assert.equal(s.group, 'on_track')
  })
  test('no punch once the plan is due; nobody judged on a machine they are not linked to', () => {
    const none = { checkInAt: null, checkOutAt: null }
    assert.ok(rosterStatus(person({ punch: none, plan: filed }), ctx()).issues.includes('No punch'))
    assert.ok(!rosterStatus(person({ punch: none, plan: filed, machineLinked: false }), ctx()).issues.includes('No punch'))
    assert.ok(!rosterStatus(person({ punch: none }), ctx({ nowMinutes: at('09:30') })).issues.includes('No punch'))
  })
  test('overdue tasks and the day\'s strikes are issues; a waived strike is not; no duplicates', () => {
    const s = rosterStatus(person({
      overdueTasks: 3,
      strikes: [{ kind: 'no_plan', status: 'open' }, { kind: 'plan_late', status: 'waived' }],
    }), ctx())
    assert.deepEqual(s.issues, ['No plan', '3 overdue'])
  })
})

describe('the order', () => {
  test('attention first, most issues first, then on track, then away, by name', () => {
    const rows = [
      { name: 'Zed', status: { group: 'on_track' as const, plan: { tone: 'green' as const, text: '' }, close: null, issues: [] } },
      { name: 'Amy', status: { group: 'away' as const, plan: { tone: 'blue' as const, text: '' }, close: null, issues: [] } },
      { name: 'Bob', status: { group: 'attention' as const, plan: { tone: 'red' as const, text: '' }, close: null, issues: ['a'] } },
      { name: 'Cat', status: { group: 'attention' as const, plan: { tone: 'red' as const, text: '' }, close: null, issues: ['a', 'b'] } },
      { name: 'Abe', status: { group: 'on_track' as const, plan: { tone: 'green' as const, text: '' }, close: null, issues: [] } },
    ]
    assert.deepEqual(sortRoster(rows).map(r => r.name), ['Cat', 'Bob', 'Abe', 'Zed', 'Amy'])
  })
  test('day progress runs 10:00 to 6:30', () => {
    assert.equal(dayProgress(at('09:00')), 0)
    assert.equal(dayProgress(at('14:15')), 0.5)
    assert.equal(dayProgress(at('20:00')), 1)
  })
})
