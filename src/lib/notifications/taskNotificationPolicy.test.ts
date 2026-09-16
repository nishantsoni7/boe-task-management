/**
 * Quotation requests and approvals are not announced; submit, return, reopen
 * and every other task event still are — at the point a row would be CREATED.
 * (Hiding rows written before the rule: taskFeedExclusion.test.ts.)
 *
 * Behaviour is tested on the pure predicates and on the assignment operation
 * against a fake store. The wiring into routes and the migration is pinned at
 * the source level, the way the rest of the notification suite pins it.
 *
 * Run:
 *   npx tsx --test src/lib/notifications/taskNotificationPolicy.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  APPROVAL_NOTIFICATION_TITLE_PATTERN, QUOTATION_TASK_TYPE, isQuotationTask, shouldNotifyTaskStatusEvent,
} from './taskNotificationPolicy'
import { TASK_REVIEW_NOTIFICATION_SUFFIXES } from '@/lib/tasks/reviewTransitions'
import { createAssignmentNotification, type AssignmentNotificationStore, type AssignmentTaskRow } from '@/lib/tasks/assignmentNotificationWriter.server'
import type { NotificationInsert } from '@/lib/notificationWrites'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')

const CREATOR  = 'aaaaaaaa-0000-4000-8000-000000000001'
const ASSIGNEE = 'aaaaaaaa-0000-4000-8000-000000000002'
const STRANGER = 'aaaaaaaa-0000-4000-8000-000000000003'

// ── 1. Quotation requests are recognised by their column ────────────────────

describe('isQuotationTask', () => {
  test('a quotation_request task is a quotation', () => {
    assert.equal(isQuotationTask({ task_type: 'quotation_request' }), true)
    assert.equal(QUOTATION_TASK_TYPE, 'quotation_request')
  })

  test('a general task is not, whatever it is called', () => {
    assert.equal(isQuotationTask({ task_type: 'general' }), false)
    // The title is not an input at all: a general task named like a quotation
    // is still a general task.
    assert.equal(isQuotationTask({ task_type: 'general', title: 'Quotation - Acme' } as { task_type: string }), false)
    assert.equal(isQuotationTask({ task_type: null }), false)
    assert.equal(isQuotationTask(null), false)
  })
})

// ── 2. Generic status events ────────────────────────────────────────────────

const delegated = { task_type: 'general', created_by: CREATOR, assigned_to: ASSIGNEE }
const selfTask  = { task_type: 'general', created_by: CREATOR, assigned_to: CREATOR }
const quotation = { task_type: 'quotation_request', created_by: CREATOR, assigned_to: ASSIGNEE }

describe('shouldNotifyTaskStatusEvent', () => {
  test('a quotation writes nothing, for any event', () => {
    for (const action of ['comment_added', 'completed', 'working', 'waiting', 'acknowledged', 'cancelled']) {
      assert.equal(shouldNotifyTaskStatusEvent(quotation, action), false, action)
    }
  })

  test('a delegated task "completed" is the approval by another road — not announced', () => {
    assert.equal(shouldNotifyTaskStatusEvent(delegated, 'completed'), false)
  })

  test('every other event on a delegated task is still announced', () => {
    for (const action of ['acknowledged', 'comment_added', 'working', 'waiting', 'blocked', 'started', 'pending', 'cancelled']) {
      assert.equal(shouldNotifyTaskStatusEvent(delegated, action), true, action)
    }
  })

  test('a self task is not affected by the approval rule (the self-notify rule handles it)', () => {
    assert.equal(shouldNotifyTaskStatusEvent(selfTask, 'completed'), true)
  })
})

// ── 3. The approval row, and only it ────────────────────────────────────────

/** PostgREST `like` with `*` as the wildcard, as the database evaluates it. */
const like = (pattern: string, value: string) =>
  new RegExp(`^${pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(value)

describe('APPROVAL_NOTIFICATION_TITLE_PATTERN', () => {
  test('matches the title transition_task_review() writes on approve', () => {
    assert.equal(like(APPROVAL_NOTIFICATION_TITLE_PATTERN, `Nishant Soni ${TASK_REVIEW_NOTIFICATION_SUFFIXES.approve}`), true)
    assert.equal(like(APPROVAL_NOTIFICATION_TITLE_PATTERN, `Someone ${TASK_REVIEW_NOTIFICATION_SUFFIXES.approve}`), true)
  })

  test('matches no title that must stay visible', () => {
    for (const title of [
      `Priya ${TASK_REVIEW_NOTIFICATION_SUFFIXES.submit}`,
      `Nishant ${TASK_REVIEW_NOTIFICATION_SUFFIXES.return}`,
      'Nishant reopened a task', 'Task reopened', 'Nishant cancelled a task',
      'Priya completed task', 'Priya acknowledged task', 'Priya added a comment',
      'Priya moved task to Waiting', 'New task assigned to you', 'Task status updated',
    ]) {
      assert.equal(like(APPROVAL_NOTIFICATION_TITLE_PATTERN, title), false, title)
    }
  })
})

// ── 4. Assignment: a quotation request is created without a notification ────

function fakeStore(task: AssignmentTaskRow, { admin = false } = {}) {
  const inserted: NotificationInsert[] = []
  const store: AssignmentNotificationStore = {
    fetchTask: async () => ({ task, error: null }),
    isAdmin: async () => admin,
    hasAssignmentNotification: async () => ({ exists: false, readable: true }),
    findCreationActivityId: async () => null,
    insert: async rows => { inserted.push(...rows); return { error: null } },
  }
  return { store, inserted }
}

describe('createAssignmentNotification and quotation requests', () => {
  const base = { id: 'task-q', title: 'Quotation - Acme', created_by: CREATOR, assigned_to: ASSIGNEE }

  test('a quotation request writes no notification', async () => {
    const { store, inserted } = fakeStore({ ...base, task_type: 'quotation_request' })
    assert.deepEqual(await createAssignmentNotification(store, { taskId: 'task-q', callerId: CREATOR }), { status: 'skipped_quotation' })
    assert.equal(inserted.length, 0)
  })

  test('a stranger is still refused before the quotation rule is consulted', async () => {
    const { store } = fakeStore({ ...base, task_type: 'quotation_request' })
    assert.deepEqual(await createAssignmentNotification(store, { taskId: 'task-q', callerId: STRANGER }), { status: 'forbidden' })
  })

  test('an ordinary delegated task still notifies its assignee', async () => {
    const { store, inserted } = fakeStore({ ...base, id: 'task-g', title: 'Ship samples', task_type: 'general' })
    assert.deepEqual(await createAssignmentNotification(store, { taskId: 'task-g', callerId: CREATOR }), { status: 'created' })
    assert.equal(inserted.length, 1)
    assert.equal(inserted[0].user_id, ASSIGNEE)
  })
})

// ── 5. Wiring ───────────────────────────────────────────────────────────────

describe('every Task Management writer consults the rule', () => {
  test('/api/notify-status-update reads task_type and asks after both party checks', () => {
    const src = read('src/app/api/notify-status-update/route.ts')
    assert.match(src, /select\('created_by, assigned_to, title, task_type'\)/)
    const recipientCheck = src.indexOf("'Invalid recipient'")
    const rule = src.indexOf('shouldNotifyTaskStatusEvent(task, action)')
    const insert = src.indexOf('insertUserNotifications(supabase')
    assert.ok(recipientCheck > 0 && rule > recipientCheck && insert > rule)
  })

  test('/api/restore-task and /api/cancel-task skip a quotation request, by task_type', () => {
    for (const p of ['src/app/api/restore-task/route.ts', 'src/app/api/cancel-task/route.ts']) {
      const src = read(p)
      assert.match(src, /select\('id, title, status, assigned_to, created_by, task_type'\)/, p)
      assert.match(src, /!isQuotationTask\(task\)\) \{/, p)
    }
  })

  test('the assignment writer reads task_type and skips after authorization', () => {
    const src = read('src/lib/tasks/assignmentNotificationWriter.server.ts')
    assert.match(src, /select\('id, title, assigned_to, created_by, task_type'\)/)
    const forbidden = src.indexOf("return { status: 'forbidden' }")
    const skip = src.indexOf("return { status: 'skipped_quotation' }")
    assert.ok(forbidden > 0 && skip > forbidden)
    // The browser treats the skip as success, so no "notification failed" warning.
    assert.match(read('src/lib/tasks/assignmentNotification.ts'), /status === 'skipped_quotation'\) \{/)
  })
})

describe('20261212000000 stops the approval notification and changes nothing else', () => {
  const MIGRATION = 'supabase/migrations/20261212000000_task_review_approval_stops_notifying.sql'
  const PREVIOUS  = 'supabase/migrations/20261016000000_notifications_link_activity_log.sql'
  const next = read(MIGRATION)

  /** The function definition, comments and layout removed. */
  const body = (sql: string) => {
    const start = sql.indexOf('create or replace function public.transition_task_review(')
    const end = sql.indexOf('$$;', start)
    return sql.slice(start, end)
      .split('\n').map(l => l.replace(/--.*$/, '')).join(' ')
      .replace(/\s+/g, ' ').trim()
  }

  test('the body is the previous body with exactly one condition added', () => {
    const expected = body(read(PREVIOUS)).replace(
      'if v_recipient is not null and v_recipient <> v_uid then',
      "if p_action <> 'approve' and v_recipient is not null and v_recipient <> v_uid then",
    )
    assert.equal(body(next), expected)
  })

  test('submit and return still notify; the activity row is still written', () => {
    assert.match(next, /v_title\s+:= v_actor_name \|\| ' submitted task for approval'/)
    assert.match(next, /v_title\s+:= v_actor_name \|\| ' returned task to Working'/)
    assert.match(next, /insert into public\.task_activity_log \(task_id, actor_id, action, from_status, to_status, note\)/)
  })

  test('guarded, transaction-compatible, and deletes nothing', () => {
    assert.match(next, /TRANSITION_TASK_REVIEW_DRIFTED/)
    assert.doesNotMatch(next, /^\s*(begin|commit)\s*;/im)
    assert.doesNotMatch(next, /delete\s+from\s+(public\.)?notifications/i)
    assert.match(next, /grant execute on function public\.transition_task_review\(uuid, text, text\) to authenticated;/)
  })
})
