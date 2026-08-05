/**
 * Meeting lifecycle trail — presentation and, above all, PRESERVATION.
 *
 * The defect this whole feature exists to fix: reopening a meeting clears
 * `meetings.completed_at` / `completed_by`, because the table's CHECK
 * constraint requires a non-completed meeting to claim neither. Before the
 * activity log, that silently destroyed the record of the first completion —
 * who closed the meeting, and when — and nothing anywhere held it.
 *
 * So the assertion that matters most here is not a label or a sort order: it is
 * that a meeting completed, reopened and completed again reports BOTH
 * completions, each with its own actor and timestamp.
 *
 * Run:
 *   npx tsx --test src/lib/meetings/activity.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVITY_EVENT_LABEL, ACTIVITY_EVENT_TONE,
  activitySentence, sortActivity, completionEvents, wasReopened,
} from './activity'
import type { MeetingActivityEntry, MeetingActivityEventType } from './types'

const ALL_EVENTS: MeetingActivityEventType[] =
  ['created', 'started', 'completed', 'reopened', 'returned_to_draft']

const entry = (over: Partial<MeetingActivityEntry> = {}): MeetingActivityEntry => ({
  id: 'a1', meeting_id: 'm1',
  event_type: 'started', previous_status: 'draft', new_status: 'in_progress',
  detail: null, actor_id: 'u1', created_at: '2026-08-05T04:45:00Z',
  actor_name: 'Nishant Soni',
  ...over,
})

/** The full narrative of a meeting that was completed, reopened, completed again. */
const REOPENED_MEETING: MeetingActivityEntry[] = [
  entry({ id: 'e1', event_type: 'created',   previous_status: null,          new_status: 'draft',       created_at: '2026-08-05T04:00:00Z', actor_name: 'Nishant Soni' }),
  entry({ id: 'e2', event_type: 'started',   previous_status: 'draft',       new_status: 'in_progress', created_at: '2026-08-05T04:45:00Z', actor_name: 'Nishant Soni' }),
  entry({ id: 'e3', event_type: 'completed', previous_status: 'in_progress', new_status: 'completed',   created_at: '2026-08-05T06:35:00Z', actor_name: 'Priya Nair' }),
  entry({ id: 'e4', event_type: 'reopened',  previous_status: 'completed',   new_status: 'in_progress', created_at: '2026-08-06T04:10:00Z', actor_name: 'Nishant Soni' }),
  entry({ id: 'e5', event_type: 'completed', previous_status: 'in_progress', new_status: 'completed',   created_at: '2026-08-06T05:20:00Z', actor_name: 'Nishant Soni' }),
]

describe('labels and tones', () => {
  test('every event type has a label and a tone', () => {
    for (const type of ALL_EVENTS) {
      assert.ok(ACTIVITY_EVENT_LABEL[type], `label missing for ${type}`)
      assert.ok(ACTIVITY_EVENT_TONE[type], `tone missing for ${type}`)
    }
  })

  test('reopening is amber, not red — a correction is not a failure', () => {
    assert.equal(ACTIVITY_EVENT_TONE.reopened, 'amber')
    assert.equal(ACTIVITY_EVENT_TONE.completed, 'green')
  })
})

describe('activitySentence', () => {
  test('reads as event, actor, timestamp', () => {
    const line = activitySentence(entry({ event_type: 'started', actor_name: 'Nishant Soni' }))
    assert.match(line, /^Meeting started by Nishant Soni · /)
    // IST, because every other date in this module is IST.
    assert.match(line, /5 Aug 2026/)
  })

  test('a missing actor name never collapses the sentence', () => {
    // An audit line with no name is not an audit line.
    assert.match(activitySentence(entry({ actor_name: null })), /by Unknown ·/)
    assert.match(activitySentence(entry({ actor_name: '   ' })), /by Unknown ·/)
  })
})

describe('sortActivity', () => {
  test('oldest first — a lifecycle trail is a narrative and runs forwards', () => {
    const shuffled = [REOPENED_MEETING[3], REOPENED_MEETING[0], REOPENED_MEETING[4], REOPENED_MEETING[1], REOPENED_MEETING[2]]
    assert.deepEqual(
      sortActivity(shuffled).map(e => e.id),
      ['e1', 'e2', 'e3', 'e4', 'e5'],
    )
  })

  test('a tied timestamp breaks on id, so the order is stable', () => {
    const tied = [
      entry({ id: 'b', created_at: '2026-08-05T04:00:00Z' }),
      entry({ id: 'a', created_at: '2026-08-05T04:00:00Z' }),
    ]
    assert.deepEqual(sortActivity(tied).map(e => e.id), ['a', 'b'])
  })

  test('does not mutate its input', () => {
    const input = [REOPENED_MEETING[4], REOPENED_MEETING[0]]
    sortActivity(input)
    assert.deepEqual(input.map(e => e.id), ['e5', 'e1'])
  })
})

describe('completionEvents — the preservation guarantee', () => {
  test('a reopened-and-recompleted meeting keeps BOTH completions', () => {
    // THE regression this feature exists to prevent. Before the activity log,
    // reopening cleared completed_at/completed_by and the first completion —
    // Priya's, at 12:05 IST on 5 Aug — was simply gone.
    const completions = completionEvents(REOPENED_MEETING)
    assert.equal(completions.length, 2)
    assert.deepEqual(completions.map(e => e.id), ['e3', 'e5'])
  })

  test('each completion keeps its own actor and timestamp', () => {
    const [first, second] = completionEvents(REOPENED_MEETING)
    assert.equal(first.actor_name, 'Priya Nair')
    assert.equal(second.actor_name, 'Nishant Soni')
    assert.notEqual(first.created_at, second.created_at)
    // The second completion never overwrote the first.
    assert.ok(first.created_at < second.created_at)
  })

  test('completions come back oldest first, whatever order they arrived in', () => {
    const reversed = [...REOPENED_MEETING].reverse()
    assert.deepEqual(completionEvents(reversed).map(e => e.id), ['e3', 'e5'])
  })

  test('a meeting never completed reports none', () => {
    assert.deepEqual(completionEvents(REOPENED_MEETING.slice(0, 2)), [])
    assert.deepEqual(completionEvents([]), [])
  })

  test('only completions are returned — started and reopened are not completions', () => {
    for (const e of completionEvents(REOPENED_MEETING)) {
      assert.equal(e.event_type, 'completed')
    }
  })
})

describe('wasReopened', () => {
  test('true once a completed meeting has been reopened', () => {
    assert.equal(wasReopened(REOPENED_MEETING), true)
  })

  test('false for a meeting that ran straight through', () => {
    assert.equal(wasReopened(REOPENED_MEETING.slice(0, 3)), false)
    assert.equal(wasReopened([]), false)
  })
})
