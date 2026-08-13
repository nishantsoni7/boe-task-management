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
import {
  canMarkComplete, canPostUpdate,
  canSubmitForApproval, canApproveTask, canReturnTask, needsCreatorApproval,
  type TaskAccessSubject,
} from './taskDetailAccess'

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

/** The same delegated task, handed to the creator and awaiting their decision. */
const awaitingApproval = (over: Partial<TaskAccessSubject> = {}): TaskAccessSubject =>
  delegated({ status: 'pending_approval', ...over })

describe('canMarkComplete', () => {
  // CHANGED, deliberately: a delegated ordinary task is no longer completed by
  // its assignee in one click. It goes to its creator for approval, and the
  // assignee's button becomes Submit for Approval. The two exemptions below —
  // self tasks and quotation requests — are unchanged, and they are what these
  // assertions mostly exist to protect.
  test('the assignee may NOT directly complete a delegated ordinary task', () => {
    assert.equal(canMarkComplete(delegated(), ASSIGNEE), false)
  })

  test('the delegator may NOT complete on the assignee\'s behalf', () => {
    // Completion is an accountability record about the assignee's work. The
    // creator's route to `completed` is approval, not a direct write.
    assert.equal(canMarkComplete(delegated(), CREATOR), false)
  })

  test('an unrelated user may not complete', () => {
    assert.equal(canMarkComplete(delegated(), OUTSIDER), false)
  })

  test('a self-assigned task stays directly completable, with no acknowledgement', () => {
    assert.equal(canMarkComplete(selfTask(), ASSIGNEE), true)
    assert.equal(canMarkComplete(selfTask({ status: 'waiting' }), ASSIGNEE), true)
  })

  test('a quotation request keeps its own completion, unchanged', () => {
    assert.equal(
      canMarkComplete(delegated({ acknowledged_at: null, task_type: 'quotation_request' }), ASSIGNEE),
      true,
    )
    assert.equal(
      canMarkComplete(delegated({ task_type: 'quotation_request' }), ASSIGNEE),
      true,
    )
  })

  test('a quotation request is still not completable by its requester or an outsider', () => {
    const q = delegated({ task_type: 'quotation_request' })
    assert.equal(canMarkComplete(q, CREATOR), false)
    assert.equal(canMarkComplete(q, OUTSIDER), false)
  })

  test('an unacknowledged self task is still completable; the ack gate never applied to it', () => {
    assert.equal(canMarkComplete(selfTask({ acknowledged_at: null }), ASSIGNEE), true)
  })

  test('an already completed or cancelled task cannot be completed again', () => {
    for (const status of ['completed', 'cancelled']) {
      assert.equal(canMarkComplete(selfTask({ status }), ASSIGNEE), false, status)
      assert.equal(canMarkComplete(delegated({ status }), ASSIGNEE), false, status)
    }
  })

  test('nobody may directly complete a task awaiting approval', () => {
    for (const user of [ASSIGNEE, CREATOR, OUTSIDER]) {
      assert.equal(canMarkComplete(awaitingApproval(), user), false, user)
    }
  })

  test('completion is strictly narrower than posting an update', () => {
    // Every case where someone may complete, they may also comment — never the
    // reverse. A regression that widened completion would break this.
    const cases: TaskAccessSubject[] = [
      delegated(), delegated({ acknowledged_at: null }), selfTask(), awaitingApproval(),
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

// ─── Creator approval ────────────────────────────────────────────────────────
//
// The matrix these assert is the whole point of the workflow: three actions,
// each belonging to exactly one person, each available in exactly one window.
// Every one of them is re-derived from the locked row inside
// transition_task_review(); if these ever disagree with that function, the
// database wins and the UI is the thing that is wrong.

describe('needsCreatorApproval', () => {
  test('a delegated ordinary task does', () => {
    assert.equal(needsCreatorApproval(delegated()), true)
  })

  test('a self task does not — there is nobody to approve to', () => {
    assert.equal(needsCreatorApproval(selfTask()), false)
  })

  test('a quotation request does not, however it is assigned', () => {
    assert.equal(needsCreatorApproval(delegated({ task_type: 'quotation_request' })), false)
  })

  test('an unassigned or un-attributed task does not', () => {
    assert.equal(needsCreatorApproval(delegated({ assigned_to: null })), false)
    assert.equal(needsCreatorApproval(delegated({ created_by: null })), false)
    assert.equal(needsCreatorApproval({
      assigned_to: null, created_by: null, status: 'working', acknowledged_at: null,
    }), false)
  })
})

describe('canSubmitForApproval', () => {
  test('the assignee may submit an acknowledged delegated task', () => {
    assert.equal(canSubmitForApproval(delegated(), ASSIGNEE), true)
  })

  test('submission requires acknowledgement, exactly as completion used to', () => {
    assert.equal(canSubmitForApproval(delegated({ acknowledged_at: null }), ASSIGNEE), false)
  })

  test('every status the old Mark Complete was offered from can be submitted from', () => {
    for (const status of ['pending', 'started', 'working', 'waiting', 'blocked']) {
      assert.equal(canSubmitForApproval(delegated({ status }), ASSIGNEE), true, status)
    }
  })

  test('the creator may NOT submit on the assignee\'s behalf', () => {
    assert.equal(canSubmitForApproval(delegated(), CREATOR), false)
  })

  test('an outsider may not submit', () => {
    assert.equal(canSubmitForApproval(delegated(), OUTSIDER), false)
  })

  test('a task already awaiting approval cannot be submitted again', () => {
    assert.equal(canSubmitForApproval(awaitingApproval(), ASSIGNEE), false)
  })

  test('a completed or cancelled task cannot be submitted', () => {
    for (const status of ['completed', 'cancelled']) {
      assert.equal(canSubmitForApproval(delegated({ status }), ASSIGNEE), false, status)
    }
  })

  test('self tasks and quotation requests have no submit action at all', () => {
    assert.equal(canSubmitForApproval(selfTask(), ASSIGNEE), false)
    assert.equal(canSubmitForApproval(delegated({ task_type: 'quotation_request' }), ASSIGNEE), false)
  })
})

describe('canApproveTask / canReturnTask', () => {
  test('the creator may approve and return a task awaiting approval', () => {
    assert.equal(canApproveTask(awaitingApproval(), CREATOR), true)
    assert.equal(canReturnTask(awaitingApproval(), CREATOR), true)
  })

  test('the assignee may do neither — that is the whole point', () => {
    assert.equal(canApproveTask(awaitingApproval(), ASSIGNEE), false)
    assert.equal(canReturnTask(awaitingApproval(), ASSIGNEE), false)
  })

  test('an outsider may do neither', () => {
    assert.equal(canApproveTask(awaitingApproval(), OUTSIDER), false)
    assert.equal(canReturnTask(awaitingApproval(), OUTSIDER), false)
  })

  test('neither action exists before the task is submitted', () => {
    for (const status of ['pending', 'started', 'working', 'waiting', 'blocked']) {
      assert.equal(canApproveTask(delegated({ status }), CREATOR), false, status)
      assert.equal(canReturnTask(delegated({ status }), CREATOR), false, status)
    }
  })

  test('neither action survives the decision — no second approval', () => {
    for (const status of ['completed', 'cancelled']) {
      assert.equal(canApproveTask(delegated({ status }), CREATOR), false, status)
      assert.equal(canReturnTask(delegated({ status }), CREATOR), false, status)
    }
  })

  test('a self task never reaches an approval decision', () => {
    // Belt and braces: even if a self task somehow carried the status, its one
    // participant does not get to approve their own work.
    assert.equal(canApproveTask(selfTask({ status: 'pending_approval' }), ASSIGNEE), false)
    assert.equal(canReturnTask(selfTask({ status: 'pending_approval' }), ASSIGNEE), false)
  })

  test('a quotation request has no approval decision', () => {
    const q = awaitingApproval({ task_type: 'quotation_request' })
    assert.equal(canApproveTask(q, CREATOR), false)
    assert.equal(canReturnTask(q, CREATOR), false)
  })
})

describe('the three actions never overlap', () => {
  test('no person holds two of submit / approve / complete on one task', () => {
    const statuses = ['pending', 'started', 'working', 'waiting', 'blocked', 'pending_approval', 'completed', 'cancelled']
    const shapes = [delegated, selfTask, (o: Partial<TaskAccessSubject> = {}) =>
      delegated({ task_type: 'quotation_request', ...o })]
    for (const shape of shapes) {
      for (const status of statuses) {
        for (const ack of [null, '2026-08-01T10:00:00Z']) {
          const task = shape({ status, acknowledged_at: ack })
          for (const user of [ASSIGNEE, CREATOR, OUTSIDER]) {
            const held = [
              canMarkComplete(task, user),
              canSubmitForApproval(task, user),
              canApproveTask(task, user),
            ].filter(Boolean).length
            assert.ok(held <= 1, `${user} held ${held} closing actions on ${shape.name}/${status}/ack=${ack}`)
          }
        }
      }
    }
  })
})
