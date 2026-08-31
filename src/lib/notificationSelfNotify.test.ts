/**
 * "Do not tell me what I just did."
 *
 * A person commenting, changing a status, submitting for approval, cancelling
 * or reopening a task is already looking at the screen where it happened. A
 * notification addressed back to them is noise, and it buries the ones that
 * came from somebody else.
 *
 * Two layers are asserted here:
 *
 *   1. THE FUNNEL. insertUserNotifications drops any row whose recipient is the
 *      supplied actor, so a caller that forgets its own check still cannot
 *      produce one.
 *   2. THE CALLERS. Every Task Management write path — the three routes, the
 *      assignment writer, the browser call sites and the review RPC — passes an
 *      actor or refuses the write itself.
 *
 * Run:
 *   npx tsx --test src/lib/notificationSelfNotify.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  insertUserNotifications,
  type NotificationInsert,
  type NotificationInsertClient,
} from './notificationWrites'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

function recordingClient() {
  const calls: NotificationInsert[][] = []
  const client: NotificationInsertClient = {
    from: () => ({
      insert: async (rows: NotificationInsert[]) => { calls.push(rows); return { error: null } },
    }),
  }
  return { client, calls }
}

const row = (userId: string): NotificationInsert => ({
  user_id: userId, task_id: 't1', type: 'task_acknowledged',
  title: 'Nishant added a comment', body: 'Task title', is_push_sent: true,
})

// ── 1. The funnel ────────────────────────────────────────────────────────────

describe('insertUserNotifications drops rows addressed to the actor', () => {
  test('my own comment notifies nobody, and touches no table', async () => {
    const { client, calls } = recordingClient()
    const result = await insertUserNotifications(client, row('me'), { actorId: 'me' })
    assert.equal(result.inserted, 0)
    assert.equal(result.selfSuppressed, 1)
    assert.equal(result.error, null, 'a skip is a success, never an error')
    assert.equal(calls.length, 0, 'the database was not touched at all')
  })

  test('the same event caused by somebody else is written', async () => {
    const { client, calls } = recordingClient()
    const result = await insertUserNotifications(client, row('me'), { actorId: 'colleague' })
    assert.equal(result.inserted, 1)
    assert.equal(result.selfSuppressed, 0)
    assert.equal(calls[0][0].user_id, 'me')
  })

  test('a batch keeps everybody else and drops only the actor', async () => {
    const { client, calls } = recordingClient()
    const result = await insertUserNotifications(
      client, [row('me'), row('colleague'), row('manager')], { actorId: 'me' })
    assert.equal(result.inserted, 2)
    assert.equal(result.selfSuppressed, 1)
    assert.deepEqual(calls[0].map(r => r.user_id), ['colleague', 'manager'])
  })

  test('no actor supplied changes nothing — a system-initiated write still lands', async () => {
    const { client, calls } = recordingClient()
    const result = await insertUserNotifications(client, row('me'))
    assert.equal(result.inserted, 1)
    assert.equal(result.selfSuppressed, 0)
    assert.equal(calls.length, 1)
  })

  test('an empty actor string is not an identity and matches nobody', async () => {
    const { client } = recordingClient()
    for (const actorId of ['', null, undefined]) {
      const result = await insertUserNotifications(client, row('me'), { actorId })
      assert.equal(result.inserted, 1, `actorId ${JSON.stringify(actorId)} must not suppress`)
    }
  })
})

// ── 2. The callers ───────────────────────────────────────────────────────────

describe('every task write path names its actor', () => {
  for (const path of [
    'src/app/api/notify-status-update/route.ts',
    'src/app/api/cancel-task/route.ts',
    'src/app/api/restore-task/route.ts',
  ]) {
    test(`${path} passes the signed-in user as the actor`, () => {
      assert.ok(read(path).includes('{ actorId: user.id }'), 'actorId reaches the guard')
    })
  }

  test('the assignment writer passes the creator, not the caller', () => {
    const src = read('src/lib/tasks/assignmentNotificationWriter.server.ts')
    assert.ok(src.includes('{ actorId: task.created_by }'),
      'an admin acting for a creator must not stop the assignee being told')
  })

  test('the review RPC refuses to notify the actor in SQL', () => {
    const sql = read('supabase/migrations/20261016000000_notifications_link_activity_log.sql')
    assert.ok(sql.includes('v_recipient <> v_uid'),
      'submit / approve / return write only to the other party')
  })

  test('the browser call sites still refuse before the request is even made', () => {
    // Cheapest possible layer: no round trip at all for an event about yourself.
    for (const path of [
      'src/app/tasks/[id]/page.tsx',
      'src/app/tasks/my/page.tsx',
      'src/app/dashboard/page.tsx',
    ]) {
      const src = read(path)
      assert.ok(/!==\s*(currentUserId|userId)\b/.test(src),
        `${path}: a self-addressed notification is not requested`)
    }
  })
})
