/**
 * Classification against the ACTUAL API response shape.
 *
 * WHY SEPARATE FROM myTaskTabs.test.ts. That file proves the rules; this one
 * proves the rules are being fed what the server really sends. A row rendered
 * as "Approval Pending" was reported still appearing under View All, and the
 * first question is not "is the rule right" but "does the runtime row look like
 * the fixture the rule was tested with".
 *
 * THE RUNTIME REPRESENTATION, established from the code rather than assumed:
 *
 *   · useMyTasks selects a fixed column list from PostgREST. `status` is in it,
 *     as a plain column — there is no join, no view, no RPC and no client-side
 *     transform between the response and the classifier.
 *   · The string "Approval Pending" is produced by exactly ONE expression in
 *     the whole repository: taskStatusLabel(status, 'assignee') in lib/ui.ts,
 *     reached only when status === 'pending_approval'. There is no
 *     completion_status, no approval flag and no derived display field.
 *
 * So the raw value is `status === 'pending_approval'`, and the fixtures below
 * are built from the exact column list the query asks for — asserted against it,
 * so they cannot drift.
 *
 * No production content: every fixture value is invented.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/myTasksRuntimeShape.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Task } from '@/lib/types'
import { taskStatusLabel } from '@/lib/ui'
import {
  AWAITING_APPROVAL_LABEL,
  AWAITING_APPROVAL_STATUS,
  ACTIVE_WORKING_TABS,
  MY_TASK_TAB_KEYS,
  buildMyTaskBuckets,
  countMyTaskBuckets,
  countTaskTypeWorkload,
  filterByTaskType,
  isActionableWorkload,
  isAwaitingApproval,
} from './myTaskTabs'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const ME = '11111111-1111-4111-8111-111111111111'
const BOSS = '22222222-2222-4222-8222-222222222222'
const TODAY = '2026-08-26'
const CLOCK = { todayStr: TODAY, nowMs: Date.parse('2026-08-26T09:00:00.000Z') }

/** The exact columns useMyTasks asks PostgREST for. */
function requestedColumns(): string[] {
  const src = read('src/hooks/queries/useMyTasks.ts')
  const block = src.slice(src.indexOf('const TASK_COLUMNS'), src.indexOf(".join(', ')"))
  return [...block.matchAll(/'([a-z_]+)'/g)].map(m => m[1])
}

/**
 * One row exactly as PostgREST returns it: the requested columns and nothing
 * else. Deliberately NOT the full `Task` type — the response has no
 * `task_type`, no `attachment_url`, no `cancelled_at`, because they were not
 * asked for, and a classifier that quietly depended on one would pass a
 * generous fixture and fail in production.
 */
function apiRow(over: Record<string, unknown> = {}): Task {
  const base: Record<string, unknown> = {
    id: '33333333-3333-4333-8333-333333333333',
    title: 'A task',
    note: null,
    status: 'working',
    priority: 'medium',
    type: 'completion',
    is_urgent: false,
    due_date: TODAY,
    acknowledged_at: '2026-08-20T09:00:00.000Z',
    created_at: '2026-08-20T09:00:00.000Z',
    last_update_at: '2026-08-26T08:00:00.000Z',
    blocker_reason: null,
    waiting_on_type: null,
    waiting_on_user_id: null,
    waiting_on_text: null,
    assigned_to: ME,
    created_by: BOSS,
    delegated_by: null,
    team: 'ops',
  }
  return { ...base, ...over } as unknown as Task
}

// ── 0. The fixture is the response ──────────────────────────────────────────

