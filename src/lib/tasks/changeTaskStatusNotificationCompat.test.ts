/**
 * change_task_status() and the notification route: the facts the page switch-over will rely on.
 *
 * The page will call the function, keep /api/notify-status-update exactly as it is, and hand the route the
 * `activity_log_id` the function returns. This file proves, without changing either side, that those two fit:
 *
 *   · the id the function returns is accepted by the route's own check (the REAL verifyActivityBelongsToTask)
 *   · every status the function can produce has a headline in the route, and the notification policy treats it as
 *     it treats the same status today
 *   · the route's authorization (a party to the task, no admin exception) admits exactly the caller the function
 *     admits — the assignee — so no caller the function accepts is refused by the route
 *
 * Run:
 *   node node_modules/tsx/dist/cli.mjs --test src/lib/tasks/changeTaskStatusNotificationCompat.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyActivityBelongsToTask } from '@/lib/notifications/activityLink'
import { shouldNotifyTaskStatusEvent } from '@/lib/notifications/taskNotificationPolicy'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const MIGRATION = read('supabase/migrations/20270302000000_task_change_status_rpc.sql')
const ROUTE = read('src/app/api/notify-status-update/route.ts')

/** The statuses the function accepts, read from the migration itself. */
const RPC_STATUSES = (() => {
  const m = /p_status not in \(([^)]*)\)/.exec(MIGRATION)
  assert.ok(m, 'the status list is in the migration')
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1])
})()

/** A client that answers the two filters the route's check applies, over a fixed set of rows. */
function activityClient(rows: { id: string; task_id: string }[]) {
  return {
    from: (_t: 'task_activity_log') => {
      const filters: Record<string, string> = {}
      const q: Record<string, unknown> = {}
      q.select = () => q
      q.eq = (c: string, v: string) => { filters[c] = v; return q }
      q.limit = () => Promise.resolve({ data: rows.filter(r => r.id === filters.id && r.task_id === filters.task_id), error: null })
      return q
    },
  }
}

describe('the returned history id is accepted by the notification route', () => {
  const T = '7a5d0c1e-0000-4000-8000-000000000001', OTHER = '7a5d0c1e-0000-4000-8000-000000000002'
  const ROW = '9b2f0000-0000-4000-8000-0000000000aa'

  test('the function returns activity_log_id, the key the page already passes as activityLogId', () => {
    assert.ok(MIGRATION.includes("'activity_log_id',    v_log_id"))
    assert.ok(ROUTE.includes('activityLogId'))
  })

  test('an id that belongs to the task verifies; one that belongs to another task, or does not exist, does not', async () => {
    const client = activityClient([{ id: ROW, task_id: T }])
    assert.equal(await verifyActivityBelongsToTask(client, ROW, T), ROW)
    assert.equal(await verifyActivityBelongsToTask(client, ROW, OTHER), null, 'another task')
    assert.equal(await verifyActivityBelongsToTask(client, '9b2f0000-0000-4000-8000-0000000000bb', T), null, 'no such row')
  })
})

describe('every status the function can produce is announced exactly as it is today', () => {
  test('the function and the route speak the same status vocabulary', () => {
    assert.deepEqual([...RPC_STATUSES].sort(), ['blocked', 'completed', 'pending', 'started', 'waiting', 'working'])
    for (const status of RPC_STATUSES) {
      assert.ok(new RegExp(`case '${status}'`).test(ROUTE), `composeTitle has a headline for ${status}`)
    }
  })

  test('policy: ordinary tasks announce every status; a quotation announces none; a delegated completion is never announced', () => {
    const ordinary = { created_by: 'a', assigned_to: 'a', task_type: 'general' }
    const delegated = { created_by: 'a', assigned_to: 'b', task_type: 'general' }
    const quotation = { created_by: 'a', assigned_to: 'b', task_type: 'quotation_request' }
    for (const s of RPC_STATUSES) {
      assert.equal(shouldNotifyTaskStatusEvent(quotation, s), false, `quotation ${s}`)
      if (s !== 'completed') assert.equal(shouldNotifyTaskStatusEvent(delegated, s), true, `delegated ${s}`)
    }
    // The function refuses a delegated completion outright, so the policy's "not announced" is never reached by it.
    assert.equal(shouldNotifyTaskStatusEvent(delegated, 'completed'), false)
    assert.ok(/v_delegated and p_status = 'completed'/.test(MIGRATION))
    // A self task: the caller is also the recipient, which the route skips rather than announces.
    assert.ok(ROUTE.includes('if (notifyUserId === user.id)'))
    assert.equal(shouldNotifyTaskStatusEvent(ordinary, 'completed'), true)
  })
})

describe('the route admits every caller the function admits', () => {
  test('the route requires the caller to be the creator or the assignee — with no admin exception', () => {
    assert.ok(ROUTE.includes('user.id === task.created_by || user.id === task.assigned_to'))
    assert.equal(/role\s*===\s*'admin'/.test(ROUTE.slice(0, ROUTE.indexOf('const callerIsParticipant'))), false)
  })

  test('the function admits only the assignee, who is a party to the task and therefore passes the route', () => {
    assert.ok(MIGRATION.includes('if v_uid is distinct from v_task.assigned_to then'))
  })

  test('the recipient the page names is read from the stored task by the route, so the function adds no way to name one', () => {
    assert.ok(ROUTE.includes('notifyUserId !== task.created_by && notifyUserId !== task.assigned_to'))
    assert.equal(/\bp_(recipient|notify)/i.test(MIGRATION), false, 'the function takes no recipient')
  })
})

describe('the route is not idempotent — so the page, not the route, must prevent a second notice', () => {
  test('nothing in the route de-duplicates by activity row (documented here so the switch-over does not assume it)', () => {
    assert.equal(/onConflict|upsert|already notified|duplicate/i.test(ROUTE), false)
  })
})
