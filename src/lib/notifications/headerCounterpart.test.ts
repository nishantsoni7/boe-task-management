/**
 * WHO THE NOTIFICATION CARD NAMES.
 *
 * The defect: a quotation request assigned to the reader rendered "Assigned to
 * Nishant" — the reader's own name — in the group header, while the event line
 * underneath correctly said "By Shravi". The header showed `tasks.assigned_to`
 * unconditionally, and for work assigned TO you that is always you.
 *
 * Every case here is an identity comparison against the task's own
 * assigned_to / created_by. Nothing parses a name out of a title or a body.
 *
 * Run:
 *   npx tsx --test src/lib/notifications/headerCounterpart.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { headerCounterpart, type TaskHeaderInfo } from './pageEnrichment'

const ME = '00000000-0000-4000-8000-00000000000a'
const SHRAVI = '00000000-0000-4000-8000-00000000000b'

const header = (over: Partial<TaskHeaderInfo> = {}): TaskHeaderInfo => ({
  title: 'Quotation - AMBIKA RESORTS',
  assigneeName: 'Nishant',
  assigneeId: ME,
  creatorName: 'Shravi',
  creatorId: SHRAVI,
  ...over,
})

describe('a quotation assigned to the reader', () => {
  test('names the assigner, not the reader', () => {
    const r = headerCounterpart(header(), ME)
    assert.equal(r.name, 'Shravi')
    assert.equal(r.relation, 'creator')
  })

  test('the reader’s own name is never the answer', () => {
    const r = headerCounterpart(header(), ME)
    assert.notEqual(r.name, 'Nishant')
  })
})

describe('an ordinary task the reader created', () => {
  test('still names the assignee — unchanged behaviour', () => {
    const r = headerCounterpart(
      header({ assigneeName: 'Shravi', assigneeId: SHRAVI, creatorName: 'Nishant', creatorId: ME }),
      ME,
    )
    assert.equal(r.name, 'Shravi')
    assert.equal(r.relation, 'assignee')
  })

  test('and so does a task between two other people', () => {
    const r = headerCounterpart(
      header({ assigneeName: 'Shravi', assigneeId: SHRAVI, creatorName: 'Dhruv', creatorId: 'other' }),
      ME,
    )
    assert.equal(r.name, 'Shravi')
    assert.equal(r.relation, 'assignee')
  })
})

describe('nobody to name', () => {
  test('a self task names neither side', () => {
    const r = headerCounterpart(
      header({ assigneeName: 'Nishant', assigneeId: ME, creatorName: 'Nishant', creatorId: ME }),
      ME,
    )
    assert.equal(r.name, null)
    assert.equal(r.relation, 'self')
  })

  test('reader is the assignee and the creator was deleted — no name, not the reader’s', () => {
    const r = headerCounterpart(header({ creatorName: null, creatorId: SHRAVI }), ME)
    assert.equal(r.name, null)
    assert.equal(r.relation, 'unknown')
  })

  test('an older row with no ids at all falls back to the assignee, as before', () => {
    // Rows written before the ids travelled on the context. The previous
    // behaviour is the safe one: it can only show what the page already showed.
    const r = headerCounterpart(
      { title: 't', assigneeName: 'Shravi' },
      ME,
    )
    assert.equal(r.name, 'Shravi')
    assert.equal(r.relation, 'assignee')
  })

  test('no header at all does not throw', () => {
    const r = headerCounterpart(undefined, ME)
    assert.equal(r.name, null)
    assert.equal(r.relation, 'unknown')
  })

  test('an unresolved viewer keeps the old answer', () => {
    // Identity not loaded yet: naming the assignee is what the page did before,
    // and it never invents anybody.
    const r = headerCounterpart(header(), null)
    assert.equal(r.name, 'Nishant')
    assert.equal(r.relation, 'assignee')
  })

  test('blank and whitespace names are treated as absent', () => {
    const r = headerCounterpart(header({ creatorName: '   ' }), ME)
    assert.equal(r.name, null)
    assert.equal(r.relation, 'unknown')
  })

  test('an unassigned task names its author, unless that is the reader', () => {
    const open = headerCounterpart(
      header({ assigneeName: null, assigneeId: null }), ME,
    )
    assert.equal(open.name, 'Shravi')
    assert.equal(open.relation, 'creator')

    const mine = headerCounterpart(
      header({ assigneeName: null, assigneeId: null, creatorName: 'Nishant', creatorId: ME }), ME,
    )
    assert.equal(mine.name, null)
    assert.equal(mine.relation, 'unknown')
  })
})

describe('identity, not spelling', () => {
  test('two people with the same display name are told apart by id', () => {
    // Same name on both sides, different people. The reader is the assignee, so
    // the creator is the counterpart — and it is a real, different person.
    const r = headerCounterpart(
      header({ assigneeName: 'Nishant', assigneeId: ME, creatorName: 'Nishant', creatorId: SHRAVI }),
      ME,
    )
    assert.equal(r.relation, 'creator')
    assert.equal(r.name, 'Nishant')
  })

  test('a matching NAME with a different id does not make the reader the assignee', () => {
    const r = headerCounterpart(
      header({ assigneeName: 'Nishant', assigneeId: 'somebody-else' }),
      ME,
    )
    assert.equal(r.relation, 'assignee')
    assert.equal(r.name, 'Nishant')
  })
})
