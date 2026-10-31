/**
 * Team response: every label has to be defensible to the person it describes.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/teamResponse.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTeamResponse, formatReplyTime, personSummary, recentWorkingDays, responseLabel, talkingPoints, teamSummaryLine,
  type ResponseEvent, type ResponseTask,
} from './teamResponse'

const ME = 'viewer'
const ASHA = 'asha'
// Saturday 31 Oct 2026, 18:00 IST.
const NOW = new Date('2026-10-31T12:30:00Z')

const ist = (date: string, time = '12:00') => `${date}T${time}:00+05:30`

function task(id: string, over: Partial<ResponseTask> = {}): ResponseTask {
  return {
    id, title: `Task ${id}`, status: 'working', assigned_to: ASHA,
    created_at: ist('2026-10-01'), due_date: null, last_update_at: null,
    completed_at: null, cancelled_at: null,
    ...over,
  }
}

function event(taskId: string, actor: string, at: string, action = 'note_added', over: Partial<ResponseEvent> = {}): ResponseEvent {
  return { task_id: taskId, actor_id: actor, action, from_status: null, to_status: null, created_at: at, ...over }
}

const build = (tasks: ResponseTask[], events: ResponseEvent[], people: { id: string; full_name: string; is_active: boolean }[] | null = [
  { id: ASHA, full_name: 'Asha', is_active: true },
]) => buildTeamResponse({ tasks, events, people, viewerId: ME, now: NOW })

const stripDays = recentWorkingDays('2026-10-31', 12)

describe('the working days in the strip', () => {
  test('twelve days ending today, Sundays left out', () => {
    assert.equal(stripDays.length, 12)
    assert.equal(stripDays[11], '2026-10-31')
    assert.equal(stripDays[0], '2026-10-19')
    assert.equal(stripDays.includes('2026-10-25'), false, '25 Oct 2026 is a Sunday')
  })
})

describe('the label', () => {
  const judged = { updatedDays: 8, countedDays: 10, replyHours: 10, messages: 5 }

  test('Active needs both the days and the reply time', () => {
    assert.equal(responseLabel(judged), 'active')
    assert.equal(responseLabel({ ...judged, replyHours: 30 }), 'inconsistent')
    assert.equal(responseLabel({ ...judged, updatedDays: 6 }), 'inconsistent')
  })

  test('Least active needs only one of the two', () => {
    assert.equal(responseLabel({ ...judged, updatedDays: 3 }), 'least_active')
    assert.equal(responseLabel({ ...judged, replyHours: 73 }), 'least_active')
  })

  test('the boundaries belong where the mockup said', () => {
    assert.equal(responseLabel({ ...judged, updatedDays: 7, replyHours: 24 }), 'active')
    assert.equal(responseLabel({ ...judged, updatedDays: 4, replyHours: 72 }), 'inconsistent')
  })

  test('too little to go on is never a judgement', () => {
    assert.equal(responseLabel({ ...judged, updatedDays: 0, countedDays: 4 }), 'too_early')
    assert.equal(responseLabel({ ...judged, updatedDays: 0, messages: 2 }), 'too_early')
  })
})

describe('the strip', () => {
  test('a day with an update counts, whatever else is true of it', () => {
    const { people } = build([task('a')], [event('a', ASHA, ist('2026-10-26'))])
    assert.equal(people[0].days.find(d => d.date === '2026-10-26')?.state, 'updated')
  })

  test('the update falls on the IST day, not the UTC one', () => {
    const { people } = build([task('a')], [event('a', ASHA, '2026-10-26T19:00:00Z')]) // 00:30 on the 27th in IST
    assert.equal(people[0].days.find(d => d.date === '2026-10-27')?.state, 'updated')
    assert.equal(people[0].days.find(d => d.date === '2026-10-26')?.state, 'silent')
  })

  test('a day holding a task with no update is silent', () => {
    const { people } = build([task('a')], [])
    assert.equal(people[0].days.find(d => d.date === '2026-10-26')?.state, 'silent')
  })

  test('days before the task existed are not held against the person', () => {
    const { people } = build([task('a', { created_at: ist('2026-10-28') })], [])
    const before = people[0].days.find(d => d.date === '2026-10-26')
    assert.equal(before?.state, 'not_counted')
    assert.equal(before?.why, 'No open task from you')
  })

  test('days after the task closed are not held against the person', () => {
    const { people } = build([task('a', { status: 'completed', completed_at: ist('2026-10-22') })], [])
    assert.equal(people[0].days.find(d => d.date === '2026-10-28')?.state, 'not_counted')
  })

  test('days a task sat with the creator for approval are not held against the person', () => {
    const { people } = build([task('a', { status: 'pending_approval' })], [
      event('a', ASHA, ist('2026-10-22'), 'status_changed', { from_status: 'working', to_status: 'pending_approval' }),
    ])
    const waiting = people[0].days.find(d => d.date === '2026-10-28')
    assert.equal(waiting?.state, 'not_counted')
    assert.equal(waiting?.why, 'Waiting for your approval')
    assert.equal(people[0].days.find(d => d.date === '2026-10-21')?.state, 'silent')
  })

  test('once returned, the days count again', () => {
    const { people } = build([task('a')], [
      event('a', ASHA, ist('2026-10-22'), 'status_changed', { from_status: 'working', to_status: 'pending_approval' }),
      event('a', ME, ist('2026-10-24'), 'status_changed', { from_status: 'pending_approval', to_status: 'working' }),
    ])
    assert.equal(people[0].days.find(d => d.date === '2026-10-23')?.state, 'not_counted')
    assert.equal(people[0].days.find(d => d.date === '2026-10-27')?.state, 'silent')
  })

  test('today is not silent until it is over', () => {
    const { people } = build([task('a')], [])
    const today = people[0].days.find(d => d.date === '2026-10-31')
    assert.equal(today?.state, 'not_counted')
    assert.equal(today?.why, 'Today, nothing yet')
  })

  test('an update today counts', () => {
    const { people } = build([task('a')], [event('a', ASHA, ist('2026-10-31'))])
    assert.equal(people[0].days.find(d => d.date === '2026-10-31')?.state, 'updated')
  })

  test('the viewer\'s own activity never counts for the assignee', () => {
    const { people } = build([task('a')], [event('a', ME, ist('2026-10-26'))])
    assert.equal(people[0].updatedDays, 0)
  })
})

describe('reply time', () => {
  test('the wait runs from the message to the next word from the assignee', () => {
    const { people } = build([task('a')], [
      event('a', ME, ist('2026-10-26', '10:00')),
      event('a', ASHA, ist('2026-10-26', '14:00')),
    ])
    assert.equal(people[0].replyHours, 4)
    assert.equal(people[0].messages, 1)
  })

  test('several messages before a reply are one wait', () => {
    const { people } = build([task('a')], [
      event('a', ME, ist('2026-10-26', '10:00')),
      event('a', ME, ist('2026-10-26', '12:00')),
      event('a', ASHA, ist('2026-10-26', '14:00')),
    ])
    assert.equal(people[0].messages, 1)
    assert.equal(people[0].replyHours, 4)
  })

  test('a new task and a returned task are messages too', () => {
    const { people } = build([task('a')], [
      event('a', ME, ist('2026-10-20', '10:00'), 'created'),
      event('a', ASHA, ist('2026-10-20', '11:00'), 'acknowledged'),
      event('a', ME, ist('2026-10-21', '10:00'), 'status_changed', { from_status: 'pending_approval', to_status: 'working' }),
      event('a', ASHA, ist('2026-10-21', '11:00')),
    ])
    assert.equal(people[0].messages, 2)
  })

  test('an unanswered message counts at its age, so ignoring it cannot flatter anyone', () => {
    const { people } = build([task('a')], [event('a', ME, ist('2026-10-29', '18:00'))])
    assert.equal(people[0].messages, 1)
    assert.equal(people[0].replyHours, 48)
  })

  test('a message from the last few hours is not yet a delay', () => {
    const { people } = build([task('a')], [event('a', ME, ist('2026-10-31', '12:00'))])
    assert.equal(people[0].messages, 0)
  })

  test('a task that closed unanswered is dropped', () => {
    const { people } = build([task('a', { status: 'cancelled', cancelled_at: ist('2026-10-30') })], [event('a', ME, ist('2026-10-26'))])
    assert.equal(people[0].messages, 0)
  })

  test('a message older than the window does not count', () => {
    const { people } = build([task('a')], [
      event('a', ME, ist('2026-09-01', '10:00')),
      event('a', ASHA, ist('2026-09-05', '10:00')),
    ])
    assert.equal(people[0].messages, 0)
  })

  test('slow means over two days', () => {
    const { people } = build([task('a'), task('b')], [
      event('a', ME, ist('2026-10-20')), event('a', ASHA, ist('2026-10-23')),
      event('b', ME, ist('2026-10-20')), event('b', ASHA, ist('2026-10-21')),
    ])
    assert.equal(people[0].slowMessages, 1)
    assert.equal(people[0].messages, 2)
  })
})

describe('open work', () => {
  test('overdue uses the shared rule: a task with the creator is not late against the assignee', () => {
    const { people } = build([
      task('a', { due_date: '2026-10-26' }),
      task('b', { due_date: '2026-10-20', status: 'pending_approval' }),
    ], [])
    assert.equal(people[0].overdueTasks, 1)
    assert.deepEqual(people[0].mostLate, { title: 'Task a', days: 5 })
  })

  test('quiet is measured from the assignee\'s own last word, not the creator\'s', () => {
    const { people } = build([task('a')], [
      event('a', ASHA, ist('2026-10-25')),
      event('a', ME, ist('2026-10-31')),
    ])
    assert.equal(people[0].quietTasks, 1)
    assert.equal(people[0].longestQuiet?.days, 6)
  })

  test('a task with the creator is not quiet', () => {
    const { people } = build([task('a', { status: 'pending_approval' })], [])
    assert.equal(people[0].quietTasks, 0)
  })
})

describe('the whole bar', () => {
  const twelveDays = (id: string, who: string, count: number) =>
    stripDays.slice(0, count).map(d => event(id, who, ist(d)))
  const messages = (id: string, who: string) => [2, 3, 5].flatMap(n => [
    event(id, ME, ist(`2026-10-0${n}`, '10:00')),
    event(id, who, ist(`2026-10-0${n}`, '12:00')),
  ])

  test('least active first, so the people worth talking to stay in view', () => {
    const team = build(
      [task('a'), task('b', { assigned_to: 'rohan' })],
      [...twelveDays('a', ASHA, 11), ...messages('a', ASHA), ...twelveDays('b', 'rohan', 2), ...messages('b', 'rohan')],
      [{ id: ASHA, full_name: 'Asha', is_active: true }, { id: 'rohan', full_name: 'Rohan', is_active: true }],
    )
    assert.deepEqual(team.people.map(p => p.name), ['Rohan', 'Asha'])
    assert.equal(team.people[0].label, 'least_active')
    assert.equal(team.people[1].label, 'active')
    assert.equal(teamSummaryLine(team), '1 least active')
  })

  test('an inactive account is listed apart and never judged', () => {
    const team = build([task('a')], [], [{ id: ASHA, full_name: 'Asha', is_active: false }])
    assert.equal(team.people.length, 0)
    assert.deepEqual(team.inactive, [{ userId: ASHA, name: 'Asha', openTasks: 1 }])
  })

  test('an inactive account with nothing open is not mentioned', () => {
    const team = build([task('a', { status: 'completed', completed_at: ist('2026-10-20') })], [], [{ id: ASHA, full_name: 'Asha', is_active: false }])
    assert.deepEqual(team, { people: [], inactive: [] })
  })

  test('the viewer never appears as their own assignee', () => {
    assert.equal(build([task('a', { assigned_to: ME })], []).people.length, 0)
  })

  test('with no name list it still works, and says Unknown rather than guessing', () => {
    assert.equal(build([task('a')], [], null).people[0].name, 'Unknown')
  })

  test('nobody to show has its own line', () => {
    assert.equal(teamSummaryLine({ people: [], inactive: [] }), 'Nobody to show yet')
  })
})

describe('the words', () => {
  test('reply times read naturally', () => {
    assert.equal(formatReplyTime(0.5), 'under 1 hr')
    assert.equal(formatReplyTime(1), '1 hr')
    assert.equal(formatReplyTime(4), '4 hrs')
    assert.equal(formatReplyTime(24), '1 day')
    assert.equal(formatReplyTime(72), '3 days')
  })

  test('someone too new shows why, not a count', () => {
    const { people } = build([task('a')], [])
    assert.equal(personSummary({ ...people[0], label: 'too_early', taskCount: 1 }).reply, 'Only 1 task so far.')
    assert.equal(personSummary({ ...people[0], label: 'too_early', taskCount: 5 }).reply, 'Not enough to judge yet.')
    assert.equal(personSummary({ ...people[0], label: 'too_early' }).days, '')
  })

  test('the facts to raise name real tasks', () => {
    const { people } = build([task('a', { due_date: '2026-10-26' })], [
      event('a', ME, ist('2026-10-20')),
      event('a', ASHA, ist('2026-10-25')),
    ])
    assert.deepEqual(talkingPoints(people[0]), [
      '1 of your 1 message waited over 2 days',
      'Quiet for 6 days on "Task a"',
      '"Task a" is 5 days late',
      'Last update: 25 Oct',
    ])
  })
})
