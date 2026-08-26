/**
 * My Tasks tab classification — behavioural tests.
 *
 * The defect these hold shut: a task the assignee had already submitted for
 * approval stayed in their working list. `pending_approval` is the creator's
 * move — the assignee has nothing left to do with it until the creator
 * approves or returns it — so it must appear in Awaiting Approval and in no
 * active working tab, and it must move back the moment the creator decides.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/myTaskTabs.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { Task } from '@/lib/types'
import {
  ACTIVE_WORKING_TABS,
  countTaskTypeWorkload,
  filterByTaskType,
  isActionableWorkload,
  isClosed,
  AWAITING_APPROVAL_LABEL,
  AWAITING_APPROVAL_STATUS,
  MY_TASK_TAB_KEYS,
  MY_TASK_TAB_LABELS,
  buildMyTaskBuckets,
  countMyTaskBuckets,
  isAwaitingApproval,
  isOverdue,
  isUnacknowledged,
  needsUpdate,
  normalizeDueDate,
  localDateStr,
  type MyTaskTabKey,
} from './myTaskTabs'

const TODAY = '2026-08-26'
const NOW   = Date.parse('2026-08-26T09:00:00.000Z')
const CLOCK = { todayStr: TODAY, nowMs: NOW }

const ME    = 'user-me'
const BOSS  = 'user-boss'

let seq = 0
function task(over: Partial<Task> = {}): Task {
  seq += 1
  return {
    id: `t${seq}`,
    title: `Task ${seq}`,
    note: null,
    status: 'working',
    priority: 'medium',
    type: 'task',
    is_urgent: false,
    due_date: TODAY,
    // Acknowledged by default: an unacknowledged task is its own case below.
    acknowledged_at: '2026-08-20T09:00:00.000Z',
    created_at: '2026-08-20T09:00:00.000Z',
    last_update_at: '2026-08-26T08:00:00.000Z',
    assigned_to: ME,
    created_by: BOSS,
    delegated_by: null,
    copied_from_task_id: null,
    blocker_reason: null,
    waiting_on_type: null,
    waiting_on_user_id: null,
    waiting_on_text: null,
    team: 'ops',
    task_type: 'general',
    customer_name: null,
    contact_number: null,
    company_name: null,
    city_project: null,
    attachment_url: null,
    cancelled_by: null,
    cancelled_at: null,
    cancellation_reason: null,
    ...over,
  } as Task
}

const ids = (rows: Task[]) => rows.map(r => r.id).sort()

// ── 1. The approval rule ─────────────────────────────────────────────────────

describe('pending_approval placement', () => {
  test('a submitted task is in NO active working tab', () => {
    const submitted = task({ id: 'submitted', status: AWAITING_APPROVAL_STATUS })
    const buckets = buildMyTaskBuckets([submitted], CLOCK)

    for (const tab of ACTIVE_WORKING_TABS) {
      assert.equal(
        buckets[tab].some(t => t.id === 'submitted'), false,
        `"${tab}" must not contain a task awaiting approval`,
      )
    }
  })

  test('the exclusion holds for every shape of submitted task', () => {
    // Overdue, urgent, stale and never-acknowledged all previously found their
    // own way back into a working tab through a different predicate.
    const shapes: Task[] = [
      task({ id: 'overdue',  status: AWAITING_APPROVAL_STATUS, due_date: '2026-01-01' }),
      task({ id: 'urgent',   status: AWAITING_APPROVAL_STATUS, is_urgent: true }),
      task({ id: 'stale',    status: AWAITING_APPROVAL_STATUS, last_update_at: '2026-01-01T00:00:00.000Z' }),
      task({ id: 'unack',    status: AWAITING_APPROVAL_STATUS, acknowledged_at: null }),
      task({ id: 'future',   status: AWAITING_APPROVAL_STATUS, due_date: '2026-12-31' }),
      task({ id: 'nodate',   status: AWAITING_APPROVAL_STATUS, due_date: null }),
    ]
    const buckets = buildMyTaskBuckets(shapes, CLOCK)

    for (const tab of ACTIVE_WORKING_TABS) {
      assert.deepEqual(buckets[tab], [], `"${tab}" leaked a submitted task`)
    }
    assert.equal(buckets.awaiting_approval.length, shapes.length)
  })

  test('it appears exactly ONCE across every tab', () => {
    const rows = [task({ id: 'submitted', status: AWAITING_APPROVAL_STATUS })]
    const buckets = buildMyTaskBuckets(rows, CLOCK)
    const appearances = MY_TASK_TAB_KEYS.filter(k => buckets[k].some(t => t.id === 'submitted'))
    assert.deepEqual(appearances, ['awaiting_approval'])
  })

  test('the count badge matches the tab contents', () => {
    const rows = [
      task({ status: AWAITING_APPROVAL_STATUS }),
      task({ status: AWAITING_APPROVAL_STATUS }),
      task({ status: 'working' }),
      task({ status: 'completed' }),
    ]
    const buckets = buildMyTaskBuckets(rows, CLOCK)
    const counts  = countMyTaskBuckets(buckets)
    assert.equal(counts.awaiting_approval, 2)
    assert.equal(counts.awaiting_approval, buckets.awaiting_approval.length)
    // And every other badge still agrees with its own tab.
    for (const key of MY_TASK_TAB_KEYS) assert.equal(counts[key], buckets[key].length)
  })

  test('the tab is named "Awaiting Approval" and the label is one constant', () => {
    assert.equal(AWAITING_APPROVAL_LABEL, 'Awaiting Approval')
    assert.equal(MY_TASK_TAB_LABELS.awaiting_approval, AWAITING_APPROVAL_LABEL)
  })

  test('awaiting_approval is not itself listed as an active working tab', () => {
    assert.equal(ACTIVE_WORKING_TABS.includes('awaiting_approval' as MyTaskTabKey), false)
  })
})

// ── 2. Leaving the queue ─────────────────────────────────────────────────────

describe('the creator decides', () => {
  const submitted = () => task({ id: 'x', status: AWAITING_APPROVAL_STATUS, due_date: TODAY })

  test('APPROVED → out of Awaiting Approval, into Completed', () => {
    const before = buildMyTaskBuckets([submitted()], CLOCK)
    assert.equal(before.awaiting_approval.length, 1)

    // transition_task_review('approve') sets status = completed.
    const after = buildMyTaskBuckets([{ ...submitted(), status: 'completed' } as Task], CLOCK)
    assert.deepEqual(after.awaiting_approval, [])
    assert.deepEqual(ids(after.completed), ['x'])
  })

  test('RETURNED → out of Awaiting Approval, back into the actionable tabs', () => {
    // transition_task_review('return') and restoreTargetStatus both land on
    // `working`, so this is the one status a returned task can hold.
    const after = buildMyTaskBuckets([{ ...submitted(), status: 'working' } as Task], CLOCK)
    assert.deepEqual(after.awaiting_approval, [])
    assert.deepEqual(ids(after.today_actionable), ['x'])
    assert.deepEqual(ids(after.all), ['x'])
    assert.deepEqual(ids(after.action_required), ['x'])
  })

  test('RETURNED and overdue → the overdue actionable tab, and overdue counts again', () => {
    const late = { ...submitted(), status: 'working', due_date: '2026-01-01' } as Task
    const after = buildMyTaskBuckets([late], CLOCK)
    assert.deepEqual(ids(after.overdue_actionable), ['x'])
    assert.deepEqual(ids(after.overdue), ['x'])
    // …whereas while it was submitted it did not.
    const whileSubmitted = buildMyTaskBuckets(
      [{ ...late, status: AWAITING_APPROVAL_STATUS } as Task], CLOCK)
    assert.deepEqual(whileSubmitted.overdue, [])
  })

  test('CANCELLED → in no tab at all', () => {
    const after = buildMyTaskBuckets([{ ...submitted(), status: 'cancelled' } as Task], CLOCK)
    for (const key of MY_TASK_TAB_KEYS) assert.deepEqual(after[key], [], key)
  })
})

// ── 3. Nothing else moved ────────────────────────────────────────────────────

describe('every other status is classified exactly as before', () => {
  test('working / waiting / blocked / completed land where they always did', () => {
    const rows = [
      task({ id: 'today',    status: 'working',   due_date: TODAY }),
      task({ id: 'late',     status: 'working',   due_date: '2026-01-01' }),
      task({ id: 'future',   status: 'working',   due_date: '2026-12-31' }),
      task({ id: 'waiting',  status: 'waiting',   due_date: TODAY }),
      task({ id: 'blocked',  status: 'blocked',   due_date: TODAY }),
      task({ id: 'done',     status: 'completed', due_date: TODAY }),
    ]
    const b = buildMyTaskBuckets(rows, CLOCK)
    assert.deepEqual(ids(b.today_actionable),   ['today'])
    assert.deepEqual(ids(b.overdue_actionable), ['late'])
    assert.deepEqual(ids(b.future_actionable),  ['future'])
    assert.deepEqual(ids(b.waiting_blocked),    ['blocked', 'waiting'])
    assert.deepEqual(ids(b.completed),          ['done'])
    assert.deepEqual(ids(b.all),                ['blocked', 'future', 'late', 'today', 'waiting'])
  })

  test('important, unacknowledged, needs_update and non_completion are unchanged', () => {
    const rows = [
      task({ id: 'urgent', status: 'working',  is_urgent: true }),
      task({ id: 'unack',  status: 'pending',  acknowledged_at: null }),
      task({ id: 'stale',  status: 'working',  last_update_at: '2026-01-01T00:00:00.000Z', due_date: TODAY }),
      task({ id: 'both',   status: 'working',  last_update_at: '2026-01-01T00:00:00.000Z', due_date: '2026-01-02' }),
    ]
    const b = buildMyTaskBuckets(rows, CLOCK)
    assert.deepEqual(ids(b.important),      ['urgent'])
    assert.deepEqual(ids(b.unacknowledged), ['unack'])
    assert.deepEqual(ids(b.needs_update),   ['both', 'stale'])
    assert.deepEqual(ids(b.non_completion), ['both'])
  })

  test('a self-created task is never "unacknowledged"', () => {
    const b = buildMyTaskBuckets(
      [task({ id: 'self', created_by: ME, assigned_to: ME, acknowledged_at: null })], CLOCK)
    assert.deepEqual(b.unacknowledged, [])
  })

  test('important sorts urgent rows to the front of every bucket', () => {
    const b = buildMyTaskBuckets([
      task({ id: 'plain',  is_urgent: false }),
      task({ id: 'urgent', is_urgent: true  }),
    ], CLOCK)
    assert.deepEqual(b.today_actionable.map(t => t.id), ['urgent', 'plain'])
  })
})

// ── 4. One pass, one collection ──────────────────────────────────────────────

describe('tab switching reads already-loaded data', () => {
  test('every tab is produced by a single call over a single array', () => {
    // The structural guarantee behind "switching among already-loaded tabs is
    // immediate": there is no per-tab fetch to make, because one call over one
    // in-memory collection produces all of them.
    const rows = [
      task({ status: 'working' }),
      task({ status: AWAITING_APPROVAL_STATUS }),
      task({ status: 'completed' }),
    ]
    const buckets = buildMyTaskBuckets(rows, CLOCK)
    assert.deepEqual(Object.keys(buckets).sort(), [...MY_TASK_TAB_KEYS].sort())
    // Nothing is invented and nothing is mutated.
    const known = new Set(rows.map(r => r.id))
    for (const key of MY_TASK_TAB_KEYS) {
      for (const row of buckets[key]) assert.ok(known.has(row.id))
    }
    assert.deepEqual(rows.map(r => r.status), ['working', AWAITING_APPROVAL_STATUS, 'completed'])
  })

  test('an empty collection yields empty tabs, not missing ones', () => {
    const buckets = buildMyTaskBuckets([], CLOCK)
    for (const key of MY_TASK_TAB_KEYS) assert.deepEqual(buckets[key], [], key)
    const counts = countMyTaskBuckets(buckets)
    for (const key of MY_TASK_TAB_KEYS) assert.equal(counts[key], 0, key)
  })

  test('classification depends only on the injected clock', () => {
    const rows = [task({ id: 'x', status: 'working', due_date: '2026-08-26' })]
    assert.deepEqual(ids(buildMyTaskBuckets(rows, CLOCK).today_actionable), ['x'])
    assert.deepEqual(
      ids(buildMyTaskBuckets(rows, { todayStr: '2026-08-27', nowMs: NOW }).overdue_actionable),
      ['x'])
  })
})

// ── 5. Task Type sidebar counts ──────────────────────────────────────────────

describe('the Task Type sidebar counts work requiring this user', () => {
  // One of each shape, so every count below is checkable by hand.
  const workload = () => [
    task({ id: 'own-working',   status: 'working',  created_by: ME   }),
    task({ id: 'own-waiting',   status: 'waiting',  created_by: ME   }),
    task({ id: 'deleg-working', status: 'working',  created_by: BOSS }),
    task({ id: 'deleg-blocked', status: 'blocked',  created_by: BOSS }),
  ]
  const submitted = () => [
    task({ id: 'own-submitted',   status: AWAITING_APPROVAL_STATUS, created_by: ME   }),
    task({ id: 'deleg-submitted', status: AWAITING_APPROVAL_STATUS, created_by: BOSS }),
  ]
  const closed = () => [
    task({ id: 'done',      status: 'completed', created_by: BOSS }),
    task({ id: 'abandoned', status: 'cancelled', created_by: BOSS }),
  ]

  test('pending_approval is excluded from EVERY Task Type count', () => {
    const withOut = countTaskTypeWorkload(workload(), ME)
    const withIn  = countTaskTypeWorkload([...workload(), ...submitted()], ME)
    assert.deepEqual(withIn, withOut, 'adding submitted tasks must not move any count')
    assert.deepEqual(withIn, { all: 4, self: 2, delegated: 2 })
  })

  test('a sidebar made only of submitted tasks counts zero, not two', () => {
    assert.deepEqual(countTaskTypeWorkload(submitted(), ME), { all: 0, self: 0, delegated: 0 })
  })

  test('pending_approval is still counted in Awaiting Approval', () => {
    const all = [...workload(), ...submitted(), ...closed()]
    const counts = countMyTaskBuckets(buildMyTaskBuckets(all, CLOCK))
    assert.equal(counts.awaiting_approval, 2)
    assert.deepEqual(ids(buildMyTaskBuckets(all, CLOCK).awaiting_approval),
      ['deleg-submitted', 'own-submitted'])
  })

  test('active task counts remain correct — closed tasks are still excluded', () => {
    const counts = countTaskTypeWorkload([...workload(), ...closed()], ME)
    assert.deepEqual(counts, { all: 4, self: 2, delegated: 2 })
  })

  test('self + delegated always sum to all', () => {
    for (const rows of [workload(), [...workload(), ...submitted(), ...closed()], submitted(), []]) {
      const c = countTaskTypeWorkload(rows, ME)
      assert.equal(c.self + c.delegated, c.all)
    }
  })

  test('a self-assigned task counts as self, not delegated', () => {
    const c = countTaskTypeWorkload(
      [task({ status: 'working', created_by: ME, assigned_to: ME })], ME)
    assert.deepEqual(c, { all: 1, self: 1, delegated: 0 })
  })

  test('the sidebar count equals the tab it summarises', () => {
    // The sidebar's `all` and the `all` tab must be the same set, or the badge
    // is describing a list nobody can open.
    const rows = [...workload(), ...submitted(), ...closed()]
    const sidebar = countTaskTypeWorkload(rows, ME)
    const tabAll  = buildMyTaskBuckets(rows, CLOCK).all
    assert.equal(sidebar.all, tabAll.length)
    assert.deepEqual(ids(tabAll), ids(rows.filter(isActionableWorkload)))
  })

  test('each Task Type count equals its own filtered `all` tab', () => {
    const rows = [...workload(), ...submitted(), ...closed()]
    const counts = countTaskTypeWorkload(rows, ME)
    for (const type of ['all', 'self', 'delegated'] as const) {
      const scoped = buildMyTaskBuckets(filterByTaskType(rows, type, ME), CLOCK).all
      assert.equal(counts[type], scoped.length, type)
    }
  })
})

describe('nothing is counted twice, and nothing falls through', () => {
  const everything = () => [
    task({ id: 'a', status: 'pending'  }), task({ id: 'b', status: 'started' }),
    task({ id: 'c', status: 'working'  }), task({ id: 'd', status: 'waiting' }),
    task({ id: 'e', status: 'blocked'  }),
    task({ id: 'f', status: AWAITING_APPROVAL_STATUS }),
    task({ id: 'g', status: 'completed' }), task({ id: 'h', status: 'cancelled' }),
  ]

  test('workload / awaiting approval / closed are mutually exclusive', () => {
    for (const t of everything()) {
      const memberships = [isActionableWorkload(t), isAwaitingApproval(t), isClosed(t)]
        .filter(Boolean).length
      assert.equal(memberships, 1, `${t.status} is in ${memberships} of the three`)
    }
  })

  test('and exhaustive — every task lands in exactly one', () => {
    const rows = everything()
    const workload = rows.filter(isActionableWorkload)
    const awaiting = rows.filter(isAwaitingApproval)
    const done     = rows.filter(isClosed)
    assert.equal(workload.length + awaiting.length + done.length, rows.length)
    assert.deepEqual(
      [...workload, ...awaiting, ...done].map(t => t.id).sort(),
      rows.map(t => t.id).sort(),
    )
  })

  test('the sidebar total and the Awaiting Approval badge never overlap', () => {
    const rows = everything()
    const sidebar = countTaskTypeWorkload(rows, ME)
    const buckets = buildMyTaskBuckets(rows, CLOCK)
    const awaitingIds = new Set(buckets.awaiting_approval.map(t => t.id))
    // No id counted by the sidebar is also in Awaiting Approval…
    for (const t of rows.filter(isActionableWorkload)) {
      assert.equal(awaitingIds.has(t.id), false, `${t.id} counted twice`)
    }
    // …and the two together never exceed the open tasks.
    assert.equal(sidebar.all + buckets.awaiting_approval.length,
      rows.filter(t => !isClosed(t)).length)
  })

  test('the `all` tab and Awaiting Approval share no row', () => {
    const buckets = buildMyTaskBuckets(everything(), CLOCK)
    const inAll = new Set(buckets.all.map(t => t.id))
    for (const t of buckets.awaiting_approval) assert.equal(inAll.has(t.id), false, t.id)
  })
})

// ── 6. Helpers ───────────────────────────────────────────────────────────────

describe('helpers', () => {
  test('isAwaitingApproval is the single predicate', () => {
    assert.equal(isAwaitingApproval({ status: 'pending_approval' } as Task), true)
    for (const s of ['pending', 'started', 'working', 'waiting', 'blocked', 'completed', 'cancelled']) {
      assert.equal(isAwaitingApproval({ status: s } as Task), false, s)
    }
  })

  test('isOverdue exempts a submitted task', () => {
    const late = { due_date: '2026-01-01', status: 'working' } as Task
    assert.equal(isOverdue(late, TODAY), true)
    assert.equal(isOverdue({ ...late, status: 'pending_approval' } as Task, TODAY), false)
    assert.equal(isOverdue({ ...late, status: 'completed' } as Task, TODAY), false)
    assert.equal(isOverdue({ ...late, status: 'cancelled' } as Task, TODAY), false)
  })

  test('normalizeDueDate accepts both stored shapes and rejects junk', () => {
    assert.equal(normalizeDueDate('2026-08-26'), '2026-08-26')
    assert.equal(normalizeDueDate(null), null)
    assert.equal(normalizeDueDate('not a date'), null)
    assert.equal(normalizeDueDate(''), null)
  })

  test('localDateStr formats the local calendar date', () => {
    const at = new Date(2026, 7, 26, 12, 0, 0)
    assert.equal(localDateStr(0, at), '2026-08-26')
    assert.equal(localDateStr(1, at), '2026-08-27')
    assert.equal(localDateStr(-1, at), '2026-08-25')
  })

  test('needsUpdate is 48h since the last update, and never for closed tasks', () => {
    const base = { status: 'working', created_at: '2026-01-01T00:00:00.000Z' }
    assert.equal(needsUpdate({ ...base, last_update_at: '2026-08-26T08:00:00.000Z' } as Task, NOW), false)
    assert.equal(needsUpdate({ ...base, last_update_at: '2026-08-20T08:00:00.000Z' } as Task, NOW), true)
    assert.equal(needsUpdate({ ...base, status: 'completed', last_update_at: '2026-01-01T00:00:00.000Z' } as Task, NOW), false)
    assert.equal(needsUpdate({ ...base, status: 'cancelled', last_update_at: '2026-01-01T00:00:00.000Z' } as Task, NOW), false)
  })

  test('unacknowledged ignores a submitted task even without the bucket rule', () => {
    // isUnacknowledged itself is unchanged; the bucket applies the approval
    // rule on top. Both are asserted so neither can be relaxed alone.
    assert.equal(isUnacknowledged({
      acknowledged_at: null, status: 'pending_approval', created_by: BOSS, assigned_to: ME,
    } as Task), true)
    assert.deepEqual(buildMyTaskBuckets([task({
      acknowledged_at: null, status: AWAITING_APPROVAL_STATUS,
    })], CLOCK).unacknowledged, [])
  })
})
