/**
 * Task-detail authorization — the two gates the update/completion performance
 * work touches.
 *
 * These assertions exist to pin behaviour that must NOT have changed: making
 * the update box and the Mark Complete button faster is not allowed to make
 * either of them available to someone new. Read them as a description of the
 * rules as they shipped, not as a proposal.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/taskDetailAccess.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { canMarkComplete, canPostUpdate, type TaskAccessSubject } from './taskDetailAccess'

const ASSIGNEE = 'user-assignee'
const CREATOR  = 'user-creator'
const OUTSIDER = 'user-outsider'

/** A live, acknowledged task delegated by CREATOR to ASSIGNEE. */
const delegated = (over: Partial<TaskAccessSubject> = {}): TaskAccessSubject => ({
  assigned_to:     ASSIGNEE,
  created_by:      CREATOR,
  status:          'working',
  acknowledged_at: '2026-08-01T10:00:00Z',
  task_type:       'task',
  ...over,
})

/** A task the same person created and owns. */
const selfTask = (over: Partial<TaskAccessSubject> = {}): TaskAccessSubject =>
  delegated({ created_by: ASSIGNEE, acknowledged_at: null, ...over })

describe('canPostUpdate', () => {
  test('the assignee may post an update', () => {
    assert.equal(canPostUpdate(delegated(), ASSIGNEE), true)
  })

  test('the creator/delegator may post an update', () => {
    assert.equal(canPostUpdate(delegated(), CREATOR), true)
  })

  test('an unrelated user may not', () => {
    assert.equal(canPostUpdate(delegated(), OUTSIDER), false)
  })

  test('nobody may post on a completed or cancelled task', () => {
    for (const status of ['completed', 'cancelled']) {
      assert.equal(canPostUpdate(delegated({ status }), ASSIGNEE), false, status)
      assert.equal(canPostUpdate(delegated({ status }), CREATOR), false, status)
    }
  })

  test('an unacknowledged task can still be discussed', () => {
    // Acknowledgement gates completion, not conversation — unchanged.
    assert.equal(canPostUpdate(delegated({ acknowledged_at: null }), ASSIGNEE), true)
  })

  test('a self-assigned task is postable by its one participant', () => {
    assert.equal(canPostUpdate(selfTask(), ASSIGNEE), true)
    assert.equal(canPostUpdate(selfTask(), OUTSIDER), false)
  })

  test('an unassigned task grants nothing to a null-matching user', () => {
    // Guards against `undefined === undefined` accidentally authorising someone.
    const orphan: TaskAccessSubject = {
      assigned_to: null, created_by: null, status: 'working', acknowledged_at: null,
    }
    assert.equal(canPostUpdate(orphan, OUTSIDER), false)
  })
})

describe('canMarkComplete', () => {
  test('the assignee may complete an acknowledged assigned task', () => {
    assert.equal(canMarkComplete(delegated(), ASSIGNEE), true)
  })

  test('the delegator may NOT complete on the assignee\'s behalf', () => {
    // Completion is an accountability record about the assignee's work.
    assert.equal(canMarkComplete(delegated(), CREATOR), false)
  })

  test('an unrelated user may not complete', () => {
    assert.equal(canMarkComplete(delegated(), OUTSIDER), false)
  })

  test('an assigned task must be acknowledged before it can be completed', () => {
    assert.equal(canMarkComplete(delegated({ acknowledged_at: null }), ASSIGNEE), false)
  })

  test('a self-assigned task needs no acknowledgement', () => {
    assert.equal(canMarkComplete(selfTask(), ASSIGNEE), true)
  })

  test('a quotation request needs no acknowledgement', () => {
    assert.equal(
      canMarkComplete(delegated({ acknowledged_at: null, task_type: 'quotation_request' }), ASSIGNEE),
      true,
    )
  })

  test('an already completed or cancelled task cannot be completed again', () => {
    for (const status of ['completed', 'cancelled']) {
      assert.equal(canMarkComplete(delegated({ status }), ASSIGNEE), false, status)
    }
  })

  test('completion is strictly narrower than posting an update', () => {
    // Every case where someone may complete, they may also comment — never the
    // reverse. A regression that widened completion would break this.
    const cases: TaskAccessSubject[] = [
      delegated(), delegated({ acknowledged_at: null }), selfTask(),
      delegated({ status: 'completed' }), delegated({ task_type: 'quotation_request', acknowledged_at: null }),
    ]
    for (const task of cases) {
      for (const user of [ASSIGNEE, CREATOR, OUTSIDER]) {
        if (canMarkComplete(task, user)) {
          assert.equal(canPostUpdate(task, user), true, `${user} could complete but not comment`)
        }
      }
    }
  })
})
