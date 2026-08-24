/**
 * isOverdue() — the shared overdue predicate behind TaskCard, the dashboard's
 * Overdue Tasks widget and the manager view.
 *
 * A task the assignee has submitted for approval must not read as overdue
 * here either, or "My Tasks"/dashboard/manager surfaces disagree with
 * Performance about the same task — see accruesAssigneeOverdue() in
 * lib/tasks/reviewTransitions.ts, the rule this delegates to.
 *
 * Run:
 *   npx tsx --test src/lib/ui.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { isOverdue } from './ui'

describe('isOverdue', () => {
  const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const TODAY     = new Date().toISOString().slice(0, 10)
  const TOMORROW  = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)

  test('no due date is never overdue', () => {
    assert.equal(isOverdue(null, 'working'), false)
  })

  test('a past due date with no status passed is overdue (caller pre-filtered)', () => {
    assert.equal(isOverdue(YESTERDAY), true)
  })

  test('due today or in the future is not overdue', () => {
    assert.equal(isOverdue(TODAY, 'working'), false)
    assert.equal(isOverdue(TOMORROW, 'working'), false)
  })

  test('completed and cancelled are never overdue', () => {
    assert.equal(isOverdue(YESTERDAY, 'completed'), false)
    assert.equal(isOverdue(YESTERDAY, 'cancelled'), false)
  })

  test('a task submitted for approval is not overdue, even past its due date', () => {
    assert.equal(isOverdue(YESTERDAY, 'pending_approval'), false)
  })

  test('work genuinely still with the assignee remains overdue when past due', () => {
    for (const status of ['pending', 'started', 'working', 'waiting', 'blocked']) {
      assert.equal(isOverdue(YESTERDAY, status), true, status)
    }
  })
})