describe('the fixture matches what the query actually asks for', () => {
  test('every requested column is present, and nothing extra is', () => {
    const columns = requestedColumns()
    assert.ok(columns.includes('status'), 'status is selected as a plain column')
    assert.deepEqual(Object.keys(apiRow()).sort(), [...columns].sort())
  })

  test('there is no join, RPC or transform between response and classifier', () => {
    const hook = read('src/hooks/queries/useMyTasks.ts')
    assert.ok(hook.includes(".from('tasks')"))
    assert.equal(/\.rpc\(|\.select\([^)]*\(/.test(hook), false, 'no embedded resource')
    // The rows are cast, never rewritten.
    assert.ok(hook.includes('as unknown as Task[]'))
    assert.equal(/\.map\(/.test(hook.slice(hook.indexOf('queryFn'), hook.indexOf('enabled:'))), false)
  })

  test('"Approval Pending" has exactly one producer, and it keys off status', () => {
    const ui = read('src/lib/ui.ts')
    assert.ok(ui.includes("if (status === 'pending_approval') {"))
    assert.ok(ui.includes("if (viewer === 'assignee') return 'Approval Pending'"))
    assert.equal(taskStatusLabel('pending_approval', 'assignee'), 'Approval Pending')
    // …and nothing else in the app can produce it.
    for (const s of ['pending', 'started', 'working', 'waiting', 'blocked', 'completed', 'cancelled']) {
      assert.notEqual(taskStatusLabel(s, 'assignee'), 'Approval Pending', s)
    }
  })
})

// ── 1-6. Placement of the real runtime representation ───────────────────────

describe('a row that displays as Approval Pending is classified as Awaiting Approval', () => {
  const submitted = apiRow({ id: 'submitted', status: AWAITING_APPROVAL_STATUS })

  test('1. the runtime value is recognised', () => {
    assert.equal(taskStatusLabel(submitted.status, 'assignee'), 'Approval Pending')
    assert.equal(isAwaitingApproval(submitted), true)
    assert.equal(isActionableWorkload(submitted), false)
  })

  test('2. it is excluded from the DEFAULT View All rows', () => {
    // The default view is Task Type "all" with no workflow tab selected, which
    // the page renders from buckets.all.
    const rows = buildMyTaskBuckets(filterByTaskType([submitted, apiRow({ id: 'live' })], 'all', ME), CLOCK).all
    assert.deepEqual(rows.map(r => r.id), ['live'])
  })

  test('3. it is excluded from all four actionable/waiting tabs', () => {
    const b = buildMyTaskBuckets([submitted], CLOCK)
    for (const tab of ['today_actionable', 'overdue_actionable', 'future_actionable', 'waiting_blocked'] as const) {
      assert.deepEqual(b[tab], [], tab)
    }
    // And from every other actionable bucket too.
    for (const tab of ACTIVE_WORKING_TABS) assert.deepEqual(b[tab], [], tab)
  })

  test('4. it is excluded from the actionable Task Type counts', () => {
    const withOut = countTaskTypeWorkload([apiRow({ id: 'live' })], ME)
    const withIn  = countTaskTypeWorkload([apiRow({ id: 'live' }), submitted], ME)
    assert.deepEqual(withIn, withOut)
    assert.deepEqual(withIn, { all: 1, self: 0, delegated: 1 })
  })

  test('5. it is excluded from the My Tasks / In Progress sidebar badge', () => {
    // The sidebar badge counts pending|started|working server-side — the same
    // three statuses, and pending_approval is not among them.
    const layout = read('src/components/layout/DashboardLayout.tsx')
    assert.ok(layout.includes(".in('status', ['pending', 'started', 'working'])"))
    assert.equal(layout.includes('pending_approval'), false)
    // And the page-side Task Type counts agree with that exclusion.
    assert.equal(countTaskTypeWorkload([submitted], ME).all, 0)
  })

  test('6. it appears exactly once, in Awaiting Approval', () => {
    const b = buildMyTaskBuckets([submitted], CLOCK)
    const seen = MY_TASK_TAB_KEYS.filter(k => b[k].some(t => t.id === 'submitted'))
    assert.deepEqual(seen, ['awaiting_approval'])
  })

  test('the row is LABELLED Awaiting Approval, not Approval Pending', () => {
    // The page overrides the assignee wording for exactly this state, so the
    // row and the tab holding it say the same thing. A My Tasks row reading
    // "Approval Pending" is therefore code from before this change.
    const page = read('src/app/tasks/my/page.tsx')
    assert.ok(page.includes(
      "isAwaitingApproval(task) ? AWAITING_APPROVAL_LABEL : taskStatusLabel(task.status, 'assignee')"))
    assert.equal(AWAITING_APPROVAL_LABEL, 'Awaiting Approval')
  })
})

// ── 7-8. Leaving the queue ──────────────────────────────────────────────────

describe('the creator decides, and placement follows', () => {
  test('7. approval removes it from Awaiting Approval', () => {
    const after = buildMyTaskBuckets([apiRow({ id: 'x', status: 'completed' })], CLOCK)
    assert.deepEqual(after.awaiting_approval, [])
    assert.deepEqual(after.completed.map(t => t.id), ['x'])
  })

  test('8. rejection / restoration returns it to the correct actionable group', () => {
    const returned = buildMyTaskBuckets([apiRow({ id: 'x', status: 'working', due_date: TODAY })], CLOCK)
    assert.deepEqual(returned.awaiting_approval, [])
    assert.deepEqual(returned.today_actionable.map(t => t.id), ['x'])
    assert.deepEqual(returned.all.map(t => t.id), ['x'])

    const overdue = buildMyTaskBuckets([apiRow({ id: 'x', status: 'working', due_date: '2026-01-01' })], CLOCK)
    assert.deepEqual(overdue.overdue_actionable.map(t => t.id), ['x'])
  })
})

// ── 9-11. Configuration and count agreement ─────────────────────────────────

describe('configuration and counts', () => {
  test('9/10. the tab configuration contains Awaiting Approval, for both widths', () => {
    const tabs = read('src/components/tasks/MyTaskViewTabs.tsx')
    assert.ok(tabs.includes("key: 'awaiting_approval'"))
    // ONE configuration, used at both widths — there is no separate mobile list
    // that could omit it.
    assert.equal((tabs.match(/MY_TASK_VIEW_TABS/g) ?? []).length >= 2, true)
    assert.equal((tabs.match(/key: 'awaiting_approval'/g) ?? []).length, 1)
    const page = read('src/app/tasks/my/page.tsx')
    assert.ok(page.includes('<MyTaskViewTabs'))
    assert.ok(page.includes('isMobile={isMobile}'))
  })

  test('11. displayed rows and badge counts use the same classifier', () => {
    const rows = [
      apiRow({ id: 'a', status: 'working',  due_date: TODAY }),
      apiRow({ id: 'b', status: 'waiting',  due_date: TODAY }),
      apiRow({ id: 'c', status: AWAITING_APPROVAL_STATUS }),
      apiRow({ id: 'd', status: 'completed' }),
    ]
    const buckets = buildMyTaskBuckets(rows, CLOCK)
    const badges  = countMyTaskBuckets(buckets)
    for (const key of MY_TASK_TAB_KEYS) {
      assert.equal(badges[key], buckets[key].length, key)
    }
    // And the sidebar workload total is the `all` tab, exactly.
    assert.equal(countTaskTypeWorkload(rows, ME).all, buckets.all.length)
  })

  test('the required equations hold on a mixed set', () => {
    const rows = [
      apiRow({ id: 'a', status: 'working' }),
      apiRow({ id: 'b', status: 'blocked' }),
      apiRow({ id: 'c', status: AWAITING_APPROVAL_STATUS }),
      apiRow({ id: 'd', status: AWAITING_APPROVAL_STATUS, created_by: ME }),
      apiRow({ id: 'e', status: 'cancelled' }),
    ]
    const b = buildMyTaskBuckets(rows, CLOCK)
    const workload = countTaskTypeWorkload(rows, ME)

    // actionable excludes Awaiting Approval; no task is in both
    const awaiting = new Set(b.awaiting_approval.map(t => t.id))
    for (const t of b.all) assert.equal(awaiting.has(t.id), false)
    // actionable + awaiting === open tasks
    const open = rows.filter(t => t.status !== 'completed' && t.status !== 'cancelled')
    assert.equal(workload.all + b.awaiting_approval.length, open.length)
    // Self + Delegated === View All, for the same bucket
    assert.equal(workload.self + workload.delegated, workload.all)
    for (const type of ['all', 'self', 'delegated'] as const) {
      assert.equal(
        countTaskTypeWorkload(rows, ME)[type],
        buildMyTaskBuckets(filterByTaskType(rows, type, ME), CLOCK).all.length, type)
    }
  })
})
