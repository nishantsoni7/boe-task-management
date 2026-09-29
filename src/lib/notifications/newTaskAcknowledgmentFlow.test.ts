/**
 * A NEW TASK IS SILENT; ITS ACKNOWLEDGMENT IS NOT.
 *
 * Creating or assigning a task writes no notification to the assignee — the
 * task already waits in their acknowledgment section. Acknowledging it still
 * stamps `acknowledged_at`, moves it to Working, and notifies the creator.
 * See src/lib/notifications/taskNotificationPolicy.ts.
 *
 * Behaviour on the operation and the pure helpers; the acknowledgment wiring
 * pinned at the source level, the way the rest of the notification suite pins
 * /api/notify-status-update.
 *
 * Run:
 *   npx tsx --test src/lib/notifications/newTaskAcknowledgmentFlow.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createAssignmentNotification,
  type AssignmentNotificationStore,
  type AssignmentTaskRow,
} from '@/lib/tasks/assignmentNotificationWriter.server'
import { isUnacknowledged } from '@/lib/tasks/myTaskTabs'
import { shouldNotifyTaskStatusEvent } from './taskNotificationPolicy'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')

const CREATOR  = 'bbbbbbbb-0000-4000-8000-000000000001'
const ASSIGNEE = 'bbbbbbbb-0000-4000-8000-000000000002'
const TASK     = 'bbbbbbbb-0000-4000-8000-000000000003'

/** Records every store call, so "nothing written" also means "nothing read for it". */
function recordingStore(task: AssignmentTaskRow) {
  const calls: string[] = []
  const store: AssignmentNotificationStore = {
    fetchTask: async () => { calls.push('fetchTask'); return { task, error: null } },
    isAdmin: async () => { calls.push('isAdmin'); return false },
    hasAssignmentNotification: async () => { calls.push('hasAssignmentNotification'); return { exists: false, readable: true } },
    findCreationActivityId: async () => { calls.push('findCreationActivityId'); return null },
    insert: async () => { calls.push('insert'); return { error: null } },
  }
  return { store, calls }
}

describe('a newly assigned task', () => {
  const newTask = {
    id: TASK, title: 'Send the revised sample', task_type: 'general',
    created_by: CREATOR, assigned_to: ASSIGNEE,
  }

  test('writes no notification, and is reported as a success', async () => {
    const { store, calls } = recordingStore(newTask)
    const outcome = await createAssignmentNotification(store, { taskId: TASK, callerId: CREATOR })
    assert.deepEqual(outcome, { status: 'skipped_acknowledgment' })
    assert.equal(calls.includes('insert'), false, 'no row: nothing in the feed, the unread count or a push')
    assert.deepEqual(calls, ['fetchTask'], 'only the task is read; no duplicate check, no activity lookup')
  })

  test('still waits in the assignee\'s acknowledgment section', () => {
    // As every delegated creation screen inserts it: not acknowledged, pending.
    assert.equal(isUnacknowledged({ ...newTask, status: 'pending', acknowledged_at: null }), true)
  })

  test('a self-created task keeps its own rule — acknowledged at creation, nobody to tell', async () => {
    const own = { ...newTask, assigned_to: CREATOR }
    const { store, calls } = recordingStore(own)
    assert.deepEqual(await createAssignmentNotification(store, { taskId: TASK, callerId: CREATOR }), { status: 'skipped_self' })
    assert.equal(calls.includes('insert'), false)
    assert.equal(isUnacknowledged({ ...own, status: 'working', acknowledged_at: '2026-09-29T10:00:00.000Z' }), false)
  })
})

describe('the acknowledgment event', () => {
  const ACK_SCREENS = ['src/app/dashboard/page.tsx', 'src/app/tasks/my/page.tsx', 'src/app/tasks/[id]/page.tsx']

  test('acknowledging leaves the section: timestamp set, status Working', () => {
    const acknowledged = {
      created_by: CREATOR, assigned_to: ASSIGNEE,
      acknowledged_at: '2026-09-29T10:00:00.000Z', status: 'working' as const,
    }
    assert.equal(isUnacknowledged(acknowledged), false)
  })

  test('every acknowledge action still writes the timestamp and the Working transition', () => {
    for (const path of ACK_SCREENS) {
      const src = read(path)
      assert.match(src, /acknowledged_at: now,?\s*status: 'working'/, path)
      assert.ok(src.includes("action: 'acknowledged', note: null"), `${path} logs the acknowledgment`)
    }
  })

  test('and still notifies the creator through /api/notify-status-update', () => {
    for (const path of ACK_SCREENS) {
      const src = read(path)
      const ack = src.indexOf("action: 'acknowledged', note: null")
      const notify = src.indexOf("fetch('/api/notify-status-update'", ack)
      assert.ok(ack > 0 && notify > ack, path)
      assert.ok(src.slice(notify, notify + 400).includes('createdBy:'), `${path} addresses the creator`)
    }
  })

  test('as an acknowledgment, from every screen — never as "moved to Working"', () => {
    // The task detail page used to send `action: 'working'`, so the creator read
    // "<name> moved task to Working" where the other two screens say
    // "<name> acknowledged task".
    for (const path of ACK_SCREENS) {
      const src = read(path)
      const ack = src.indexOf("action: 'acknowledged', note: null")
      const notify = src.indexOf("fetch('/api/notify-status-update'", ack)
      const call = src.slice(notify, src.indexOf('})', notify))
      assert.match(call, /action: 'acknowledged'/, path)
      assert.equal(/action: 'working'/.test(call), false, path)
    }
  })

  test('the policy announces it, and every later event, on a delegated task', () => {
    const delegated = { task_type: 'general', created_by: CREATOR, assigned_to: ASSIGNEE }
    for (const action of ['acknowledged', 'working', 'comment_added', 'waiting', 'blocked']) {
      assert.equal(shouldNotifyTaskStatusEvent(delegated, action), true, action)
    }
  })

  test('the route still writes it, after the policy, through the shared funnel', () => {
    const src = read('src/app/api/notify-status-update/route.ts')
    const rule = src.indexOf('shouldNotifyTaskStatusEvent(task, action)')
    const insert = src.indexOf('insertUserNotifications(supabase')
    assert.ok(rule > 0 && insert > rule)
    assert.ok(src.includes("type:         'task_acknowledged'"))
    assert.ok(src.includes("return actor ? `${actor} acknowledged task` : 'Task acknowledged'"))
    // The new-task rule is not consulted here: it governs creation only.
    assert.equal(src.includes('shouldNotifyTaskAssignment'), false)
  })
})
